import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Film, Shield, Volume2, MapPin, SquareDashed, Move, Download, X, ZoomIn, Brain, Magnet, Crosshair,
  ChevronLeft, ChevronRight, Layers, Check, Loader2, Plus,
} from 'lucide-react'
import './EditorTutorial.css'

type Props = {
  open: boolean
  onClose: () => void
  isAudio?: boolean
  onDemo?: (active: boolean) => void // toggles the sample draggable clip in the editor
}

type Step = {
  icon: React.ReactNode
  title: string
  body: React.ReactNode
  target?: string // [data-tour="..."] selector to spotlight; omitted = centered
  demo?: boolean  // show the sample draggable clip for this step
  widget?: React.ReactNode // an illustrative mockup shown inside the tooltip
}

const SPOT_PAD = 8

export default function EditorTutorial({ open, onClose, isAudio = false, onDemo }: Props) {
  const [i, setI] = useState(0)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const tipRef = useRef<HTMLDivElement | null>(null)
  const [tipH, setTipH] = useState(320)

  const STEPS: Step[] = [
    {
      icon: <Film size={24} />,
      title: 'Welcome to the LucidCut Editor',
      body: <>Let's walk through the editor — each step highlights the actual control you'll use. Reopen this anytime with the <strong>?</strong> button.</>,
    },
    {
      icon: <Layers size={24} />,
      title: 'Queue as many projects as you like',
      body: <>You're never stuck waiting. Hit <strong>+ New</strong> up top to upload another file while this one finishes — add <strong>as many as you want</strong>. They line up and process <strong>one at a time</strong> (so your computer never overloads and it <strong>can't deadlock</strong>), and you can <strong>switch between them anytime</strong> from the tabs. A tab shows live <strong>%</strong> while parsing and a <strong>✓</strong> when it's ready to edit. Every project is saved automatically, so <strong>nothing is ever lost</strong> — even if you close one or restart.</>,
      widget: (
        <div className="tw-tabs">
          <span className="tw-tab active"><Film size={12} /> movie.mp4 <Check size={11} className="ok" /></span>
          <span className="tw-tab"><Loader2 size={12} className="lc-spin" /> clip2.mov <b>42%</b></span>
          <span className="tw-tab new"><Plus size={12} /> New</span>
        </div>
      ),
    },
    {
      icon: <Shield size={24} />,
      title: 'Your AI detections live here',
      body: <>Every detection LucidCut found is listed in this panel. For each one pick an action: {isAudio
        ? <><strong>Bleep</strong> the word or <strong>Cut</strong> the moment.</>
        : <><strong>Censor</strong> imagery, <strong>Bleep</strong> a word, or <strong>Cut</strong> the moment — or <strong>Censor All</strong> at once. Wrong call? Hit <strong>"False alarm?"</strong> and your AI learns from it.</>}</>,
      target: '[data-tour="detections"]',
    },
    {
      icon: <MapPin size={24} />,
      title: 'Select & edit any region by hand',
      body: <>Move the playhead and press <strong>I</strong> then <strong>O</strong> (or these buttons) to mark a span. Then hit <strong>Cut Region</strong> to remove it or <strong>Bleep Region</strong> to silence it.</>,
      target: '[data-tour="manual"]',
    },
    {
      icon: <Volume2 size={24} />,
      title: 'Add your own sounds & images',
      body: <>Upload your own files in the <strong>Media Pool</strong>. Assign a <strong>sound</strong> to a bleep to play a beep instead of muting (it's a beep <em>or</em> a mute — never both).{!isAudio && <> You can also upload <strong>images</strong> and drop one onto an FX box to cover the area with it — a logo, sticker, or sign.</>}</>,
      target: '[data-tour="media"]',
    },
    ...(isAudio ? [] : [{
      icon: <SquareDashed size={24} />,
      title: 'Cover an area with the FX Box',
      body: <>Click <strong>FX Box</strong>, then drag a rectangle on the video over anything to hide. Switch between <strong>Blur</strong>, <strong>Pixelate</strong>, <strong>Solid bar</strong>, or an <strong>uploaded image</strong>, and adjust the strength — all in this toolbar.</>,
      target: '[data-tour="fxbox"]',
    } as Step]),
    ...(isAudio ? [] : [{
      icon: <Crosshair size={24} />,
      title: 'Track a moving subject 🎯',
      body: <><strong>Pause and double-click</strong> a person or object to drop a box, <strong>resize it over them</strong>, then hit <strong>Track</strong>. LucidCut follows them through the shot until they leave or the scene cuts. When a box is selected, you'll see these controls:</>,
      target: '[data-tour="fxbox"]',
      widget: (
        <div className="tw-fxbar">
          <span className="tw-num">Start<i>20.50</i></span>
          <span className="tw-num">Length<i>3.00</i></span>
          <span className="tw-sel">Pixelate ▾</span>
          <span className="tw-range"><i style={{ width: '55%' }} /></span>
          <span className="tw-sel">No Overlay ▾</span>
          <span className="tw-btn track"><Crosshair size={11} /> Track</span>
          <span className="tw-btn learn"><Brain size={11} /> Should've been flagged</span>
        </div>
      ),
    } as Step]),
    ...(isAudio ? [] : [{
      icon: <Brain size={24} />,
      title: 'Your AI learns from you 🧠',
      body: <>Tap <strong>"False alarm?"</strong> on a detection that's wrong, or draw an FX box over something it missed and hit <strong>"Should've been flagged"</strong>. LucidCut trains a <strong>private model right on your machine</strong> from these corrections — so future scans steadily get more accurate to <em>your</em> standards. Nothing ever leaves your computer.</>,
      target: '[data-tour="detections"]',
    } as Step]),
    {
      icon: <ZoomIn size={24} />,
      title: 'Zoom in for precision',
      body: <>Drag the <strong>Zoom</strong> slider to magnify the timeline so you can place cuts and bleeps with frame-level accuracy.</>,
      target: '[data-tour="zoom"]',
    },
    {
      icon: <Magnet size={24} />,
      title: 'Snapping makes edits line up',
      body: <>With <strong>Snap</strong> on (toggle it here), dragging or resizing an edit <strong>magnetically clicks</strong> to the edges of other edits, the playhead, and the start/end — so you can match one edit's length to another exactly. Turn it off for totally free placement.</>,
      target: '[data-tour="snap"]',
    },
    {
      icon: <Move size={24} />,
      title: 'Resize & move edits on the timeline',
      body: <><strong>Try it right now</strong> on the glowing clip below 👇 — drag its <strong>left or right edge</strong> to make it longer or shorter, or grab the <strong>middle</strong> and slide it to <strong>reposition</strong> it.{!isAudio && <> FX boxes on the video work the same way.</>}</>,
      target: '[data-tour="timeline"]',
      demo: true,
    },
    {
      icon: <Download size={24} />,
      title: 'Export your result',
      body: <>When you're done, click <strong>Export</strong> and choose {isAudio
        ? <><strong>Audio</strong> or a <strong>Transcript</strong>.</>
        : <><strong>Video</strong>, <strong>Video + subtitles</strong>, or a <strong>Transcript</strong>.</>} Subtitles always follow your cuts and bleeps.</>,
      target: '[data-tour="export"]',
    },
  ]

  const lastIndex = STEPS.length - 1
  const idx = Math.min(i, lastIndex)
  const step = STEPS[idx]

  useEffect(() => { if (open) setI(0) }, [open])

  // measure the spotlight target whenever the step changes (or layout shifts)
  useLayoutEffect(() => {
    if (!open) return
    const measure = () => {
      const sel = STEPS[Math.min(i, STEPS.length - 1)]?.target
      const el = sel ? (document.querySelector(sel) as HTMLElement | null) : null
      const r = el ? el.getBoundingClientRect() : null
      if (el && r && r.width > 0 && r.height > 0) {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        setRect(el.getBoundingClientRect())
      } else {
        // target hidden (e.g. a panel collapsed on a narrow window) → centered tip
        setRect(null)
      }
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, i, isAudio])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowRight') setI(v => Math.min(v + 1, lastIndex))
      if (e.key === 'ArrowLeft') setI(v => Math.max(v - 1, 0))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, lastIndex, onClose])

  // show the sample draggable clip only while on a step flagged demo
  useEffect(() => {
    onDemo?.(open ? !!STEPS[Math.min(i, STEPS.length - 1)]?.demo : false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, i, isAudio])
  // make sure the demo clip is cleared if the component unmounts mid-tour
  useEffect(() => () => onDemo?.(false), []) // eslint-disable-line react-hooks/exhaustive-deps

  // measure the tooltip so we can keep it fully on-screen
  useLayoutEffect(() => {
    if (open && tipRef.current) setTipH(tipRef.current.offsetHeight)
  }, [open, i, rect, isAudio])

  if (!open) return null

  // spotlight rectangle (padded) + tooltip placement
  const spot = rect ? {
    left: rect.left - SPOT_PAD,
    top: rect.top - SPOT_PAD,
    width: rect.width + SPOT_PAD * 2,
    height: rect.height + SPOT_PAD * 2,
  } : null

  const TIP_W = 330
  const MARGIN = 12
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200
  // the tooltip never exceeds the viewport; if its content is taller it scrolls,
  // so the Back/Next buttons are ALWAYS reachable.
  const maxH = vh - MARGIN * 2
  const h = Math.min(tipH || 320, maxH)

  let tipStyle: React.CSSProperties
  if (!spot) {
    const top = Math.max(MARGIN, (vh - h) / 2)
    tipStyle = { left: Math.max(MARGIN, (vw - TIP_W) / 2), top, maxHeight: maxH }
  } else {
    const left = Math.max(MARGIN, Math.min(vw - TIP_W - MARGIN, spot.left + spot.width / 2 - TIP_W / 2))
    const below = spot.top + spot.height + 14
    const aboveTop = spot.top - 14 - h
    // prefer below if it fits, else above if it fits, else pin to top
    let top = (below + h <= vh - MARGIN) ? below : (aboveTop >= MARGIN ? aboveTop : MARGIN)
    // final clamp so it can never run off either edge
    top = Math.max(MARGIN, Math.min(top, vh - h - MARGIN))
    tipStyle = { left, top, maxHeight: maxH }
  }

  // On a demo step we leave the spotlighted area clickable so users can actually
  // drag the sample clip — the blocker becomes four rects around the hole.
  const interactive = !!step.demo && !!spot

  return createPortal(
    <div className="tour-root">
      {interactive && spot ? (
        <>
          <div className="tour-blocker" style={{ top: 0, left: 0, right: 0, height: Math.max(0, spot.top) }} />
          <div className="tour-blocker" style={{ top: spot.top + spot.height, left: 0, right: 0, bottom: 0 }} />
          <div className="tour-blocker" style={{ top: spot.top, left: 0, width: Math.max(0, spot.left), height: spot.height }} />
          <div className="tour-blocker" style={{ top: spot.top, left: spot.left + spot.width, right: 0, height: spot.height }} />
        </>
      ) : (
        <div className="tour-blocker" style={{ top: 0, left: 0, right: 0, bottom: 0 }} />
      )}

      {spot
        ? <div className="tour-spotlight" style={spot} />
        : <div className="tour-dim" />}

      <div className="tour-tip" ref={tipRef} style={{ width: TIP_W, ...tipStyle }} onClick={e => e.stopPropagation()}>
        <button className="tour-close" aria-label="Close" onClick={onClose}><X size={16} /></button>
        <div className="tour-head">
          <span className="tour-ic">{step.icon}</span>
          <div>
            <div className="tour-count">Step {idx + 1} of {STEPS.length}</div>
            <h3 className="tour-title">{step.title}</h3>
          </div>
        </div>
        <p className="tour-body">{step.body}</p>
        {step.widget && <div className="tour-widget">{step.widget}</div>}

        <div className="tour-dots">
          {STEPS.map((_, d) => (
            <span key={d} className={`tour-dot ${d === idx ? 'on' : ''}`} onClick={() => setI(d)} />
          ))}
        </div>

        <div className="tour-actions">
          <button className="tour-btn ghost" onClick={onClose}>Skip</button>
          <div className="tour-nav">
            <button className="tour-btn ghost" onClick={() => setI(v => Math.max(v - 1, 0))} disabled={idx === 0}>
              <ChevronLeft size={15} /> Back
            </button>
            {idx >= lastIndex
              ? <button className="tour-btn primary" onClick={onClose}>Got it!</button>
              : <button className="tour-btn primary" onClick={() => setI(v => Math.min(v + 1, lastIndex))}>Next <ChevronRight size={15} /></button>}
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
