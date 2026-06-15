import './App.css'
import Header from './components/Header'
import { useState } from 'react'
import VideoUploader from './components/VideoUploader'
import ParsingView from './components/ParsingView'
import ResultsPanel from './components/ResultsPanel'
import ReviewScreen from './components/ReviewScreen'
import Editor from './components/Editor'
import DebugConsole, { useDebugConsole } from './components/DebugConsole'
import { apiUrl } from './utils/api'

function App() {
  const [page, setPage] = useState<'home'|'workspace'>('home')
  const [workspaceScreen, setWorkspaceScreen] = useState<'upload'|'parsing'|'review'|'results'|'editor'>('upload')
  const [workspaceState, setWorkspaceState] = useState<any>({})
  const debugLogs = useDebugConsole()

  if (page === 'home') {
    return (
      <div id="app-root">
        <Header onHome={() => { setPage('home'); window.scrollTo({top:0,behavior:'smooth'}) }} />
        <main className="home-hero">
          <div className="home-inner card">
            <div className="home-left">
              <div className="hero-badge reveal delay-1">Pegumax</div>
              <h1 className="hero-title reveal delay-2">LucidCut — Smart video parsing & editing</h1>
              <p className="hero-sub reveal delay-3">From Pegumax — we build robust software for teams. LucidCut uses AI to detect profanity, sensitive imagery, and auto-apply edits so you can ship safer content faster.</p>

              <div className="hero-ctas reveal delay-3">
                <button className="btn" onClick={() => setPage('workspace')}>Get Started</button>
                <a className="btn small ghost learn-link" href="https://pegumax.com/software-center" target="_blank" rel="noreferrer">Pegumax Software Center</a>
              </div>
            </div>

            <div className="home-right reveal delay-2">
              <div style={{padding:16,borderRadius:12,background:'linear-gradient(180deg,rgba(255,255,255,0.02),rgba(255,255,255,0.01))'}}>
                <div style={{fontWeight:700,color:'#dbeafe',marginBottom:8}}>Why LucidCut?</div>
                <ul style={{color:'#9fb0cc'}}>
                  <li>Fast automated parsing of speech and imagery.</li>
                  <li>Apply bulk edits: blur, bleep, cut.</li>
                  <li>Enterprise-ready pipeline and export options.</li>
                </ul>
              </div>
            </div>
          </div>
        </main>
      </div>
    )
  }

  return (
    <div id="app-root">
      <Header onHome={() => { setPage('home'); window.scrollTo({top:0,behavior:'smooth'}) }} />
      <main className="container workspace">
        <h1 className="title">LucidCut</h1>
        <p className="subtitle">Auto-parse, edit, and export — by Pegumax</p>
        <div className="grid">
          <div className="main-col">
            {workspaceScreen === 'upload' && (
              <VideoUploader onNavigate={(screen, payload) => {
                if (screen === 'parsing') {
                  setWorkspaceState(payload)
                  setWorkspaceScreen('parsing')
                }
              }} />
            )}

            {workspaceScreen === 'parsing' && (
              <div>
                  <ParsingView previewUrl={workspaceState.previewUrl} jobId={workspaceState.jobId} setProgress={(p:number)=>{ void p }} onComplete={(results:any[])=>{ setWorkspaceState((s:any)=>({ ...s, results })); setWorkspaceScreen('review') }} onCancel={() => { setWorkspaceScreen('upload') }} />
                </div>
            )}

            {workspaceScreen === 'review' && (
              <ReviewScreen
                detections={workspaceState.results || []}
                onSubmit={(feedback:any) => {
                  console.log('📋 Review feedback submitted:', feedback)
                  setWorkspaceState((s:any) => ({ ...s, reviewFeedback: feedback }))
                  if (workspaceState.jobId) {
                    fetch(apiUrl(`/api/jobs/${workspaceState.jobId}/feedback`), {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ feedback })
                    }).catch(e => console.error('Failed to submit feedback:', e))
                  }
                  // drop false positives; merge severity edits back onto the detection
                  const removed = new Set(feedback.filter((f:any) => f.action === 'remove').map((f:any) => f.id))
                  const correctedResults = (workspaceState.results || [])
                    .filter((r:any) => !removed.has(r.id))
                    .map((r:any) => {
                      const f = feedback.find((fb:any) => fb.id === r.id && fb.action === 'change_severity')
                      return f && f.newSeverity ? { ...r, nsfw_severity: f.newSeverity } : r
                    })
                  setWorkspaceState((s:any) => ({ ...s, results: correctedResults }))
                  setWorkspaceScreen('editor')
                }}
                onSkip={() => {
                  console.log('📋 Review skipped')
                  setWorkspaceScreen('editor')
                }}
              />
            )}

            {workspaceScreen === 'results' && (
              <div>
                <ResultsPanel results={workspaceState.results || []} previewUrl={workspaceState.previewUrl} onSeek={(s:number)=>{ const v = document.querySelector('video'); if (v) (v as HTMLVideoElement).currentTime = s }} />
                <div style={{display:'flex',gap:8,marginTop:8}}>
                  <button className="btn" onClick={() => setWorkspaceScreen('editor')}>View in Editor</button>
                  <button className="btn small ghost" onClick={() => setWorkspaceScreen('review')}>Back to Review</button>
                  <button className="btn small ghost" onClick={() => setWorkspaceScreen('upload')}>Cancel</button>
                </div>
              </div>
            )}

            {workspaceScreen === 'editor' && (
              <Editor jobId={workspaceState.jobId} results={workspaceState.results || []} previewUrl={workspaceState.previewUrl} onBack={() => setWorkspaceScreen('review')} />
            )}
          </div>
        </div>
      </main>
      <DebugConsole logs={debugLogs} />
    </div>
  )
}

export default App
