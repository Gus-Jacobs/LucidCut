import './App.css'
import Header from './components/Header'
import { useState, useEffect, useRef } from 'react'
import { Film, Music, Trash2, Clock, Plus, X, Check, Loader2, AlertTriangle, Pause, Play, Square } from 'lucide-react'
import VideoUploader from './components/VideoUploader'
import ParsingView from './components/ParsingView'
import Editor from './components/Editor'
import DebugConsole, { useDebugConsole } from './components/DebugConsole'
import ConfirmModal from './components/ConfirmModal'
import { apiUrl } from './utils/api'
import { buildDetections } from './utils/detections'
import type { Detection } from './types'

type Step = { label: string; status: 'active' | 'done' | 'error' }
type Project = {
  id: string
  name: string
  mediaType: 'video' | 'audio'
  previewUrl?: string
  status: 'queued' | 'parsing' | 'ready' | 'failed'
  progress: number
  statusMessage: string
  steps: Step[]
  error?: string | null
  results: Detection[]
  initialEdits: any[]
}
const feStatus = (s: string): 'queued' | 'parsing' => (s === 'queued' ? 'queued' : 'parsing')

function timeAgo(ts?: number): string {
  if (!ts) return ''
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function App() {
  const [page, setPage] = useState<'home'|'workspace'>('home')
  // open projects (each is its own session); activeId 'new' shows the uploader
  const [projects, setProjects] = useState<Project[]>([])
  const [activeId, setActiveId] = useState<string | 'new'>('new')
  const [recents, setRecents] = useState<any[]>([])
  const [queuePaused, setQueuePaused] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const debugLogs = useDebugConsole()

  const projectsRef = useRef(projects); projectsRef.current = projects
  const active = projects.find(p => p.id === activeId) || null
  const anyParsing = projects.some(p => p.status === 'parsing' || p.status === 'queued')
  const queueItems = projects.filter(p => p.status === 'parsing' || p.status === 'queued')

  // ---- queue poller: /api/queue is the source of truth for active jobs, so the
  // queue survives refreshes (jobs reappear) and background jobs auto-appear. ----
  useEffect(() => {
    let stopped = false
    const tick = async () => {
      let data: any
      try {
        const r = await fetch(apiUrl('/api/queue'))
        if (!r.ok) return
        data = await r.json()
      } catch { return }
      if (stopped) return
      setQueuePaused(!!data.paused)
      const active: any[] = data.jobs || []
      const activeIds = new Set(active.map(j => j.id))

      // upsert active jobs (discovers jobs not already in our tabs — e.g. after a refresh)
      setProjects(prev => {
        const next = prev.slice()
        for (const j of active) {
          const idx = next.findIndex(p => p.id === j.id)
          if (idx >= 0) {
            if (next[idx].status === 'queued' || next[idx].status === 'parsing') {
              next[idx] = { ...next[idx], status: feStatus(j.status), progress: j.progress,
                statusMessage: j.statusMessage, steps: j.steps || [] }
            }
          } else {
            next.push({
              id: j.id, name: j.name, mediaType: j.mediaType,
              previewUrl: apiUrl(`/api/download/${j.id}/original`),
              status: feStatus(j.status), progress: j.progress, statusMessage: j.statusMessage,
              steps: j.steps || [], results: [], initialEdits: [],
            })
          }
        }
        return next
      })

      // resolve tabs that left the active list while still marked parsing/queued
      const toResolve = projectsRef.current.filter(p => (p.status === 'parsing' || p.status === 'queued') && !activeIds.has(p.id))
      for (const p of toResolve) {
        try {
          const r = await fetch(apiUrl(`/api/jobs/${p.id}`))
          if (r.status === 404) { setProjects(prev => prev.filter(x => x.id !== p.id)); continue }
          const job = await r.json()
          if (job.status === 'completed') {
            const rr = await fetch(apiUrl(`/api/jobs/${p.id}/results`))
            const d = rr.ok ? await rr.json() : {}
            setProjects(prev => prev.map(x => x.id === p.id ? { ...x, status: 'ready', progress: 100, statusMessage: 'Complete', results: buildDetections(d) } : x))
          } else if (job.status === 'failed') {
            setProjects(prev => prev.map(x => x.id === p.id ? { ...x, status: 'failed', error: job.error || 'Processing failed.' } : x))
          } else if (job.status === 'canceled') {
            setProjects(prev => prev.filter(x => x.id !== p.id))
          }
        } catch { /* keep until next tick */ }
      }
    }
    const iv = setInterval(tick, 1000)
    tick()
    return () => { stopped = true; clearInterval(iv) }
  }, [])

  function pauseQueue(paused: boolean) {
    setQueuePaused(paused)
    fetch(apiUrl(`/api/queue/${paused ? 'pause' : 'resume'}`), { method: 'POST' }).catch(() => {})
  }

  // ---- keep the machine awake whenever ANY project is parsing ----
  useEffect(() => {
    if (!anyParsing) return
    let lock: any = null
    const acquire = async () => { try { if ('wakeLock' in navigator) lock = await (navigator as any).wakeLock.request('screen') } catch {} }
    acquire()
    const onVis = () => { if (document.visibilityState === 'visible') acquire() }
    document.addEventListener('visibilitychange', onVis)
    try { (window as any).electron?.keepAwake?.(true) } catch {}
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      try { lock?.release?.() } catch {}
      try { (window as any).electron?.keepAwake?.(false) } catch {}
    }
  }, [anyParsing])

  // Load Recents whenever we land on the home screen.
  useEffect(() => {
    if (page !== 'home') return
    fetch(apiUrl('/api/projects'))
      .then(r => (r.ok ? r.json() : { projects: [] }))
      .then(d => setRecents(d.projects || []))
      .catch(() => setRecents([]))
  }, [page])

  // upload finished -> add a new parsing project and focus it
  function onUploaded(payload: any) {
    const proj: Project = {
      id: payload.jobId, name: payload.file?.name || 'Untitled', mediaType: payload.mediaType || 'video',
      previewUrl: payload.previewUrl, status: 'parsing', progress: 5, statusMessage: 'Starting…',
      steps: [], results: [], initialEdits: [],
    }
    setProjects(prev => [...prev, proj])
    setActiveId(proj.id)
  }

  async function openRecent(id: string) {
    if (projectsRef.current.some(p => p.id === id)) { setActiveId(id); setPage('workspace'); return }
    try {
      const r = await fetch(apiUrl(`/api/projects/${id}`))
      if (!r.ok) throw new Error('not found')
      const p = await r.json()
      if (!p.available) { setRecents(rs => rs.filter(x => x.id !== id)); alert('This project\'s media has expired or been removed.'); return }
      const proj: Project = {
        id, name: p.name, mediaType: p.mediaType, previewUrl: apiUrl(`/api/download/${id}/original`),
        status: 'ready', progress: 100, statusMessage: 'Complete', steps: [],
        results: buildDetections(p.results || {}), initialEdits: p.edits || [],
      }
      setProjects(prev => [...prev, proj])
      setActiveId(id)
      setPage('workspace')
    } catch {
      alert('Could not open this project.')
    }
  }

  function deleteProject(id: string) {
    setRecents(rs => rs.filter(x => x.id !== id))
    fetch(apiUrl(`/api/projects/${id}`), { method: 'DELETE' }).catch(() => {})
  }
  function clearRecents() {
    setRecents([])
    fetch(apiUrl('/api/projects'), { method: 'DELETE' }).catch(() => {})
  }

  // close an open project tab. If it's still queued/processing, cancel it on the
  // backend too (so it can't keep holding the worker slot invisibly).
  function closeProject(id: string, opts?: { stayOnPage?: boolean }) {
    const p = projectsRef.current.find(x => x.id === id)
    if (p && (p.status === 'parsing' || p.status === 'queued')) {
      fetch(apiUrl(`/api/jobs/${id}/cancel`), { method: 'POST' }).catch(() => {})
    }
    setProjects(prev => {
      const next = prev.filter(x => x.id !== id)
      if (activeId === id && !opts?.stayOnPage) {
        if (next.length > 0) setActiveId(next[next.length - 1].id)
        else { setActiveId('new'); setPage('home'); window.scrollTo({ top: 0, behavior: 'smooth' }) }
      }
      return next
    })
  }

  function startNewProject() { setActiveId('new'); setPage('workspace') }
  function goHome() { setPage('home'); window.scrollTo({ top: 0, behavior: 'smooth' }) }

  const showBar = page === 'workspace' && projects.length > 0

  if (page === 'home') {
    return (
      <div id="app-root">
        <Header onHome={goHome} />
        <main className="home-hero">
          <div className="home-inner card">
            <div className="home-left">
              <div className="hero-badge reveal delay-1">Pegumax</div>
              <h1 className="hero-title reveal delay-2">LucidCut — Smart video parsing & editing</h1>
              <p className="hero-sub reveal delay-3">From Pegumax — we build robust software for teams. LucidCut uses AI to detect profanity, sensitive imagery, and auto-apply edits so you can ship safer content faster.</p>

              <div className="hero-ctas reveal delay-3">
                <button className="btn" onClick={startNewProject}>{projects.length > 0 ? 'Back to Workspace' : 'Get Started'}</button>
                <a className="btn small ghost learn-link" href="https://pegumax.com/software-center/" target="_blank" rel="noreferrer">Pegumax Software Center</a>
              </div>
              {recents.length > 0 && (
                <a className="recents-hint reveal delay-3" onClick={() => document.getElementById('recents')?.scrollIntoView({ behavior: 'smooth' })}>
                  ↓ {recents.length} recent project{recents.length > 1 ? 's' : ''}
                </a>
              )}
            </div>

            <div className="home-right reveal delay-2">
              <div style={{padding:16,borderRadius:12,background:'linear-gradient(180deg,rgba(255,255,255,0.02),rgba(255,255,255,0.01))'}}>
                <div style={{fontWeight:700,color:'#dbeafe',marginBottom:8}}>Why LucidCut?</div>
                <ul style={{color:'#9fb0cc'}}>
                  <li>Fast automated parsing of speech and imagery.</li>
                  <li>Works with video <em>and</em> audio / music files.</li>
                  <li>Queue several projects — parse one while editing another.</li>
                  <li>Learns your preferences to cut false positives.</li>
                </ul>
              </div>
            </div>
          </div>
        </main>

        {queueItems.length > 0 && (
          <section className="recents queue-section">
            <div className="recents-head">
              <h2><Loader2 size={18} className="lc-spin" /> Processing queue</h2>
              <button className="btn small ghost" onClick={() => pauseQueue(!queuePaused)}>
                {queuePaused ? <><Play size={14} /> Resume all</> : <><Pause size={14} /> Pause all</>}
              </button>
            </div>
            <p className="recents-sub">{queuePaused ? 'Queue paused — the running job finishes, but the next won\'t start until you resume.' : 'Jobs run one at a time so your computer never overloads. Nothing is lost — you can leave and come back.'}</p>
            <div className="queue-list">
              {queueItems.map(p => (
                <div key={p.id} className="queue-row">
                  <span className="queue-icon">{p.status === 'parsing' ? <Loader2 size={16} className="lc-spin" /> : <Clock size={16} />}</span>
                  <button className="queue-open" onClick={() => { setActiveId(p.id); setPage('workspace') }}>
                    <span className="queue-name">{p.name}</span>
                    <span className="queue-meta">{p.status === 'parsing' ? `${Math.round(p.progress)}% · ${p.statusMessage || 'Processing…'}` : 'Waiting in queue'}</span>
                  </button>
                  <button className="queue-act" onClick={() => closeProject(p.id, { stayOnPage: true })}
                    title={p.status === 'parsing' ? 'Stop this job (the next one starts)' : 'Remove from queue'}>
                    {p.status === 'parsing' ? <><Square size={13} /> Stop</> : <><X size={14} /> Remove</>}
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {recents.length > 0 && (
          <section id="recents" className="recents">
            <div className="recents-head">
              <h2><Clock size={18} /> Recent projects</h2>
              <button className="btn small ghost" onClick={() => setConfirmClear(true)}>Clear all</button>
            </div>
            <p className="recents-sub">Kept for 30 days. Pick up where you left off — your edits are saved automatically.</p>
            <div className="recents-grid">
              {recents.map(p => (
                <div key={p.id} className={`recent-card ${p.available ? '' : 'expired'}`}>
                  <button className="recent-open" onClick={() => openRecent(p.id)} disabled={!p.available}>
                    <span className="recent-icon">{p.mediaType === 'audio' ? <Music size={18} /> : <Film size={18} />}</span>
                    <span className="recent-info">
                      <span className="recent-name">{p.name}</span>
                      <span className="recent-meta">{p.detectionCount} detection{p.detectionCount === 1 ? '' : 's'} · {timeAgo(p.completedAt)}{p.available ? '' : ' · expired'}</span>
                    </span>
                  </button>
                  <button className="recent-del" onClick={() => setPendingDelete({ id: p.id, name: p.name })} title="Delete project"><Trash2 size={15} /></button>
                </div>
              ))}
            </div>
          </section>
        )}

        <ConfirmModal
          open={!!pendingDelete}
          danger
          title="Delete this project?"
          message={<>This permanently removes <strong>{pendingDelete?.name}</strong> and its saved data. This can't be undone.</>}
          confirmLabel="Delete"
          cancelLabel="Keep"
          onConfirm={() => { if (pendingDelete) deleteProject(pendingDelete.id); setPendingDelete(null); }}
          onCancel={() => setPendingDelete(null)}
        />
        <ConfirmModal
          open={confirmClear}
          danger
          title="Clear all projects?"
          message={<>This permanently deletes <strong>all {recents.length} recent project{recents.length === 1 ? '' : 's'}</strong> and their saved data. This can't be undone.</>}
          confirmLabel="Clear all"
          cancelLabel="Keep"
          onConfirm={() => { clearRecents(); setConfirmClear(false); }}
          onCancel={() => setConfirmClear(false)}
        />
      </div>
    )
  }

  return (
    <div id="app-root" className={showBar ? 'with-bar' : ''}>
      <Header onHome={goHome} />

      {showBar && (
        <div className="project-bar">
          <div className="project-tabs">
            {projects.map(p => (
              <button key={p.id} className={`project-tab ${activeId === p.id ? 'active' : ''} ${p.status}`}
                onClick={() => setActiveId(p.id)} title={p.name}>
                <span className="pt-icon">
                  {p.status === 'parsing' ? <Loader2 size={14} className="lc-spin" />
                    : p.status === 'queued' ? <Clock size={14} />
                    : p.status === 'failed' ? <AlertTriangle size={14} />
                    : p.mediaType === 'audio' ? <Music size={14} /> : <Film size={14} />}
                </span>
                <span className="pt-name">{p.name}</span>
                {p.status === 'parsing' && <span className="pt-pct">{Math.round(p.progress)}%</span>}
                {p.status === 'queued' && <span className="pt-pct queued">Queued</span>}
                {p.status === 'ready' && <Check size={13} className="pt-ready" />}
                <span className="pt-close" onClick={(e) => { e.stopPropagation(); closeProject(p.id) }} title={p.status === 'parsing' || p.status === 'queued' ? 'Stop & close' : 'Close'}><X size={13} /></span>
              </button>
            ))}
            <button className={`project-tab new ${activeId === 'new' ? 'active' : ''}`} onClick={startNewProject} title="Start another project">
              <Plus size={15} /> New
            </button>
          </div>
          {queueItems.length > 0 && (
            <button className="queue-pause" onClick={() => pauseQueue(!queuePaused)} title={queuePaused ? 'Resume the queue' : 'Pause the queue (current job keeps running)'}>
              {queuePaused ? <><Play size={13} /> Resume queue</> : <><Pause size={13} /> Pause queue</>}
            </button>
          )}
        </div>
      )}

      <main className="container workspace">
        <h1 className="title">LucidCut</h1>
        <p className="subtitle">Auto-parse, edit, and export — by Pegumax</p>
        <div className={`grid ${active && active.status === 'ready' ? '' : 'flow'}`}>
          <div className="main-col">
            {activeId === 'new' && (
              <VideoUploader onNavigate={(screen, payload) => { if (screen === 'parsing') onUploaded(payload) }} />
            )}

            {active && active.status !== 'ready' && (
              <ParsingView
                previewUrl={active.previewUrl}
                mediaType={active.mediaType}
                queued={active.status === 'queued'}
                progress={active.progress}
                statusMessage={active.statusMessage}
                steps={active.steps}
                error={active.status === 'failed' ? active.error : null}
                onCancel={() => closeProject(active.id)}
              />
            )}

            {active && active.status === 'ready' && (
              <Editor key={active.id} jobId={active.id} results={active.results} previewUrl={active.previewUrl}
                mediaType={active.mediaType} initialEdits={active.initialEdits} onBack={() => closeProject(active.id)} />
            )}
          </div>
        </div>
      </main>
      <DebugConsole logs={debugLogs} />
    </div>
  )
}

export default App
