import { useState } from 'react'
import { Heart, MessageSquare } from 'lucide-react'
import DonateModal from './DonateModal'
import FeedbackModal from './FeedbackModal'
import logoUrl from '../../assets/logo.png'

type Props = {
  onHome?: () => void
}

export default function Header({ onHome }: Props) {
  const [donateOpen, setDonateOpen] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)

  return (
    <header className="header">
      <div className="brand" style={{cursor:'pointer'}} onClick={() => onHome?.()}>
        <img className="logo-mark" src={logoUrl} alt="LucidCut" />
        <div style={{display:'flex',flexDirection:'column',lineHeight:1}}>
          <div style={{fontSize:14}}>LucidCut</div>
          <div style={{fontSize:11,opacity:0.85}}>by Pegumax</div>
        </div>
      </div>
      <div className="header-actions">
        <button className="header-btn" onClick={() => setFeedbackOpen(true)}>
          <MessageSquare size={15} /> Feedback
        </button>
        <button className="donate-cta" onClick={() => setDonateOpen(true)}>
          <Heart size={15} /> Support us
        </button>
      </div>
      <DonateModal open={donateOpen} onClose={() => setDonateOpen(false)} />
      <FeedbackModal open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
    </header>
  )
}
