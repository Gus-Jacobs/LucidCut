import { useMemo, useState } from 'react'
import { AlertTriangle, Loader2, CheckCircle2, XCircle, Circle, Zap, Cpu, Turtle } from 'lucide-react'

export type Step = { label: string; status: 'active' | 'done' | 'error' }

type Props = {
  previewUrl?: string
  mediaType?: 'video' | 'audio'
  queued?: boolean
  progress: number
  statusMessage: string
  steps: Step[]
  error?: string | null
  onCancel?: () => void
}

// Presentational only — App owns the polling/job state and feeds this view, so
// parsing keeps running in the background even when this screen isn't mounted.
export default function ParsingView({ previewUrl, mediaType, queued, progress, statusMessage, steps, error, onCancel }: Props) {
  const [mediaDur, setMediaDur] = useState(0)
  const isAudio = mediaType === 'audio'

  const hw = useMemo(() => {
    const cores = navigator.hardwareConcurrency || 4
    const mem = (navigator as any).deviceMemory || 4
    if (cores >= 8 && mem >= 8) return { tier: 'fast' as const, icon: <Zap size={15} />, msg: 'Modern hardware detected — super speed enabled', factor: 0.4, overhead: 5 }
    if (cores <= 4 || mem <= 4) return { tier: 'slow' as const, icon: <Turtle size={15} />, msg: 'Slower hardware detected — this may take longer', factor: 1.5, overhead: 20 }
    return { tier: 'medium' as const, icon: <Cpu size={15} />, msg: 'Hardware looks solid — this should be quick', factor: 0.8, overhead: 10 }
  }, [])

  const etaSec = mediaDur > 0
    ? Math.round(mediaDur * (isAudio ? hw.factor * 0.5 : hw.factor) + hw.overhead)
    : 0
  const etaText = etaSec >= 60 ? `~${Math.floor(etaSec / 60)}m ${etaSec % 60}s` : etaSec > 0 ? `~${etaSec}s` : null

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 20, marginTop: 16 }}>
      <h2 style={{ margin: 0, fontSize: '1.8em', fontWeight: 800, display: 'flex', alignItems: 'center', gap: 10 }}>
        {error ? (
          <><AlertTriangle size={24} color="#f87171" /> Parsing failed</>
        ) : queued ? (
          <><Loader2 size={24} color="#8b5cf6" className="lc-spin" /> Queued — waiting for the current job…</>
        ) : (
          <><Loader2 size={24} color="#8b5cf6" className="lc-spin" /> {isAudio ? 'Parsing audio…' : 'Parsing video…'}</>
        )}
      </h2>
      <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', flex: 1, flexWrap: 'wrap' }}>
        {previewUrl && (
          isAudio ? (
            <div className="parsing-audio-art">
              <Loader2 size={40} color="#8b5cf6" className="lc-spin" />
              <audio src={previewUrl} controls onLoadedMetadata={(e) => setMediaDur(e.currentTarget.duration || 0)} />
            </div>
          ) : (
            <video
              src={previewUrl}
              controls
              onLoadedMetadata={(e) => setMediaDur(e.currentTarget.duration || 0)}
              style={{
                width: '40%',
                maxWidth: 440,
                maxHeight: '55vh',
                objectFit: 'contain',
                alignSelf: 'flex-start',
                background: '#020617',
                borderRadius: 12,
                boxShadow: '0 8px 30px rgba(3,7,18,0.6)',
              }}
            />
          )
        )}
        <div style={{ flex: 1, minWidth: 280, display: 'flex', flexDirection: 'column', gap: 20 }}>
          {error ? (
            <>
              <div style={{ color: '#fca5a5', fontSize: '1.05em', lineHeight: 1.5 }}>{error}</div>
              <div>
                <button className="btn" onClick={onCancel}>← Back to Upload</button>
              </div>
            </>
          ) : (
            <>
              <div className={`parsing-hw ${hw.tier}`}>
                <span className="parsing-hw-icon">{hw.icon}</span>
                <span>{hw.msg}{etaText && <> · est. <strong>{etaText}</strong></>}</span>
              </div>
              <div>
                <div style={{ marginBottom: 8, width: '100%', height: 12, background: 'rgba(255,255,255,0.1)', borderRadius: 8, overflow: 'hidden' }}>
                  <div style={{ width: `${progress}%`, height: '100%', background: 'linear-gradient(90deg, #3b82f6, #8b5cf6)', transition: 'width 0.3s' }} />
                </div>
                <div style={{ fontSize: '0.95em', color: '#9fb0cc', fontWeight: 500 }}>{Math.round(progress)}%</div>
              </div>

              <ol className="parsing-steps">
                {steps.length === 0 && (
                  <li className="parsing-step active">
                    <Loader2 size={18} className="lc-spin" />
                    <span>{statusMessage}</span>
                  </li>
                )}
                {steps.map((s, i) => (
                  <li key={i} className={`parsing-step ${s.status}`}>
                    {s.status === 'done' ? <CheckCircle2 size={18} />
                      : s.status === 'error' ? <XCircle size={18} />
                      : s.status === 'active' ? <Loader2 size={18} className="lc-spin" />
                      : <Circle size={18} />}
                    <span>Step {i + 1}: {s.label}</span>
                  </li>
                ))}
              </ol>

              <div className="parsing-break">
                ☕ Sit back and relax — this can take a while for long files. You can even
                <strong> start another project</strong> while this one finishes, and switch between
                them up top. Your screen won't sleep while we scan.
              </div>

              <div>
                <button className="btn small ghost" onClick={onCancel}>Cancel</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
