import * as Electron from 'electron';
import * as path from 'path';
import { fork, execFile, execFileSync, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';

const { app, BrowserWindow, Menu, ipcMain, powerSaveBlocker, dialog, shell } = Electron;

app.setName('LucidCut');
// Without this, Windows toast notifications (and taskbar grouping) fall back to
// a generic/default identity instead of showing "LucidCut" — must match the
// AUMID the NSIS installer registers, which electron-builder derives from appId.
if (process.platform === 'win32') app.setAppUserModelId('com.pegumax.lucidcut');

// Auto-update: in production, check the release feed, download in the background,
// and offer to restart when ready. Uses electron-updater (configured via the
// "publish" field in package.json). Guarded so a missing dep never breaks startup.
function setupAutoUpdate(): void {
  if (!app.isPackaged) return; // only meaningful for installed builds
  let autoUpdater: any;
  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch {
    console.log('[updater] electron-updater not installed; skipping auto-update');
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  // Deliberately just ONE user-facing prompt in this whole flow (the dialog
  // below) — the taskbar progress bar is the only other signal. Multiple
  // toasts stacking up on top of that dialog was confusing, not helpful.
  autoUpdater.on('update-available', (info: any) => {
    console.log(`[updater] update available: ${info?.version}`);
    if (mainWindow) mainWindow.setProgressBar(0)
  });
  autoUpdater.on('update-not-available', () => console.log('[updater] up to date'));
  autoUpdater.on('error', (err: any) => {
    console.error('[updater]', err?.message || err)
    if (mainWindow) mainWindow.setProgressBar(-1)
  });
  autoUpdater.on('download-progress', (p: any) => {
    if (mainWindow) mainWindow.setProgressBar((p?.percent || 0) / 100)
  });
  autoUpdater.on('update-downloaded', async (info: any) => {
    if (mainWindow) mainWindow.setProgressBar(-1)
    try {
      const r = await dialog.showMessageBox({
        type: 'info',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        title: 'Update ready',
        message: `LucidCut ${info?.version || ''} has been downloaded.`,
        detail: 'Restart now to finish updating, or it will install automatically when you next close the app.',
      });
      if (r.response === 0) autoUpdater.quitAndInstall();
    } catch (e) { /* will still install on quit */ }
  });
  // fires right before the app quits to run the installer, whether triggered by
  // quitAndInstall() above or by autoInstallOnAppQuit closing the app normally.
  // Without this, an orphaned ffmpeg/worker process can still be holding a
  // lock on a file the installer needs to overwrite, corrupting the update.
  autoUpdater.on('before-quit-for-update', async () => {
    await killBackendTree()
  });
  // (not checkForUpdatesAndNotify) — that variant fires its own extra native
  // notification we don't control the copy/branding of, on top of ours above.
  autoUpdater.checkForUpdates().catch((e: any) => console.error('[updater]', e?.message || e));
}

// Prevent the system from sleeping/suspending during long parses.
let powerBlockerId = -1;
ipcMain.handle('lc-keep-awake', (_e, on: boolean) => {
  try {
    if (on) {
      if (powerBlockerId === -1 || !powerSaveBlocker.isStarted(powerBlockerId)) {
        powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
      }
    } else if (powerBlockerId !== -1 && powerSaveBlocker.isStarted(powerBlockerId)) {
      powerSaveBlocker.stop(powerBlockerId);
      powerBlockerId = -1;
    }
  } catch (e) { /* non-fatal */ }
  return true;
});

// CRITICAL FIX 1: Use app.isPackaged to reliably detect development mode
const isDev = !app.isPackaged;

let mainWindow: InstanceType<typeof BrowserWindow> | null = null;
let backendProcess: ChildProcess | null = null;
const BACKEND_PORT = 4000;

// backendProcess.kill() only signals the direct child — it does NOT touch the
// ffmpeg/ffprobe/worker processes that server.js spawns underneath it, which
// then linger and hold file locks. That silently breaks the auto-updater's
// quit-time install (Windows can't overwrite a locked ffmpeg.exe/worker.exe),
// so the whole tree needs to go down before we let anything quit or update.
function killBackendTree(): Promise<void> {
  return new Promise((resolve) => {
    const proc = backendProcess
    backendProcess = null
    if (!proc || !proc.pid) return resolve()
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(proc.pid), '/t', '/f'], () => resolve())
    } else {
      try { process.kill(-proc.pid, 'SIGKILL') } catch { try { proc.kill('SIGKILL') } catch { /* already gone */ } }
      resolve()
    }
  })
}

// Detect which port Vite is running on
async function detectVitePort(): Promise<number> {
  for (let port = 5173; port <= 5180; port++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.get(`http://localhost:${port}`, { timeout: 500 }, (res) => {
          if (res.statusCode && res.statusCode < 500) resolve();
          else reject();
        });
        req.on('error', reject);
        req.on('timeout', () => { req.abort(); reject(); });
      });
      console.log(`[Electron] Found Vite on port ${port}`);
      return port;
    } catch {
      continue;
    }
  }
  console.log('[Electron] Could not detect Vite port, using default 5173');
  return 5173;
}

// CRITICAL FIX 2: Navigate UP from frontend and DOWN into backend during development
// app.getAppPath() points to your /CODE/frontend/ folder in dev
const backendPath = isDev 
  ? path.join(app.getAppPath(), '../backend/server.js')
  : path.join(process.resourcesPath, 'backend/server.js');

// Start Express backend server
function startBackend(): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`[Electron] Attempting to start backend at: ${backendPath}`);
    
    if (!fs.existsSync(backendPath)) {
      console.error(`[Electron CRITICAL] Cannot find server.js at: ${backendPath}`);
      return reject(new Error('Backend file missing'));
    }

    // bundled binaries live in resources/ in a packaged build
    const res = process.resourcesPath;
    const exe = process.platform === 'win32' ? '.exe' : '';
    const packagedEnv = isDev ? {} : {
      LUCIDCUT_WORKER_EXE: path.join(res, 'lucidcut-worker', `lucidcut-worker${exe}`),
      LUCIDCUT_FFMPEG: path.join(res, 'bin', `ffmpeg${exe}`),
      LUCIDCUT_FFPROBE: path.join(res, 'bin', `ffprobe${exe}`),
    };

    backendProcess = fork(backendPath, [], {
      env: {
        ...process.env,
        NODE_ENV: isDev ? 'development' : 'production',
        PORT: BACKEND_PORT.toString(),
        // persistent, update-safe location for training data + personalized models
        LUCIDCUT_DATA_DIR: path.join(app.getPath('userData'), 'lucidcut-data'),
        ...packagedEnv,
      },
      stdio: 'inherit',
      // lets killBackendTree() reach ffmpeg/worker grandchildren via process
      // group kill on mac/Linux; Windows cleanup instead uses taskkill /t
      detached: process.platform !== 'win32',
    });

    backendProcess.on('error', (err) => {
      console.error('[Electron] Backend failed to spawn:', err);
      reject(err);
    });

    backendProcess.on('exit', (code) => {
      console.log(`[Electron] Backend process exited with code ${code}`);
    });

    setTimeout(() => {
      console.log(`[Electron] Backend should be running on port ${BACKEND_PORT}`);
      resolve();
    }, 2000);
  });
}

// Create browser window
async function createWindow(): Promise<void> {
  const iconPath = isDev
    ? path.join(app.getAppPath(), 'assets/logo.png')
    : path.join(process.resourcesPath, 'assets/logo.png');

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 768,
    title: 'LucidCut',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    icon: iconPath
  });

  if (isDev) {
    const port = await detectVitePort();
    mainWindow.loadURL(`http://localhost:${port}`);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  // Open external links (target="_blank", e.g. the Software Center & Stripe donate
  // link) in the user's real browser instead of a blank Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Also catch same-window navigations to external sites.
  mainWindow.webContents.on('will-navigate', (e, url) => {
    const isLocal = url.startsWith('http://localhost') || url.startsWith('file://');
    if (!isLocal && /^https?:\/\//i.test(url)) { e.preventDefault(); shell.openExternal(url); }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: any[] = [
    { label: 'File', submenu: [ isMac ? { role: 'close' } : { role: 'quit' } ] },
    { label: 'Edit', submenu: [ { role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' } ] },
    { label: 'View', submenu: [ { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' } ] },
    { label: 'Help', submenu: [
      { label: 'Open Logs Folder', click: () => { shell.openPath(path.join(app.getPath('userData'), 'lucidcut-data', 'logs')); } },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on('ready', async () => {
  try {
    await startBackend();
    await createWindow();
    createMenu();
    setupAutoUpdate();
  } catch (err) {
    console.error('[Electron] Failed to start app:', err);
    if (!isDev) app.quit();
  }
});

app.on('window-all-closed', () => {
  killBackendTree().finally(() => {
    if (process.platform !== 'darwin') app.quit();
  });
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

// last-resort synchronous backstop for exit paths that skip window-all-closed
// (e.g. a crash) — 'exit' can't await, so this only covers the direct child.
process.on('exit', () => {
  if (!backendProcess || !backendProcess.pid) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(backendProcess.pid), '/t', '/f']);
    else backendProcess.kill('SIGKILL');
  } catch { /* already gone */ }
});