type Props = {
  onHome?: () => void
}

export default function Header({ onHome }: Props) {
  return (
    <header className="header">
      <div className="brand" style={{cursor:'pointer'}} onClick={() => onHome?.()}>
        <div className="logo-mark" aria-hidden> P </div>
        <div style={{display:'flex',flexDirection:'column',lineHeight:1}}>
          <div style={{fontSize:14}}>LucidCut</div>
          <div style={{fontSize:11,opacity:0.85}}>by Pegumax</div>
        </div>
      </div>
      <div style={{opacity:0.9,fontSize:13}}>Prototype — Frontend Preview</div>
    </header>
  )
}
