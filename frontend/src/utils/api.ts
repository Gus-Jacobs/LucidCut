// Centralized backend access. Works in both the Vite web dev server and the
// packaged Electron app (which injects window.electron.getBackendUrl()).

let cachedBase: string | null = null

export function getApiBase(): string {
  if (cachedBase) return cachedBase
  const w = window as any
  if (w.__LUCIDCUT_BACKEND__) {
    cachedBase = w.__LUCIDCUT_BACKEND__ as string
  } else if (import.meta.env?.VITE_BACKEND_URL) {
    cachedBase = import.meta.env.VITE_BACKEND_URL as string
  } else {
    cachedBase = 'http://localhost:4000'
  }
  return cachedBase
}

// Resolve the Electron-provided backend URL once at startup, if present.
export async function initApiBase(): Promise<void> {
  const w = window as any
  if (w.electron?.getBackendUrl) {
    try {
      const url = await w.electron.getBackendUrl()
      if (url) { w.__LUCIDCUT_BACKEND__ = url; cachedBase = url }
    } catch {
      /* fall back to default */
    }
  }
}

export function apiUrl(path: string): string {
  return `${getApiBase()}${path.startsWith('/') ? path : `/${path}`}`
}

export function isElectronApp(): boolean {
  return typeof window !== 'undefined' && !!(window as any).electron
}
