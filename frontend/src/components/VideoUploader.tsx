import { useRef, useState, useEffect } from 'react'
import { Film, UploadCloud, X, FolderOpen, Play, Loader2, Music } from 'lucide-react'
import SettingsPanel, { type ImageryConfig } from './SettingsPanel'
import { apiUrl } from '../utils/api'
import './VideoUploader.css'

const ACCEPTED_VIDEO = /\.(mp4|mov|mkv|webm|avi|m4v|mpg|mpeg|wmv|flv|ts|m2ts|mts|3gp|ogv|vob|divx)$/i
const ACCEPTED_AUDIO = /\.(mp3|wav|m4a|flac|ogg|oga|aac|opus|wma|aif|aiff|amr|weba)$/i
// explicit extension list so the OS file picker shows them all (some systems
// don't map e.g. .avi/.flv to the generic video/* MIME)
const ACCEPT_ATTR = 'video/*,audio/*,.mp4,.mov,.mkv,.webm,.avi,.m4v,.mpg,.mpeg,.wmv,.flv,.ts,.m2ts,.mts,.3gp,.ogv,.vob,.divx,.mp3,.wav,.m4a,.flac,.ogg,.oga,.aac,.opus,.wma,.aif,.aiff,.amr'

function detectMediaType(f: File): 'video' | 'audio' | null {
  if (f.type.startsWith('video/') || ACCEPTED_VIDEO.test(f.name)) return 'video'
  if (f.type.startsWith('audio/') || ACCEPTED_AUDIO.test(f.name)) return 'audio'
  return null
}

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
  const [mediaType, setMediaType] = useState<'video' | 'audio'>('video')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [mediaReady, setMediaReady] = useState(false) // file confirmed playable locally
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const isAudio = mediaType === 'audio'

  function validateAndSet(f: File | null) {
    setError(null)
    if (!f) { setFile(null); setPreviewUrl(null); return }
    const type = detectMediaType(f)
    if (!type) {
      setError('Unsupported file. Choose a video (MP4, MOV, MKV, WEBM, AVI, M4V) or audio file (MP3, WAV, M4A, FLAC, OGG, AAC).')
      return
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setMediaReady(false)
    setFile(f)
    setMediaType(type)
    setPreviewUrl(URL.createObjectURL(f))
  }

  function clearFile() {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setFile(null); setPreviewUrl(null); setError(null); setMediaReady(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  async function submit(e?: any) {
    if (e) e.preventDefault()
    if (!file || submitting) return
    // audio sources can only be word-scanned; imagery never applies
    const effectiveImagery = isAudio ? { ...imagery, enabled: false } : imagery
    if (!detectSwears && !effectiveImagery.enabled) {
      setError(isAudio
        ? 'Enable word detection before parsing this audio file.'
        : 'Enable at least one detection type (words or visual) before parsing.')
      return
    }

    const config = {
      detectSwears,
      swearList,
      sensitivity,
      imageryDetection: effectiveImagery,
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
        onNavigate?.('parsing', { jobId: json.jobId, file, previewUrl, mediaType })
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
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Film size={22} color="#8b5cf6" /> Upload & Parse
        </h2>
        <p>Configure detection settings, then upload your video or audio file</p>
      </div>

      <div className="uploader-content">
        <div className="uploader-left">
          <div
            className={`dropzone ${previewUrl ? 'has-preview' : ''}`}
            onClick={() => { if (!previewUrl) fileInputRef.current?.click() }}
            onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }}
            onDrop={e => { e.preventDefault(); validateAndSet(e.dataTransfer.files?.[0] ?? null) }}
          >
            <input ref={fileInputRef} type="file" accept={ACCEPT_ATTR} className="hidden-input"
              onChange={(e) => validateAndSet(e.target.files?.[0] ?? null)} />

            {!previewUrl ? (
              <div className="drop-inner">
                <UploadCloud size={40} color="#8b5cf6" style={{ marginBottom: 10 }} />
                <div className="drop-title">Drag or click to upload</div>
                <div className="muted">Video or audio — no size limit</div>
              </div>
            ) : isAudio ? (
              <div className="preview-wrapper audio">
                <div className="audio-preview">
                  <div className="audio-art"><Music size={42} color="#8b5cf6" /></div>
                  <div className="audio-name">{file?.name}</div>
                  <audio src={previewUrl} controls onClick={e => e.stopPropagation()}
                    onLoadedMetadata={() => setMediaReady(true)}
                    onError={() => { setMediaReady(false); setError('This audio file could not be read. It may be corrupted or incomplete — please try another.') }} />
                </div>
                <button className="preview-remove" aria-label="remove" onClick={(e) => { e.stopPropagation(); clearFile() }}><X size={18} /></button>
              </div>
            ) : (
              <div className="preview-wrapper">
                <video src={previewUrl} controls onClick={e => e.stopPropagation()}
                  onLoadedMetadata={() => setMediaReady(true)}
                  onError={() => { setMediaReady(false); setError('This video could not be read. It may be corrupted or incomplete — please try another.') }} />
                <button className="preview-remove" aria-label="remove" onClick={(e) => { e.stopPropagation(); clearFile() }}><X size={18} /></button>
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
            isAudio={isAudio}
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
          <button type="button" className="btn ghost" onClick={() => fileInputRef.current?.click()} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <FolderOpen size={16} /> Choose File
          </button>
          <button type="submit" className="btn" disabled={!file || submitting || !mediaReady} onClick={submit} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            {submitting ? <><Loader2 size={16} className="lc-spin" /> Uploading...</> : !file ? <><Play size={16} /> {isAudio ? 'Parse Audio' : 'Parse Video'}</> : !mediaReady ? <><Loader2 size={16} className="lc-spin" /> Checking file…</> : <><Play size={16} /> {isAudio ? 'Parse Audio' : 'Parse Video'}</>}
          </button>
        </div>
      </div>
    </div>
  )
}
