import { Target, Sparkles } from 'lucide-react'

type Event = { type: string; time: string; text?: string; severity?: number; confidence?: number; start?: number; end?: number }

type Props = {
  results: Event[]
  previewUrl?: string
  mediaType?: 'video' | 'audio'
  onSeek?: (seconds:number)=>void
}

function toSeconds(time: string) {
  const parts = time.split(':').map(p => Number(p) || 0)
  return (parts[0]||0)*3600 + (parts[1]||0)*60 + (parts[2]||0)
}

function getSeverityColor(severity?: number) {
  if (!severity) return '#9fb0cc'
  if (severity <= 1) return '#10b981'  // green - mild
  if (severity <= 2) return '#84cc16'  // lime - medium-low
  if (severity <= 3) return '#eab308'  // yellow - medium
  if (severity <= 4) return '#f97316'  // orange - high
  return '#ef4444'                      // red - very high
}

export default function ResultsPanel({ results, previewUrl, mediaType, onSeek }: Props) {
  const matched = results.filter(r => r.type === 'swear' && r.text)

  return (
    <div className="card" style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 18 }}>
      <h2 style={{ margin: 0, fontSize: '1.8em', fontWeight: 800, display: 'flex', alignItems: 'center', gap: 10 }}><Target size={22} color="#8b5cf6" /> Detected Words</h2>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 16, minHeight: 0, overflow: 'auto' }}>
        {matched.length === 0 ? (
          <div className="muted" style={{ fontSize: '1.1em', padding: '40px 20px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}><Sparkles size={28} color="#10b981" /> No matching words detected.</div>
        ) : (
          <div style={{display:'grid',gap:12}}>
            {matched.map((r, i) => (
              <div 
                key={i} 
                style={{
                  display:'flex',
                  justifyContent:'space-between',
                  alignItems:'flex-start',
                  padding:16,
                  borderRadius:10,
                  background:'rgba(255,255,255,0.02)',
                  border: `1px solid rgba(255,255,255,0.05)`,
                  borderLeft: `4px solid ${getSeverityColor(r.severity)}`,
                  cursor: 'pointer',
                  transition: 'all 200ms ease'
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.05)'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'}
              >
                <div style={{flex:1}}>
                  <div style={{fontWeight:700,fontSize:'1.05em',color:getSeverityColor(r.severity), marginBottom: 6}}>
                    {r.text}
                  </div>
                  <div style={{fontSize:'0.95em',color:'#9fb0cc',marginTop:4}}>
                    {r.time} • Confidence: {((r.confidence || 0) * 100).toFixed(0)}%
                  </div>
                </div>
                <div style={{display:'flex',gap:10}}>
                  <button className="btn small" onClick={() => onSeek?.(r.start ?? toSeconds(r.time))} style={{ marginLeft: 10 }}>
                    Jump
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {previewUrl && (
        <div style={{marginTop:12}}>
          {mediaType === 'audio'
            ? <audio src={previewUrl} controls style={{width:'100%', marginTop: 12}} />
            : <video src={previewUrl} controls style={{width:'100%',borderRadius:12, marginTop: 12}} />}
        </div>
      )}
    </div>
  )
}
