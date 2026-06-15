# Video Censor Editor - Electron App Setup

This project has been converted to a standalone Electron desktop application that runs entirely locally without needing an external server.

## Prerequisites

- Node.js 16+ and npm
- Python 3.9+ (for the video processing worker)
- FFmpeg (optional, but recommended for video processing)

## Development Setup

### 1. Install Backend Dependencies

```bash
cd backend
npm install
```

### 2. Install Frontend Dependencies

```bash
cd frontend
npm install
```

### 3. Run in Development Mode

From the frontend directory, run:

```bash
npm run dev
```

This will:
- Start the Vite development server on `http://localhost:5173`
- Start the Express backend server internally
- Open the Electron window automatically

## Building for Production

### Building the Desktop App

From the frontend directory:

```bash
npm run build
```

This builds:
- The React frontend (optimized)
- Compiles TypeScript for Electron main/preload processes
- Bundles everything for distribution

### Packaging for Distribution

#### macOS
```bash
npm run package:mac
```
Creates: `dist/Video Censor Editor-x.x.x.dmg`

#### Windows
```bash
npm run package:win
```
Creates: `dist/Video Censor Editor Setup x.x.x.exe`

#### Linux
```bash
npm run package:linux
```
Creates: `dist/Video Censor Editor-x.x.x.AppImage`

#### All Platforms
```bash
npm run package
```

## Architecture

### File Structure
```
frontend/
├── electron/
│   ├── main.ts           # Electron main process (manages backend, window)
│   └── preload.ts        # Secure bridge between main and renderer
├── src/
│   ├── components/       # React components
│   └── utils/
│       └── backend.ts    # Backend URL utility for Electron
├── vite.config.ts        # Vite build configuration
└── package.json          # Scripts and dependencies

backend/
├── server.js             # Express API server
├── worker/
│   └── process_video.py  # Python video processing with Whisper
└── uploads/              # Temporary upload directory
```

### How It Works

1. **Electron Main Process** (`electron/main.ts`):
   - Starts the Express backend server as a child process
   - Creates the BrowserWindow
   - Handles IPC communication between backend and frontend

2. **Backend Server** (`backend/server.js`):
   - Runs on `http://localhost:4000` internally
   - Handles video uploads, processing, and exports
   - NOT exposed externally

3. **Frontend** (React in Electron renderer):
   - Communicates with backend via internal HTTP calls
   - Uses `getBackendUrl()` utility to get the correct endpoint
   - All processing happens locally on user's machine

## Configuration

### Electron Main Process

The main process is configured in `electron/main.ts`:
- **Backend Port**: 4000 (internal only)
- **Frontend Port**: 5173 (dev) or bundled (production)
- **App Window**: 1400x900 minimum, resizable

### Backend Settings

Port can be configured via environment variable:
```bash
BACKEND_PORT=4000 npm run dev
```

## Troubleshooting

### Backend Won't Start
- Check that port 4000 is not in use
- Ensure Node.js and npm are properly installed
- Look at console output in the Electron app

### Build Fails
- Clear node_modules: `cd frontend && rm -rf node_modules && npm install`
- Clear Vite cache: `rm -rf frontend/dist frontend/.vite`
- Ensure TypeScript compiles: `npx tsc --noEmit`

### Python Worker Issues
- Ensure Python 3.9+ is installed
- Install Whisper: `pip install openai-whisper`
- Check backend logs for detailed errors

## Deployment

The packaged Electron app is ready for distribution:
- **macOS**: Drag Video Censor Editor.app to Applications, or install from DMG
- **Windows**: Run the installer exe or use the portable exe
- **Linux**: Run the AppImage file

All dependencies are bundled within the app package.

## Security Notes

- The backend is NOT exposed to the network - it only listens locally
- IPC communication uses Electron's secure `contextIsolation`
- All file operations are sandboxed to the app's directories
- No data leaves the user's machine

## First Time Setup

When users first run the app:
1. The backend starts automatically in the background
2. The app waits for backend to be ready (2-3 seconds)
3. The UI loads and becomes interactive
4. When closed, the backend process is terminated

Users don't need to configure anything - it just works!
