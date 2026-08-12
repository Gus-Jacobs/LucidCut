import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Heart, X, Sparkles } from 'lucide-react'
import './DonateModal.css'
import logoUrl from '../../assets/logo.png'

const STRIPE_URL = 'https://buy.stripe.com/28E4gy2F49rNbxy60M6oo02'

type Props = {
  open: boolean
  onClose: () => void
}

export default function DonateModal({ open, onClose }: Props) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  // Render to <body> — the header's backdrop-filter would otherwise become the
  // containing block for position:fixed and pin the modal to the header.
  return createPortal(
    <div className="donate-overlay" onClick={onClose}>
      <div className="donate-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="donate-brand"><img src={logoUrl} alt="" /> LucidCut</div>
        <button className="donate-close" aria-label="Close" onClick={onClose}><X size={18} /></button>

        <h2 className="donate-title">Show LucidCut some love</h2>

        <p className="donate-body">
          LucidCut is <strong>100% free</strong> — and keeping it that way costs us real
          money and a whole lot of late nights. We build these tools because we love them,
          not because anyone pays us to.
        </p>
        <p className="donate-body">
          If LucidCut saved you time, chip in whatever feels right. And here's our promise
          back to you: <strong>we donate 10% of every dollar to charity</strong> — so your
          support carries the love forward. 💜
        </p>

        <div className="donate-actions">
          <button className="donate-btn ghost" onClick={onClose}>Nevermind</button>
          <a
            className="donate-btn primary"
            href={STRIPE_URL}
            target="_blank"
            rel="noreferrer"
            onClick={onClose}
          >
            <Sparkles size={16} /> Donate&nbsp;<Heart size={15} />
          </a>
        </div>

        <div className="donate-footnote">Secure checkout powered by Stripe · Pegumax</div>
      </div>
    </div>,
    document.body
  )
}
