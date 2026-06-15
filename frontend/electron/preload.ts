import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electron', {
  getBackendUrl: () => ipcRenderer.invoke('get-backend-url'),
  checkBackendReady: () => ipcRenderer.invoke('check-backend-ready'),
  isDev: process.env.NODE_ENV === 'development'
});

declare global {
  interface Window {
    electron: {
      getBackendUrl: () => Promise<string>;
      checkBackendReady: () => Promise<boolean>;
      isDev: boolean;
    };
  }
}
