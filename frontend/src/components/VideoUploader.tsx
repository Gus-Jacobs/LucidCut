import { useRef, useState, useEffect } from 'react'
import SettingsPanel, { type ImageryConfig } from './SettingsPanel'
import { apiUrl } from '../utils/api'
import './VideoUploader.css'

const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024 // 2GB
const ACCEPTED = /\.(mp4|mov|mkv|webm|avi|m4v)$/i

const DEFAULT_IMAGERY: ImageryConfig = {
  enabled: false,
  regionDetection: true,
  sensitivity: 50,
  categories: { explicit: true, revealing: false, suggestive: false },
}

function loadJSON<T>(key: string, fallback: T): T {
  try {
    const saved = localStorage.getItem(key)
    return saved !== null ? JSON.parse(saved) : fallback
  } catch {
    return fallback
  }
}

export default function VideoUploader({ onNavigate }: { onNavigate?: (screen: string, payload?: any) => void }) {
  const [detectSwears, setDetectSwears] = useState<boolean>(() => loadJSON('lc_detectSwears', true))
  const [swearList, setSwearList] = useState<string[]>(() => loadJSON('lc_swearList', ['damn', 'hell', 'shit', 'fuck', 'ass', 'bitch']))
  const [sensitivity, setSensitivity] = useState<number>(() => loadJSON('lc_sensitivity', 65))
  const [imagery, setImagery] = useState<ImageryConfig>(() => {
    // migrate from any older persisted shape
    const saved = loadJSON<any>('lc_imageryConfig', null)
    return saved && typeof saved.enabled === 'boolean' ? { ...DEFAULT_IMAGERY, ...saved } : DEFAULT_IMAGERY
  })

  useEffect(() => { localStorage.setItem('lc_detectSwears', JSON.stringify(detectSwears)) }, [detectSwears])
  useEffect(() => { localStorage.setItem('lc_swearList', JSON.stringify(swearList)) }, [swearList])
  useEffect(() => { localStorage.setItem('lc_sensitivity', JSON.stringify(sensitivity)) }, [sensitivity])
  useEffect(() => { localStorage.setItem('lc_imageryConfig', JSON.stringify(imagery)) }, [imagery])

  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  function validateAndSet(f: File | null) {
    setError(null)
    if (!f) { setFile(null); setPreviewUrl(null); return }
    if (!f.type.startsWith('video/') && !ACCEPTED.test(f.name)) {
      setError('Unsupported file. Please choose an MP4, MOV, MKV, WEBM, AVI, or M4V video.')
      return
    }
    if (f.size > MAX_VIDEO_BYTES) {
      setError(`File is too large (${(f.size / 1e9).toFixed(1)}GB). Maximum is 2GB.`)
      return
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setFile(f)
    setPreviewUrl(URL.createObjectURL(f))
  }

  function clearFile() {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setFile(null); setPreviewUrl(null); setError(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  async function submit(e?: any) {
    if (e) e.preventDefault()
    if (!file || submitting) return
    if (!detectSwears && !imagery.enabled) {
      setError('Enable at least one detection type (words or visual) before parsing.')
      return
    }

    const config = {
      detectSwears,
      swearList,
      sensitivity,
      imageryDetection: imagery,
    }

    const fd = new FormData()
    fd.append('video', file)
    fd.append('impurityDetection', JSON.stringify(config))

    setSubmitting(true)
    setError(null)
    try {
      const resp = await fetch(apiUrl('/api/upload'), { method: 'POST', body: fd, mode: 'cors' })
      const text = await resp.text()
      let json: any
      try { json = JSON.parse(text) } catch { throw new Error(`Invalid server response: ${text.slice(0, 200)}`) }

      if (resp.ok && json.jobId) {
        onNavigate?.('parsing', { jobId: json.jobId, file, previewUrl })
      } else {
        throw new Error(json.error || `Upload failed (${resp.status})`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(`${msg}. Make sure the backend server is running.`)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="uploader-root">
      <div className="uploader-header">
        <h2>🎬 Upload & Parse</h2>
        <p>Configure detection settings, then upload your video</p>
      </div>

      <div className="uploader-content">
        <div className="uploader-left">
          <div
            className={`dropzone ${previewUrl ? 'has-preview' : ''}`}
            onClick={() => { if (!previewUrl) fileInputRef.current?.click() }}
            onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }}
            onDrop={e => { e.preventDefault(); validateAndSet(e.dataTransfer.files?.[0] ?? null) }}
          >
            <input ref={fileInputRef} type="file" accept="video/*" className="hidden-input"
              onChange={(e) => validateAndSet(e.target.files?.[0] ?? null)} />

            {!previewUrl ? (
              <div className="drop-inner">
                <div className="drop-title">🎬 Drag or click to upload</div>
                <div className="muted">MP4, MOV, MKV, WEBM — max 2GB</div>
              </div>
            ) : (
              <div className="preview-wrapper">
                <video src={previewUrl} controls onClick={e => e.stopPropagation()} />
                <button className="preview-remove" aria-label="remove" onClick={(e) => { e.stopPropagation(); clearFile() }}>✕</button>
              </div>
            )}
          </div>
        </div>

        <div className="uploader-right">
          <SettingsPanel
            detectSwears={detectSwears} setDetectSwears={setDetectSwears}
            swearList={swearList} setSwearList={setSwearList}
            sensitivity={sensitivity} setSensitivity={setSensitivity}
            imagery={imagery} setImagery={setImagery}
          />
        </div>
      </div>

      {error && (
        <div style={{ margin: '12px 0', padding: '10px 14px', borderRadius: 8, background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.4)', color: '#fca5a5', fontSize: 13 }}>
          {error}
        </div>
      )}

      <div className="uploader-bottom">
        <div className="uploader-buttons">
          <button type="button" className="btn ghost" onClick={() => fileInputRef.current?.click()}>📁 Choose File</button>
          <button type="submit" className="btn" disabled={!file || submitting} onClick={submit}>
            {submitting ? '⏳ Uploading...' : '▶️ Parse Video'}
          </button>
        </div>
      </div>
    </div>
  )
}
