import * as Electron from 'electron';
import * as path from 'path';
import { fork, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';

const { app, BrowserWindow, Menu, ipcMain } = Electron;

// CRITICAL FIX 1: Use app.isPackaged to reliably detect development mode
const isDev = !app.isPackaged;

let mainWindow: InstanceType<typeof BrowserWindow> | null = null;
let backendProcess: ChildProcess | null = null;
const BACKEND_PORT = 4000;

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

    backendProcess = fork(backendPath, [], {
      env: {
        ...process.env,
        NODE_ENV: isDev ? 'development' : 'production',
        PORT: BACKEND_PORT.toString()
      },
      stdio: 'inherit' 
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
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 768,
    webPreferences: {
      nodeIntegration: true, 
      contextIsolation: false 
    },
    icon: isDev ? undefined : path.join(process.resourcesPath, 'assets/icon.png')
  });

  if (isDev) {
    const port = await detectVitePort();
    mainWindow.loadURL(`http://localhost:${port}`);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: any[] = [
    { label: 'File', submenu: [ isMac ? { role: 'close' } : { role: 'quit' } ] },
    { label: 'Edit', submenu: [ { role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' } ] },
    { label: 'View', submenu: [ { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' } ] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on('ready', async () => {
  try {
    await startBackend();
    await createWindow();
    createMenu();
  } catch (err) {
    console.error('[Electron] Failed to start app:', err);
    if (!isDev) app.quit();
  }
});

app.on('window-all-closed', () => {
  if (backendProcess) {
    backendProcess.kill();
    backendProcess = null;
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

process.on('exit', () => {
  if (backendProcess) backendProcess.kill();
});