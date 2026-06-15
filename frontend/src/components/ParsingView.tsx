import { useEffect, useRef, useState } from 'react'
import { apiUrl } from '../utils/api'
import { secondsToTimecode, type Detection } from '../types'

type Props = {
  previewUrl?: string
  jobId?: string
  onComplete: (results: Detection[]) => void
  onCancel?: () => void
  setProgress: (p: number) => void
}

export default function ParsingView({ previewUrl, jobId, onComplete, onCancel, setProgress }: Props) {
  const pollRef = useRef<number | null>(null)
  const [progress, setLocalProgress] = useState(0)
  const [statusMsg, setStatusMsg] = useState('Starting...')
  const [error, setError] = useState<string | null>(null)

  function updateProgress(p: number) {
    setLocalProgress(p)
    setProgress(p)
  }

  useEffect(() => {
    let cancelled = false

    function buildResults(data: any): Detection[] {
      const profanity: Detection[] = (data.profanity_detections || []).map((m: any, idx: number) => ({
        id: `prof-${idx}`,
        type: 'swear' as const,
        time: secondsToTimecode(m.start || 0),
        text: m.word,
        severity: m.severity,
        confidence: m.confidence ?? 1,
        start: m.start || 0,
        end: m.end || 0,
      }))

      const imagery: Detection[] = (data.imagery_detections || []).map((u: any, idx: number) => {
        const severity = u.severity === 'hard' ? 5 : 3
        const regionLabels = (u.regions || []).map((r: any) => r.label)
        const uniqueLabels = Array.from(new Set(regionLabels))
        const label = uniqueLabels.length
          ? uniqueLabels.join(', ')
          : (u.severity === 'hard' ? 'Explicit content' : 'Sensitive content')
        return {
          id: `unsafe-${idx}`,
          type: 'unsafe' as const,
          time: secondsToTimecode(u.start || 0),
          text: label,
          severity,
          confidence: u.confidence ?? u.max_confidence ?? 0,
          start: u.start || 0,
          end: u.end || 0,
          nsfw_severity: u.severity,
          regions: u.regions || [],
          bbox: u.bbox,
        }
      })

      return [...profanity, ...imagery].sort((a, b) => a.start - b.start)
    }

    async function pollJob() {
      if (!jobId) return
      try {
        const res = await fetch(apiUrl(`/api/jobs/${jobId}`))
        if (!res.ok) throw new Error(`job fetch failed (${res.status})`)
        const job = await res.json()
        if (cancelled) return

        if (job.statusMessage) setStatusMsg(job.statusMessage)
        if (typeof job.progress === 'number') updateProgress(job.progress)

        if (job.status === 'failed') {
          setError(job.error || 'Processing failed. Please try a different video.')
          setStatusMsg('Failed')
          return
        }

        if (job.status === 'completed') {
          const r = await fetch(apiUrl(`/api/jobs/${jobId}/results`))
          if (!r.ok) throw new Error('could not load results')
          const data = await r.json()
          const results = buildResults(data)
          console.log(`Parsed ${results.length} detections (imagery mode: ${data.imagery_mode})`)
          updateProgress(100)
          setStatusMsg('Complete!')
          onComplete(results)
          return
        }
      } catch (e: any) {
        console.error('poll error', e)
        if (cancelled) return
        // transient errors: keep polling, but surface persistent failure
        setStatusMsg('Waiting for backend...')
      }
      pollRef.current = window.setTimeout(pollJob, 1000)
    }

    if (jobId) {
      updateProgress(5)
      pollJob()
    } else {
      setError('No job started. Please re-upload your video.')
    }

    return () => {
      cancelled = true
      if (pollRef.current) clearTimeout(pollRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId])

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 20, marginTop: 16 }}>
      <h2 style={{ margin: 0, fontSize: '1.8em', fontWeight: 800 }}>
        {error ? '⚠️ Parsing failed' : '⏳ Parsing video...'}
      </h2>
      <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', flex: 1 }}>
        {previewUrl && (
          <video src={previewUrl} controls style={{ maxWidth: '40%', minHeight: 300, borderRadius: 12, boxShadow: '0 8px 30px rgba(3,7,18,0.6)' }} />
        )}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 20 }}>
          {error ? (
            <>
              <div style={{ color: '#fca5a5', fontSize: '1.05em', lineHeight: 1.5 }}>{error}</div>
              <div>
                <button className="btn" onClick={onCancel}>← Back to Upload</button>
              </div>
            </>
          ) : (
            <>
              <div className="muted" style={{ fontSize: '1.1em' }}>{statusMsg}</div>
              <div>
                <div style={{ marginBottom: 12, width: '100%', height: 14, background: 'rgba(255,255,255,0.1)', borderRadius: 8, overflow: 'hidden' }}>
                  <div style={{ width: `${progress}%`, height: '100%', background: 'linear-gradient(90deg, #3b82f6, #8b5cf6)', transition: 'width 0.3s' }} />
                </div>
                <div style={{ fontSize: '1em', color: '#9fb0cc', fontWeight: 500 }}>{Math.round(progress)}%</div>
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
