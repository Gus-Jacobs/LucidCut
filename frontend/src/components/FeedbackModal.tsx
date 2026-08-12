import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Send, Loader2, CheckCircle2, WifiOff, MessageSquare } from 'lucide-react'
import './FeedbackModal.css'

const FORMSPREE_URL = 'https://formspree.io/f/mgojklwv'

type Props = {
  open: boolean
  onClose: () => void
}

type Status = 'idle' | 'sending' | 'sent' | 'error'

const TYPES = ['Bug report', 'Question', 'Feature request', 'Concern', 'Other / general'] as const

export default function FeedbackModal({ open, onClose }: Props) {
  const [type, setType] = useState<string>(TYPES[0])
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [online, setOnline] = useState<boolean>(typeof navigator !== 'undefined' ? navigator.onLine : true)

  useEffect(() => {
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down) }
  }, [])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // reset to a fresh form each time it's opened
  useEffect(() => { if (open) { setStatus('idle'); setErrorMsg(''); setMessage(''); setType(TYPES[0]) } }, [open])

  if (!open) return null

  async function submit() {
    if (!message.trim()) { setErrorMsg('Please enter a message.'); return }
    if (!online) { setErrorMsg('You appear to be offline. Connect to the internet to send.'); return }
    setStatus('sending'); setErrorMsg('')
    try {
      const payload: Record<string, string> = {
        type,
        message: message.trim(),
        _subject: `LucidCut — ${type}`,
      }
      // only include email when given — Formspree rejects an invalid reply-to,
      // so an empty/placeholder value would block truly-optional submissions
      if (email.trim()) payload.email = email.trim()
      const res = await fetch(FORMSPREE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      })
      if (res.ok) {
        setStatus('sent')
      } else {
        const data = await res.json().catch(() => ({}))
        throw new Error(data?.errors?.[0]?.message || `Send failed (${res.status})`)
      }
    } catch (e: any) {
      setStatus('error')
      setErrorMsg(e?.message || 'Could not send. Please try again.')
    }
  }

  return createPortal(
    <div className="fb-overlay" onClick={onClose}>
      <div className="fb-modal" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
        <button className="fb-close" aria-label="Close" onClick={onClose}><X size={18} /></button>

        {status === 'sent' ? (
          <div className="fb-sent">
            <div className="fb-sent-icon"><CheckCircle2 size={34} /></div>
            <h2 className="fb-title">Thank you!</h2>
            <p className="fb-body">Your message is on its way to the LucidCut team. We read every one.</p>
            <button className="fb-btn primary" onClick={onClose}>Close</button>
          </div>
        ) : (
          <>
            <div className="fb-head">
              <span className="fb-badge"><MessageSquare size={22} /></span>
              <div>
                <h2 className="fb-title">Get in touch</h2>
                <p className="fb-sub">Bugs, questions, ideas, concerns — tell us anything.</p>
              </div>
            </div>

            {!online && (
              <div className="fb-offline"><WifiOff size={15} /> You're offline. Reconnect to send your message.</div>
            )}

            <label className="fb-label">Topic</label>
            <select className="fb-input" value={type} onChange={e => setType(e.target.value)}>
              {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>

            <label className="fb-label">Your email <span className="fb-opt">(optional, so we can reply)</span></label>
            <input className="fb-input" type="email" value={email} placeholder="you@example.com" onChange={e => setEmail(e.target.value)} />

            <label className="fb-label">Message</label>
            <textarea className="fb-input fb-textarea" value={message} placeholder="What's on your mind?" onChange={e => setMessage(e.target.value)} />

            {errorMsg && <div className="fb-error">{errorMsg}</div>}

            <div className="fb-actions">
              <button className="fb-btn ghost" onClick={onClose}>Cancel</button>
              <button className="fb-btn primary" onClick={submit} disabled={status === 'sending' || !online}>
                {status === 'sending' ? <><Loader2 size={16} className="lc-spin" /> Sending…</> : <><Send size={16} /> Send</>}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  )
}
