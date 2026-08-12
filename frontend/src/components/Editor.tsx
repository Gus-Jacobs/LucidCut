import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Film, Undo2, Redo2, Music, Image as ImageIcon, Pause, Play, Shield,
  Scissors, Volume2, MousePointer2, SquareDashed, MapPin, Trash2, Loader2,
  Download, CheckCircle2, XCircle, Check, FileText, Captions, ChevronUp, HelpCircle,
  Flag, Brain, Magnet, Crosshair, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight,
} from 'lucide-react';
import './Editor.css';
import { apiUrl } from '../utils/api';
import type { Detection, BoxCoords } from '../types';
import { buildSubtitleCues, toSrt, mergeRanges, type Segment } from '../utils/subtitles';
import EditorTutorial from './EditorTutorial';
import ConfirmModal from './ConfirmModal';

type FxType = 'blur' | 'solid' | 'pixelate';

type TimelineEdit = {
  id: string;
  action: 'cut' | 'bleep' | 'blur';
  start: number;
  end: number;
  box?: BoxCoords;
  fxType?: FxType;
  fxIntensity?: number;
  source?: 'ai' | 'manual';
  customMediaId?: string;
  label?: string;
  track?: { t: number; box: BoxCoords }[]; // follow-tracker keyframes (moving box)
};

type CustomMedia = {
  id: string;
  file: File;
  name: string;
  type: 'audio' | 'image';
  url: string;
};

type Props = {
  jobId?: string;
  results?: Detection[];
  previewUrl?: string;
  mediaType?: 'video' | 'audio';
  initialEdits?: TimelineEdit[];
  onBack: () => void;
};

type ExportState = { status: 'idle' | 'processing' | 'success' | 'error'; message?: string; progress?: number };

function formatTimecode(seconds: number, fps = 24) {
  if (!isFinite(seconds)) seconds = 0;
  const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
  const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  const f = Math.floor((seconds % 1) * fps).toString().padStart(2, '0');
  return `${h}:${m}:${s}:${f}`;
}
function getSeverityColor(sev?: number) {
  if (!sev) return '#9fb0cc';
  if (sev <= 2) return '#84cc16';
  if (sev <= 3) return '#eab308';
  return '#ef4444';
}

const MIN_BOX = 1; // percent
const DEMO_EDIT_ID = '__tour_demo__'; // ephemeral sample edit shown during the tutorial

export default function Editor({ jobId, results = [], previewUrl, mediaType, initialEdits, onBack }: Props) {
  const isAudio = mediaType === 'audio';
  const [aspectRatio, setAspectRatio] = useState<number>(16 / 9);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [exporting, setExporting] = useState(false);
  const [exportState, setExportState] = useState<ExportState>({ status: 'idle' });
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [removeBleeped, setRemoveBleeped] = useState(true);
  const [segments, setSegments] = useState<Segment[]>([]);
  const hasTranscript = segments.length > 0;
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const [tourDemo, setTourDemo] = useState(false); // shows a sample draggable clip during the tour
  const [confirmExit, setConfirmExit] = useState(false);
  // model-feedback markers (move the old Review screen into the editor)
  const [falseAlarms, setFalseAlarms] = useState<Set<string>>(new Set());   // AI detections the user rejects
  const [flaggedPositives, setFlaggedPositives] = useState<Set<string>>(new Set()); // manual boxes taught as correct
  const [detFilter, setDetFilter] = useState<'all' | 'imagery' | 'words'>('all'); // detections panel filter
  const [snapEnabled, setSnapEnabled] = useState(true); // magnetic snapping while dragging edits
  const [tracking, setTracking] = useState(false); // follow-tracker request in flight

  // only prompt if there's real work to lose (ignore the tour's sample clip)
  const handleExit = () => {
    if (edits.some(e => e.id !== DEMO_EDIT_ID)) setConfirmExit(true);
    else { submitImageryFeedback(); onBack(); }
  };

  // auto-run the tutorial the first time the editor is opened
  useEffect(() => {
    if (!localStorage.getItem('lc_editorTutorialSeen')) {
      setTutorialOpen(true);
      localStorage.setItem('lc_editorTutorialSeen', '1');
    }
  }, []);

  // add/remove the interactive sample clip the tour lets users practice on
  useEffect(() => {
    if (tourDemo) {
      setEditsRaw(prev => {
        if (prev.some(e => e.id === DEMO_EDIT_ID)) return prev;
        const d = duration > 0 ? duration : 10;
        return [...prev, { id: DEMO_EDIT_ID, action: 'bleep', start: d * 0.34, end: d * 0.66, source: 'manual' }];
      });
    } else {
      setEditsRaw(prev => (prev.some(e => e.id === DEMO_EDIT_ID) ? prev.filter(e => e.id !== DEMO_EDIT_ID) : prev));
    }
  }, [tourDemo, duration]);

  const [edits, setEditsRaw] = useState<TimelineEdit[]>(() => initialEdits ?? []);
  const undoStack = useRef<TimelineEdit[][]>([]);
  const redoStack = useRef<TimelineEdit[][]>([]);

  const [activeTool, setActiveTool] = useState<'select' | 'blur_box'>('select');
  const [inMarker, setInMarker] = useState<number | null>(null);
  const [outMarker, setOutMarker] = useState<number | null>(null);
  const [selectedEditId, setSelectedEditId] = useState<string | null>(null);

  const [timelineResizing, setTimelineResizing] = useState<{ id: string; edge: 'left' | 'right' } | null>(null);
  const [timelineMoving, setTimelineMoving] = useState<{ id: string; offset: number } | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [hbar, setHbar] = useState<{ show: boolean; left: number; width: number }>({ show: false, left: 0, width: 100 });
  const hbarDrag = useRef<{ startX: number; startScroll: number } | null>(null);
  const [mediaPool, setMediaPool] = useState<CustomMedia[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // canvas drawing / box manipulation
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState({ x: 0, y: 0 });
  const [currentBox, setCurrentBox] = useState<BoxCoords | null>(null);
  const boxInteraction = useRef<
    | { mode: 'move' | 'resize'; id: string; handle?: string; startX: number; startY: number; orig: BoxCoords }
    | null
  >(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  // ---- edit mutation with undo history ----
  const commit = useCallback((updater: (prev: TimelineEdit[]) => TimelineEdit[]) => {
    setEditsRaw(prev => {
      undoStack.current.push(prev);
      if (undoStack.current.length > 100) undoStack.current.shift();
      redoStack.current = [];
      return updater(prev);
    });
  }, []);

  const undo = useCallback(() => {
    setEditsRaw(prev => {
      const last = undoStack.current.pop();
      if (last === undefined) return prev;
      redoStack.current.push(prev);
      return last;
    });
  }, []);

  const redo = useCallback(() => {
    setEditsRaw(prev => {
      const next = redoStack.current.pop();
      if (next === undefined) return prev;
      undoStack.current.push(prev);
      return next;
    });
  }, []);

  // autosave timeline edits to the project so an editing crash can be recovered
  useEffect(() => {
    if (!jobId) return;
    const real = edits.filter(e => e.id !== DEMO_EDIT_ID);
    const t = setTimeout(() => {
      fetch(apiUrl(`/api/projects/${jobId}/edits`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ edits: real }),
      }).catch(() => {});
    }, 1500);
    return () => clearTimeout(t);
  }, [edits, jobId]);

  // load transcript segments (for subtitle / transcript export) once
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    fetch(apiUrl(`/api/jobs/${jobId}/results`))
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (!cancelled && data && Array.isArray(data.segments)) setSegments(data.segments); })
      .catch(() => { /* transcript export simply stays unavailable */ });
    return () => { cancelled = true; };
  }, [jobId]);

  // ---- follow-tracker (click a subject; the blur follows it) ----
  const lerpBox = (a: BoxCoords, b: BoxCoords, f: number): BoxCoords => ({
    x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f,
    w: a.w + (b.w - a.w) * f, h: a.h + (b.h - a.h) * f,
  });
  const boxAtTime = (ed: TimelineEdit, t: number): BoxCoords | undefined => {
    const tr = ed.track;
    if (!tr || tr.length === 0) return ed.box;
    if (t <= tr[0].t) return tr[0].box;
    if (t >= tr[tr.length - 1].t) return tr[tr.length - 1].box;
    for (let i = 0; i < tr.length - 1; i++) {
      if (t >= tr[i].t && t <= tr[i + 1].t) {
        const span = tr[i + 1].t - tr[i].t || 1;
        return lerpBox(tr[i].box, tr[i + 1].box, (t - tr[i].t) / span);
      }
    }
    return ed.box;
  };

  // hardware tier (fetched once) — picks the right tracker & warns on weak HW
  const capRef = useRef<{ tier: string; cores?: number; memGB?: number } | null>(null);
  const trackWarnedRef = useRef(false);
  const [pendingTrack, setPendingTrack] = useState<TimelineEdit | null>(null);
  useEffect(() => {
    fetch(apiUrl('/api/capabilities')).then(r => (r.ok ? r.json() : null)).then(c => { capRef.current = c; }).catch(() => {});
  }, []);

  // double-click a paused subject -> drop a RESIZABLE box. The user sizes it over
  // the subject, then hits "Track" to make it follow.
  function seedBoxAtPoint(clientX: number, clientY: number) {
    if (isAudio || !canvasRef.current || !videoRef.current?.paused) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const cx = ((clientX - rect.left) / rect.width) * 100;
    const cy = ((clientY - rect.top) / rect.height) * 100;
    const w = 16, h = 28;
    const box = {
      x: Math.max(0, Math.min(100 - w, cx - w / 2)),
      y: Math.max(0, Math.min(100 - h, cy - h / 2)),
      w, h,
    };
    const id = `fx-${Date.now()}`;
    commit(prev => [...prev, {
      id, action: 'blur', start: currentTime, end: Math.min(currentTime + 3, duration || currentTime + 3),
      box, fxType: 'pixelate', fxIntensity: 30, source: 'manual',
    }]);
    setSelectedEditId(id);
    setActiveTool('select');
  }

  const setEditTiming = (id: string, patch: Partial<TimelineEdit>) =>
    setEditsRaw(prev => prev.map(e => (e.id === id ? { ...e, ...patch } : e)));

  function trackEdit(edit: TimelineEdit) {
    if (!edit.box || isAudio || !jobId || tracking) return;
    if (capRef.current?.tier === 'low' && !trackWarnedRef.current) { setPendingTrack(edit); return; }
    runTrack(edit);
  }

  async function runTrack(edit: TimelineEdit) {
    if (!edit.box || !jobId) return;
    setSelectedEditId(edit.id);
    setTracking(true);
    setExportState({ status: 'processing', message: 'Locking on & following the subject…' });
    try {
      const res = await fetch(apiUrl(`/api/jobs/${jobId}/track`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ time: edit.start, box: edit.box, tier: capRef.current?.tier || 'mid' }),
      });
      const data = await res.json();
      if (res.ok && Array.isArray(data.track) && data.track.length > 1) {
        const tr = data.track as { t: number; box: BoxCoords }[];
        const tEnd = tr[tr.length - 1].t;
        setEditsRaw(prev => prev.map(e => e.id === edit.id
          ? { ...e, end: Math.max(e.start + 0.2, tEnd), box: tr[0].box, track: tr, label: 'Tracked' } : e));
        setExportState({ status: 'success', message: `Following the subject for ${(tEnd - edit.start).toFixed(1)}s 🎯` });
      } else {
        setExportState({ status: 'success', message: 'Couldn\'t lock on — resize the box over the subject and hit Track again.' });
      }
    } catch {
      setExportState({ status: 'error', message: 'Tracking failed.' });
    } finally {
      setTracking(false);
      setTimeout(() => setExportState(s => (s.status === 'processing' ? s : { status: 'idle' })), 4500);
    }
  }

  const untrackEdit = (id: string) => commit(prev => prev.map(e => (e.id === id ? { ...e, track: undefined, label: undefined } : e)));

  // ---- AI detection helpers ----
  const imageryDetections = results.filter(r => r.type === 'unsafe');
  const swearDetections = results.filter(r => r.type === 'swear');

  const isApplied = (start: number, action: string) =>
    edits.some(e => Math.abs(e.start - start) < 0.001 && e.action === action);

  const toggleAiEdit = (det: Detection, action: 'bleep' | 'cut') => {
    if (det.start === undefined || det.end === undefined) return;
    commit(prev => {
      const isThis = (e: TimelineEdit, a: string) => e.source === 'ai' && e.action === a && e.id.startsWith(`ai-${a}-${det.id}-`);
      const existing = prev.findIndex(e => isThis(e, action));
      if (existing >= 0) return prev.filter((_, i) => i !== existing); // toggle off
      // mute/cut/censor are mutually exclusive for one detection — drop the others
      const conflicts = action === 'cut' ? ['bleep', 'blur'] : ['cut', 'blur'];
      const kept = prev.filter(e => !(e.source === 'ai' && conflicts.some(a => e.id.startsWith(`ai-${a}-${det.id}-`))));
      return [...kept, { id: `ai-${action}-${det.id}-${Date.now()}`, action, start: det.start, end: det.end, source: 'ai', label: det.text }];
    });
  };

  // Build censor (blur/pixelate/solid) boxes for an imagery detection's regions.
  const censorDetection = (det: Detection, fxType: FxType = 'pixelate') => {
    const boxes: BoxCoords[] = [];
    if (det.regions && det.regions.length > 0) {
      det.regions.forEach(r => r.box && boxes.push(r.box));
    } else if (det.bbox) {
      boxes.push(det.bbox);
    }
    if (boxes.length === 0) {
      // frame-level detection with no region: cover full frame
      boxes.push({ x: 0, y: 0, w: 100, h: 100 });
    }
    const ts = Date.now();
    commit(prev => {
      // remove any prior AI censor for this detection so re-clicking re-applies cleanly
      // re-applying clears prior censor for this detection, and a censor replaces a cut (mutually exclusive)
      const kept = prev.filter(e => !(e.source === 'ai' && (e.id.startsWith(`ai-blur-${det.id}-`) || e.id.startsWith(`ai-cut-${det.id}-`))));
      const added: TimelineEdit[] = boxes.map((box, i) => ({
        id: `ai-blur-${det.id}-${i}-${ts}`,
        action: 'blur',
        start: det.start,
        end: det.end,
        box,
        fxType,
        fxIntensity: fxType === 'blur' ? 25 : fxType === 'pixelate' ? 30 : 100,
        source: 'ai',
        label: det.text,
      }));
      return [...kept, ...added];
    });
    if (videoRef.current) videoRef.current.currentTime = det.start;
  };

  const censorAll = () => {
    imageryDetections.forEach(det => { if (!isCensored(det)) censorDetection(det, 'pixelate'); });
  };

  const isCensored = (det: Detection) =>
    edits.some(e => e.action === 'blur' && e.id.startsWith(`ai-blur-${det.id}-`));

  // toggle: clicking Censored again removes this detection's AI censor boxes
  const toggleCensor = (det: Detection) => {
    if (isCensored(det)) {
      commit(prev => prev.filter(e => !(e.action === 'blur' && e.id.startsWith(`ai-blur-${det.id}-`))));
    } else {
      censorDetection(det, 'pixelate');
    }
  };

  // ---- model feedback (replaces the old standalone Review screen) ----
  // Mark an AI detection as a false alarm — teaches the model it was wrong here.
  const toggleFalseAlarm = (det: Detection) => {
    setFalseAlarms(prev => {
      const next = new Set(prev);
      if (next.has(det.id)) next.delete(det.id);
      else {
        next.add(det.id);
        if (isCensored(det)) commit(p => p.filter(e => !(e.action === 'blur' && e.id.startsWith(`ai-blur-${det.id}-`))));
      }
      return next;
    });
  };

  // Send per-detection verdicts (keep = correct/positive, false alarm = negative).
  function submitImageryFeedback() {
    if (!jobId) return;
    const imagery = results.filter(r => r.type === 'unsafe');
    if (imagery.length === 0) return;
    const feedback = imagery.map(d => ({ id: d.id, type: 'unsafe', action: falseAlarms.has(d.id) ? 'remove' : 'keep' }));
    fetch(apiUrl(`/api/jobs/${jobId}/feedback`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ feedback }),
    }).catch(() => {});
  }

  // Grab the pixels under a manual FX box so the model can learn a missed positive.
  async function captureEditRegion(edit: TimelineEdit): Promise<string | null> {
    const v = videoRef.current as HTMLVideoElement | null;
    if (!v || isAudio || !edit.box) return null;
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return null;
    const restore = v.currentTime;
    const t = Math.min(Math.max((edit.start + edit.end) / 2, 0), duration || edit.end);
    if (Math.abs(v.currentTime - t) > 0.1) {
      await new Promise<void>(res => {
        const h = () => { v.removeEventListener('seeked', h); res(); };
        v.addEventListener('seeked', h); v.currentTime = t;
      });
    }
    const bx = Math.max(0, edit.box.x / 100 * vw), by = Math.max(0, edit.box.y / 100 * vh);
    const bw = Math.max(1, edit.box.w / 100 * vw), bh = Math.max(1, edit.box.h / 100 * vh);
    const scale = Math.min(1, 512 / Math.max(bw, bh)); // keep training crops small
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bw * scale)); canvas.height = Math.max(1, Math.round(bh * scale));
    const ctx = canvas.getContext('2d');
    let data: string | null = null;
    try {
      if (ctx) { ctx.drawImage(v, bx, by, bw, bh, 0, 0, canvas.width, canvas.height); data = canvas.toDataURL('image/jpeg', 0.9); }
    } catch { data = null; }
    if (Math.abs(v.currentTime - restore) > 0.1) v.currentTime = restore;
    return data;
  }

  async function teachAsPositive(edit: TimelineEdit) {
    if (!jobId) return;
    const img = await captureEditRegion(edit);
    if (!img) { setExportState({ status: 'error', message: 'Could not capture that region to teach the AI.' }); return; }
    try {
      await fetch(apiUrl(`/api/jobs/${jobId}/sample`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'positive', image: img }),
      });
      setFlaggedPositives(prev => new Set(prev).add(edit.id));
      setExportState({ status: 'success', message: 'Thanks — added as a training example for your AI.' });
      setTimeout(() => setExportState(s => (s.status === 'success' ? { status: 'idle' } : s)), 4000);
    } catch {
      setExportState({ status: 'error', message: 'Could not send the training example.' });
    }
  }

  const applyManualCut = () => {
    if (inMarker === null || outMarker === null) return;
    const start = Math.min(inMarker, outMarker);
    const end = Math.max(inMarker, outMarker);
    commit(prev => [...prev, { id: `man-cut-${Date.now()}`, action: 'cut', start, end, source: 'manual' }]);
    setInMarker(null); setOutMarker(null); setActiveTool('select');
  };

  const applyManualBleep = () => {
    if (inMarker === null || outMarker === null) return;
    const start = Math.min(inMarker, outMarker);
    const end = Math.max(inMarker, outMarker);
    commit(prev => [...prev, { id: `man-bleep-${Date.now()}`, action: 'bleep', start, end, source: 'manual' }]);
    setInMarker(null); setOutMarker(null); setActiveTool('select');
  };

  // live refs so drag handlers can read fresh state without re-subscribing
  const editsRef = useRef(edits); editsRef.current = edits;
  const currentTimeRef = useRef(currentTime); currentTimeRef.current = currentTime;
  const snapEnabledRef = useRef(snapEnabled); snapEnabledRef.current = snapEnabled;

  // Magnetic snap: pull a dragged time to the nearest edit edge / playhead / bounds
  // when within ~10px, so edits line up exactly (toggleable via the toolbar).
  const snapTimeValue = (t: number, excludeId: string): number => {
    if (!snapEnabledRef.current || !timelineRef.current || duration <= 0) return t;
    const sw = timelineRef.current.scrollWidth || 1;
    // 12px tolerance, but never tighter than 80ms — otherwise at high zoom the
    // window is too small for the mouse to ever land inside and snap never fires.
    const thr = Math.max(0.08, (12 / sw) * duration);
    const targets = [0, duration, currentTimeRef.current];
    for (const e of editsRef.current) { if (e.id === excludeId) continue; targets.push(e.start, e.end); }
    let best = t, bestD = thr;
    for (const tg of targets) { const d = Math.abs(tg - t); if (d < bestD) { bestD = d; best = tg; } }
    return best;
  };

  // ---- timeline edge resize ----
  useEffect(() => {
    if (!timelineResizing) return;
    const onMove = (e: MouseEvent) => {
      if (!timelineRef.current) return;
      const rect = timelineRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left + timelineRef.current.scrollLeft;
      const totalWidth = timelineRef.current.scrollWidth;
      let newTime = Math.max(0, Math.min(duration, (x / totalWidth) * duration));
      newTime = snapTimeValue(newTime, timelineResizing.id);
      setEditsRaw(prev => prev.map(edit => {
        if (edit.id !== timelineResizing.id) return edit;
        return timelineResizing.edge === 'left'
          ? { ...edit, start: Math.min(newTime, edit.end - 0.1) }
          : { ...edit, end: Math.max(newTime, edit.start + 0.1) };
      }));
    };
    const onUp = () => setTimelineResizing(null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [timelineResizing, duration, zoom]);

  // ---- timeline clip move (drag the body to reposition the whole edit) ----
  useEffect(() => {
    if (!timelineMoving) return;
    const onMove = (e: MouseEvent) => {
      if (!timelineRef.current || duration <= 0) return;
      const rect = timelineRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left + timelineRef.current.scrollLeft;
      const totalWidth = timelineRef.current.scrollWidth;
      const t = (x / totalWidth) * duration;
      setEditsRaw(prev => prev.map(ed => {
        if (ed.id !== timelineMoving.id) return ed;
        const dur = ed.end - ed.start;
        let ns = Math.max(0, Math.min(duration - dur, t - timelineMoving.offset));
        if (snapEnabledRef.current) {
          // snap whichever edge (start or end) lands closest to a target
          const snapStart = snapTimeValue(ns, ed.id);
          const snapEnd = snapTimeValue(ns + dur, ed.id) - dur;
          ns = Math.abs(snapStart - ns) <= Math.abs(snapEnd - ns) ? snapStart : snapEnd;
          ns = Math.max(0, Math.min(duration - dur, ns));
        }
        return { ...ed, start: ns, end: ns + dur };
      }));
    };
    const onUp = () => setTimelineMoving(null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [timelineMoving, duration, zoom]);

  const startClipMove = (e: React.MouseEvent, edit: TimelineEdit) => {
    e.stopPropagation();
    if (!timelineRef.current || duration <= 0) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left + timelineRef.current.scrollLeft;
    const totalWidth = rect.width * zoom;
    const clickTime = (x / totalWidth) * duration;
    setSelectedEditId(edit.id);
    setTimelineMoving({ id: edit.id, offset: clickTime - edit.start });
  };

  // keep the playhead in view ONLY during playback. While paused (clicking,
  // scrubbing, resizing, dragging) the view never auto-scrolls, so it won't jump
  // or fight the user.
  useEffect(() => {
    if (!isPlaying || scrubbing || timelineResizing || timelineMoving) return;
    const vp = timelineRef.current;
    if (!vp || duration <= 0) return;
    const total = vp.scrollWidth;
    const playX = (currentTime / duration) * total;
    const margin = vp.clientWidth * 0.15;
    if (playX < vp.scrollLeft + margin || playX > vp.scrollLeft + vp.clientWidth - margin) {
      vp.scrollLeft = Math.max(0, Math.min(total - vp.clientWidth, playX - vp.clientWidth * 0.35));
    }
  }, [currentTime, duration, zoom, isPlaying, scrubbing, timelineResizing, timelineMoving]);

  // ---- playhead scrubbing (grab the red bar / ruler and drag) ----
  const timeFromClientX = (clientX: number) => {
    const vp = timelineRef.current;
    if (!vp || duration <= 0) return 0;
    const rect = vp.getBoundingClientRect();
    const x = clientX - rect.left + vp.scrollLeft;
    const total = vp.scrollWidth;
    return Math.max(0, Math.min(duration, (x / total) * duration));
  };
  const applyScrub = (clientX: number) => {
    const t = timeFromClientX(clientX);
    setCurrentTime(t); // update the playhead immediately so it tracks the cursor
    if (videoRef.current) videoRef.current.currentTime = t;
  };
  useEffect(() => {
    if (!scrubbing) return;
    const onMove = (e: MouseEvent) => applyScrub(e.clientX);
    const onUp = () => setScrubbing(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrubbing, duration, zoom]);

  // ---- custom horizontal scrollbar (floats above the debug console) ----
  useEffect(() => {
    const vp = timelineRef.current;
    if (!vp) return;
    const update = () => {
      const sw = vp.scrollWidth, cw = vp.clientWidth;
      if (sw <= cw + 1) { setHbar(h => (h.show ? { ...h, show: false } : h)); return; }
      setHbar({ show: true, width: (cw / sw) * 100, left: (vp.scrollLeft / sw) * 100 });
    };
    update();
    vp.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => { vp.removeEventListener('scroll', update); window.removeEventListener('resize', update); };
  }, [zoom, duration]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = hbarDrag.current, vp = timelineRef.current;
      if (!d || !vp) return;
      const dx = e.clientX - d.startX;
      vp.scrollLeft = d.startScroll + (dx / vp.clientWidth) * vp.scrollWidth;
    };
    const onUp = () => { hbarDrag.current = null; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);
  const startHbarDrag = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const vp = timelineRef.current;
    if (!vp) return;
    hbarDrag.current = { startX: e.clientX, startScroll: vp.scrollLeft };
  };

  // ---- canvas box drag / resize ----
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const it = boxInteraction.current;
      if (!it || !canvasRef.current) return;
      const rect = canvasRef.current.getBoundingClientRect();
      const dx = ((e.clientX - it.startX) / rect.width) * 100;
      const dy = ((e.clientY - it.startY) / rect.height) * 100;
      setEditsRaw(prev => prev.map(ed => {
        if (ed.id !== it.id || !ed.box) return ed;
        const o = it.orig;
        if (it.mode === 'move') {
          return { ...ed, box: {
            x: Math.max(0, Math.min(100 - o.w, o.x + dx)),
            y: Math.max(0, Math.min(100 - o.h, o.y + dy)),
            w: o.w, h: o.h,
          } };
        }
        let { x, y, w, h } = o;
        if (it.handle?.includes('e')) w = Math.max(MIN_BOX, Math.min(100 - x, o.w + dx));
        if (it.handle?.includes('s')) h = Math.max(MIN_BOX, Math.min(100 - y, o.h + dy));
        if (it.handle?.includes('w')) { const nx = Math.max(0, Math.min(o.x + o.w - MIN_BOX, o.x + dx)); w = o.w + (o.x - nx); x = nx; }
        if (it.handle?.includes('n')) { const ny = Math.max(0, Math.min(o.y + o.h - MIN_BOX, o.y + dy)); h = o.h + (o.y - ny); y = ny; }
        return { ...ed, box: { x, y, w, h } };
      }));
    };
    const onUp = () => {
      if (boxInteraction.current) {
        boxInteraction.current = null;
        // snapshot for undo after a manipulation completes
        setEditsRaw(prev => { undoStack.current.push(prev); redoStack.current = []; return prev; });
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  const startBoxMove = (e: React.MouseEvent, ed: TimelineEdit) => {
    e.stopPropagation();
    if (!ed.box) return;
    setSelectedEditId(ed.id);
    boxInteraction.current = { mode: 'move', id: ed.id, startX: e.clientX, startY: e.clientY, orig: { ...ed.box } };
  };
  const startBoxResize = (e: React.MouseEvent, ed: TimelineEdit, handle: string) => {
    e.stopPropagation();
    if (!ed.box) return;
    setSelectedEditId(ed.id);
    boxInteraction.current = { mode: 'resize', id: ed.id, handle, startX: e.clientX, startY: e.clientY, orig: { ...ed.box } };
  };

  // ---- media ----
  const handleMediaUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    const added: CustomMedia[] = Array.from(e.target.files).map((file, idx) => ({
      id: `media-${Date.now()}-${idx}`,
      file, name: file.name,
      type: file.type.startsWith('image/') ? 'image' : 'audio',
      url: URL.createObjectURL(file),
    }));
    setMediaPool(prev => [...prev, ...added]);
  };
  const assignMediaToEdit = (mediaId: string | undefined) => {
    if (!selectedEditId) return;
    commit(prev => prev.map(ed => ed.id === selectedEditId ? { ...ed, customMediaId: mediaId } : ed));
  };

  // ---- new box drawing ----
  const handleCanvasMouseDown = (e: React.MouseEvent) => {
    if (activeTool !== 'blur_box' || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    setIsDrawing(true);
    setDrawStart({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    setCurrentBox({ x: e.clientX - rect.left, y: e.clientY - rect.top, w: 0, h: 0 });
  };
  const handleCanvasMouseMove = (e: React.MouseEvent) => {
    if (!isDrawing || !canvasRef.current || !currentBox) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    setCurrentBox({ x: Math.min(drawStart.x, cx), y: Math.min(drawStart.y, cy), w: Math.abs(cx - drawStart.x), h: Math.abs(cy - drawStart.y) });
  };
  const handleCanvasMouseUp = () => {
    if (!isDrawing || !currentBox || !canvasRef.current) return;
    setIsDrawing(false);
    if (currentBox.w > 12 && currentBox.h > 12) {
      const rect = canvasRef.current.getBoundingClientRect();
      const pct = {
        x: (currentBox.x / rect.width) * 100, y: (currentBox.y / rect.height) * 100,
        w: (currentBox.w / rect.width) * 100, h: (currentBox.h / rect.height) * 100,
      };
      const start = inMarker !== null ? inMarker : currentTime;
      const end = outMarker !== null ? outMarker : Math.min(currentTime + 3, duration || currentTime + 3);
      const id = `fx-${Date.now()}`;
      commit(prev => [...prev, {
        id, action: 'blur', start: Math.min(start, end), end: Math.max(start, end),
        box: pct, fxType: 'blur', fxIntensity: 15, source: 'manual',
      }]);
      setSelectedEditId(id);
    }
    setCurrentBox(null); setActiveTool('select'); setInMarker(null); setOutMarker(null);
  };

  // ---- playback ----
  const handleTimeUpdate = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const t = e.currentTarget.currentTime;
    setCurrentTime(t);
    if (!videoRef.current) return;
    const activeCut = edits.find(ed => ed.action === 'cut' && t >= ed.start && t < ed.end);
    if (activeCut) { videoRef.current.currentTime = activeCut.end; return; }
    videoRef.current.muted = edits.some(ed => ed.action === 'bleep' && t >= ed.start && t <= ed.end);
  };
  const togglePlay = () => {
    if (!videoRef.current) return;
    videoRef.current.paused ? videoRef.current.play() : videoRef.current.pause();
  };
  // step the playhead precisely (pauses so you can land on the exact moment)
  const FRAME = 1 / 30; // ~1 frame
  const step = (delta: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    const max = duration || v.duration || 0;
    v.currentTime = Math.max(0, Math.min(max, v.currentTime + delta));
  };

  // ---- keyboard ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.code === 'KeyZ') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (mod && e.code === 'KeyY') { e.preventDefault(); redo(); return; }
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      if (e.code === 'ArrowLeft' && videoRef.current) { e.preventDefault(); videoRef.current.currentTime -= 1 / 30; }
      if (e.code === 'ArrowRight' && videoRef.current) { e.preventDefault(); videoRef.current.currentTime += 1 / 30; }
      if (e.code === 'KeyI') setInMarker(currentTime);
      if (e.code === 'KeyO') setOutMarker(currentTime);
      if (e.code === 'Backspace' || e.code === 'Delete') {
        if (selectedEditId) { commit(prev => prev.filter(ed => ed.id !== selectedEditId)); setSelectedEditId(null); }
        else if (inMarker !== null && outMarker !== null) applyManualCut();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTime, inMarker, outMarker, selectedEditId, undo, redo, commit]);

  const handleTimelineClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!timelineRef.current || !videoRef.current) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left + timelineRef.current.scrollLeft;
    const totalWidth = rect.width * zoom;
    videoRef.current.currentTime = Math.max(0, Math.min(duration, (clickX / totalWidth) * duration));
    setSelectedEditId(null);
  };

  // ---- export ----
  function buildSrt(): string {
    const real = edits.filter(e => e.id !== DEMO_EDIT_ID);
    const cuts = mergeRanges(real.filter(e => e.action === 'cut').map(e => ({ start: e.start, end: e.end })));
    const bleeps = mergeRanges(real.filter(e => e.action === 'bleep').map(e => ({ start: e.start, end: e.end })));
    return toSrt(buildSubtitleCues(segments, cuts, bleeps, removeBleeped));
  }

  function downloadText(text: string, filename: string, mime: string) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function exportTranscript() {
    setExportMenuOpen(false);
    if (!hasTranscript) { setExportState({ status: 'error', message: 'No transcript available for this media.' }); return; }
    downloadText(buildSrt(), `lucidcut_transcript_${Date.now()}.srt`, 'application/x-subrip');
    setExportState({ status: 'success', message: 'Transcript exported (.srt).' });
    setTimeout(() => setExportState(s => (s.status === 'success' ? { status: 'idle' } : s)), 5000);
  }

  async function runExport(withSubtitles: boolean) {
    setExportMenuOpen(false);
    if (!jobId) { setExportState({ status: 'error', message: 'No job ID found.' }); return; }
    const realEdits = edits.filter(e => e.id !== DEMO_EDIT_ID);
    if (realEdits.length === 0) { setExportState({ status: 'error', message: 'Add at least one edit before exporting.' }); return; }
    setExporting(true);
    setExportState({ status: 'processing', message: 'Rendering…', progress: 0 });
    submitImageryFeedback(); // capture the user's verdicts for model training on export
    try {
      const formData = new FormData();
      formData.append('edits', JSON.stringify(realEdits));
      if (withSubtitles && hasTranscript) formData.append('subtitles', buildSrt());
      const usedMediaIds = new Set(realEdits.map(e => e.customMediaId).filter(Boolean));
      usedMediaIds.forEach(mediaId => {
        const item = mediaPool.find(m => m.id === mediaId);
        if (item) formData.append('customFiles', item.file, item.id);
      });

      const res = await fetch(apiUrl(`/api/jobs/${jobId}/export`), { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'export request failed');
      if (data.status === 'ready') { await downloadResult(data.downloadUrl); return; }

      // poll export status
      for (let i = 0; i < 600; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const sres = await fetch(apiUrl(`/api/jobs/${jobId}/export-status`));
        const status = await sres.json();
        if (status.status === 'processing') {
          setExportState({ status: 'processing', message: 'Rendering...', progress: status.progress || 0 });
        } else if (status.status === 'completed') {
          await downloadResult(data.downloadUrl); return;
        } else if (status.status === 'failed') {
          throw new Error(status.error || 'render failed');
        }
      }
      throw new Error('export timed out');
    } catch (e: any) {
      setExportState({ status: 'error', message: e.message || String(e) });
    } finally {
      setExporting(false);
      setTimeout(() => setExportState(s => (s.status === 'processing' ? s : { status: 'idle' })), 5000);
    }
  }

  async function downloadResult(url: string) {
    const res = await fetch(apiUrl(url));
    if (!res.ok) {
      let detail = 'download failed';
      try { detail = (await res.json()).details || detail; } catch {}
      throw new Error(detail);
    }
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objUrl; link.download = `lucidcut_censored_${Date.now()}.${isAudio ? 'm4a' : 'mp4'}`;
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
    URL.revokeObjectURL(objUrl);
    setExportState({ status: 'success', message: 'Exported! Check your downloads.' });
  }

  const activeFx = edits.filter(e => e.action === 'blur' && currentTime >= e.start && currentTime <= e.end);
  const selectedEdit = edits.find(e => e.id === selectedEditId);
  const editCount = { cut: edits.filter(e => e.action === 'cut').length, blur: edits.filter(e => e.action === 'blur').length, bleep: edits.filter(e => e.action === 'bleep').length };

  const rulerTicks = [];
  if (duration > 0) {
    const step = duration > 600 ? 60 : duration > 120 ? 30 : 10;
    for (let i = 0; i < duration; i += step) {
      rulerTicks.push(<span key={i} className="ruler-tick" style={{ left: `${(i / duration) * 100}%` }}>{formatTimecode(i).substring(3, 8)}</span>);
    }
  }

  return (
    <div className="nle-app-container">
      <header className="nle-global-header">
        <div className="nle-logo"><Film size={18} /> LucidCut Editor</div>
        <div className="nle-header-actions" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="nle-btn secondary" onClick={undo} disabled={undoStack.current.length === 0} title="Undo (Ctrl+Z)"><Undo2 size={14} /> Undo</button>
          <button className="nle-btn secondary" onClick={redo} disabled={redoStack.current.length === 0} title="Redo (Ctrl+Shift+Z)"><Redo2 size={14} /> Redo</button>
          <button className="nle-btn secondary" onClick={() => { setSelectedEditId(null); setActiveTool('select'); setTutorialOpen(true); }} title="Tutorial"><HelpCircle size={14} /> Tutorial</button>
          <button className="nle-btn secondary" onClick={handleExit}>Exit</button>
        </div>
      </header>

      <div className="nle-upper-workspace">
        <aside className="nle-panel" data-tour="media">
          <div className="nle-panel-header">Media Pool</div>
          <div className="nle-panel-content">
            <input type="file" ref={fileInputRef} hidden multiple accept="audio/*,image/*" onChange={handleMediaUpload} />
            <div className="nle-media-dropzone" onClick={() => fileInputRef.current?.click()}>+ Upload Overlay / SFX</div>
            {mediaPool.map(f => (
              <div key={f.id} className="nle-media-item">
                <span style={{ display: 'inline-flex' }}>{f.type === 'audio' ? <Music size={14} /> : <ImageIcon size={14} />}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{f.name}</span>
              </div>
            ))}
            <div style={{ marginTop: 16, fontSize: 11, color: '#6b7280', lineHeight: 1.6 }}>
              <strong style={{ color: '#9ca3af' }}>Edits:</strong> {editCount.cut} cut · {editCount.blur} censor · {editCount.bleep} bleep
            </div>
          </div>
        </aside>

        <main className="nle-preview-panel">
          <div className="nle-monitor-wrapper">
            {!previewUrl ? (
              <div style={{ color: '#6b7280' }}>MEDIA OFFLINE</div>
            ) : isAudio ? (
              <div className="nle-audio-stage">
                <div className="nle-audio-visual">
                  {Array.from({ length: 28 }).map((_, i) => (
                    <span key={i} className={`nle-audio-bar ${isPlaying ? 'playing' : ''}`} style={{ animationDelay: `${i * 55}ms` }} />
                  ))}
                  <Music size={34} className="nle-audio-icon" />
                </div>
                <div className="nle-audio-label">Audio track</div>
                <audio
                  ref={videoRef as any} src={previewUrl} style={{ display: 'none' }}
                  onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
                  onTimeUpdate={handleTimeUpdate}
                  onPlay={() => setIsPlaying(true)} onPause={() => setIsPlaying(false)}
                />
              </div>
            ) : (
              <div className="nle-video-container" style={{ aspectRatio: `${aspectRatio}` }}
                onDoubleClick={(e) => { if (activeTool === 'select') seedBoxAtPoint(e.clientX, e.clientY); }}
                title="Double-click a paused subject to drop a box, then resize it and hit Track">
                <video
                  ref={videoRef} src={previewUrl} className="nle-video-element" crossOrigin="anonymous"
                  onLoadedMetadata={(e) => { setDuration(e.currentTarget.duration); setAspectRatio(e.currentTarget.videoWidth / e.currentTarget.videoHeight); }}
                  onTimeUpdate={handleTimeUpdate}
                  onPlay={() => setIsPlaying(true)} onPause={() => setIsPlaying(false)}
                />
                <div
                  className="nle-video-canvas" ref={canvasRef}
                  style={{ pointerEvents: activeTool === 'blur_box' ? 'auto' : 'none', cursor: activeTool === 'blur_box' ? 'crosshair' : 'default' }}
                  onMouseDown={handleCanvasMouseDown} onMouseMove={handleCanvasMouseMove}
                  onMouseUp={handleCanvasMouseUp} onMouseLeave={handleCanvasMouseUp}
                >
                  {currentBox && (
                    <div className="nle-drawn-box" style={{ left: currentBox.x, top: currentBox.y, width: currentBox.w, height: currentBox.h, borderColor: '#3b82f6' }} />
                  )}
                  {activeFx.map(fx => {
                    const dbox = boxAtTime(fx, currentTime);
                    if (!dbox) return null;
                    const assignedMedia = mediaPool.find(m => m.id === fx.customMediaId);
                    const selected = selectedEditId === fx.id;
                    const isTracked = !!fx.track; // follows a subject — not manually movable
                    return (
                      <div
                        key={fx.id}
                        className={`nle-drawn-box selectable ${isTracked ? 'tracked' : ''}`}
                        onMouseDown={(e) => { if (activeTool === 'select' && !isTracked) startBoxMove(e, fx); }}
                        style={{
                          left: `${dbox.x}%`, top: `${dbox.y}%`, width: `${dbox.w}%`, height: `${dbox.h}%`,
                          backgroundColor: fx.fxType === 'solid' ? `rgba(0,0,0,${(fx.fxIntensity || 100) / 100})` : 'rgba(124,58,237,0.18)',
                          backdropFilter: fx.fxType === 'blur' ? `blur(${fx.fxIntensity}px)` : 'none',
                          border: isTracked ? '2px solid #34d399' : selected ? '2px solid #3b82f6' : '2px dashed rgba(124,58,237,0.8)',
                          backgroundImage: assignedMedia?.type === 'image' ? `url(${assignedMedia.url})` : 'none',
                          backgroundSize: '100% 100%', backgroundRepeat: 'no-repeat',
                          pointerEvents: activeTool === 'select' ? 'auto' : 'none',
                          transition: isTracked ? 'left 80ms linear, top 80ms linear, width 80ms linear, height 80ms linear' : 'none',
                        }}
                      >
                        {(selected || isTracked) && (fx.label || isTracked) && <span className="nle-box-tag">{isTracked ? '🎯 Tracking' : fx.label}</span>}
                        {selected && fx.fxType === 'pixelate' && (
                          <div style={{ position: 'absolute', inset: 0, backgroundImage: 'repeating-linear-gradient(0deg,transparent,transparent 6px,rgba(255,255,255,0.12) 6px,rgba(255,255,255,0.12) 12px),repeating-linear-gradient(90deg,transparent,transparent 6px,rgba(255,255,255,0.12) 6px,rgba(255,255,255,0.12) 12px)' }} />
                        )}
                        {selected && !isTracked && (['nw', 'ne', 'sw', 'se'] as const).map(h => (
                          <div key={h} className={`nle-box-handle ${h}`} onMouseDown={(e) => startBoxResize(e, fx, h)} />
                        ))}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <div className="nle-transport-bar">
            <div className="nle-timecode-display current">{formatTimecode(currentTime)}</div>
            <div className="nle-transport-controls">
              <button className="nle-icon-btn" onClick={() => step(-1)} title="Back 1 second"><ChevronsLeft size={16} /></button>
              <button className="nle-icon-btn" onClick={() => step(-FRAME)} title="Back 1 frame"><ChevronLeft size={16} /></button>
              <button className="nle-icon-btn play" onClick={togglePlay}>{isPlaying ? <Pause size={16} /> : <Play size={16} />}</button>
              <button className="nle-icon-btn" onClick={() => step(FRAME)} title="Forward 1 frame"><ChevronRight size={16} /></button>
              <button className="nle-icon-btn" onClick={() => step(1)} title="Forward 1 second"><ChevronsRight size={16} /></button>
            </div>
            <div className="nle-timecode-display total">{formatTimecode(duration)}</div>
          </div>
        </main>

        <aside className="nle-panel nle-inspector" data-tour="detections">
          <div className="nle-panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>AI Detections</span>
            {imageryDetections.length > 0 && detFilter !== 'words' && (
              <button className="nle-btn sm" style={{ background: '#7c3aed', color: '#fff' }} onClick={censorAll}><Shield size={13} /> Censor All</button>
            )}
          </div>

          {results.length > 0 && (
            <div className="nle-det-filter">
              {([['all', 'All', results.length], ['imagery', 'Imagery', imageryDetections.length], ['words', 'Words', swearDetections.length]] as const).map(([key, label, count]) => (
                <button key={key} className={`nle-det-filter-btn ${detFilter === key ? 'active' : ''}`} onClick={() => setDetFilter(key)}>
                  {label} <span className="cnt">{count}</span>
                </button>
              ))}
            </div>
          )}

          <div className="nle-panel-content p-0">
            {results.length === 0 && <div style={{ padding: 16, color: '#6b7280', fontSize: 13 }}>{isAudio ? 'No detections. Use In/Out + Cut Region, or Bleep, to edit manually.' : 'No detections. Use the FX Box tool to censor manually.'}</div>}

            {detFilter !== 'words' && imageryDetections.map((det) => {
              const fa = falseAlarms.has(det.id);
              return (
              <div key={det.id} className={`nle-queue-item unsafe ${fa ? 'false-alarm' : ''}`}>
                <div className="nle-queue-header">
                  <span className="tag" style={{ color: getSeverityColor(det.severity) }}>{det.text}</span>
                  <span className="time">{det.time}</span>
                </div>
                <div className="nle-queue-meta">
                  {(det.confidence * 100).toFixed(0)}% · {det.nsfw_severity === 'hard' ? 'explicit' : 'sensitive'}
                  {det.regions && det.regions.length > 0 ? ` · ${det.regions.length} region${det.regions.length > 1 ? 's' : ''}` : ''}
                </div>
                <div className="actions">
                  <button className={`nle-action-btn censor ${isCensored(det) ? 'active' : ''}`} onClick={() => toggleCensor(det)} disabled={fa} title={isCensored(det) ? 'Click to remove censor' : 'Censor this detection'}>
                    {isCensored(det) ? <><Check size={13} /> Censored</> : <><Shield size={13} /> Censor</>}
                  </button>
                  <button className={`nle-action-btn ${isApplied(det.start, 'cut') ? 'active' : ''}`} onClick={() => toggleAiEdit(det, 'cut')} disabled={fa}>
                    {isApplied(det.start, 'cut') ? <><Check size={13} /> Cut</> : <><Scissors size={13} /> Cut</>}
                  </button>
                </div>
                <button className={`nle-falsealarm ${fa ? 'on' : ''}`} onClick={() => toggleFalseAlarm(det)}
                  title="Tell the AI this detection was wrong — improves your personalized model">
                  <Flag size={12} /> {fa ? 'Marked false alarm — thanks!' : 'False alarm?'}
                </button>
              </div>
              );
            })}

            {detFilter !== 'imagery' && swearDetections.map((det) => (
              <div key={det.id} className="nle-queue-item swear">
                <div className="nle-queue-header">
                  <span className="tag" style={{ color: getSeverityColor(det.severity) }}>{det.text}</span>
                  <span className="time">{det.time}</span>
                </div>
                <div className="actions">
                  <button className={`nle-action-btn ${isApplied(det.start, 'bleep') ? 'active' : ''}`} onClick={() => toggleAiEdit(det, 'bleep')}>
                    {isApplied(det.start, 'bleep') ? <><Check size={13} /> Bleeped</> : <><Volume2 size={13} /> Bleep</>}
                  </button>
                  <button className={`nle-action-btn ${isApplied(det.start, 'cut') ? 'active' : ''}`} onClick={() => toggleAiEdit(det, 'cut')}>
                    {isApplied(det.start, 'cut') ? <><Check size={13} /> Cut</> : <><Scissors size={13} /> Cut</>}
                  </button>
                </div>
              </div>
            ))}

            {results.length > 0 && ((detFilter === 'imagery' && imageryDetections.length === 0) || (detFilter === 'words' && swearDetections.length === 0)) && (
              <div style={{ padding: 16, color: '#6b7280', fontSize: 13 }}>No {detFilter} detections.</div>
            )}
          </div>
        </aside>
      </div>

      <div className="nle-toolbar">
        <div className="nle-tools-left">
          <button className={`nle-tool ${activeTool === 'select' ? 'active' : ''}`} onClick={() => setActiveTool('select')}><MousePointer2 size={14} /> Select</button>
          {!isAudio && (
            <button className={`nle-tool ${activeTool === 'blur_box' ? 'active' : ''}`} data-tour="fxbox" onClick={() => { setActiveTool('blur_box'); setSelectedEditId(null); }}><SquareDashed size={14} /> FX Box</button>
          )}
          <button className={`nle-tool ${snapEnabled ? 'active' : ''}`} data-tour="snap" onClick={() => setSnapEnabled(s => !s)} title="Magnetic snapping — line edits up to each other's edges">
            <Magnet size={14} /> Snap
          </button>
          <div className="nle-divider"></div>

          {selectedEdit ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(59,130,246,0.1)', padding: '4px 12px', borderRadius: 4, border: '1px solid #3b82f6' }}>
              <span style={{ fontSize: 11, color: '#3b82f6', fontWeight: 'bold' }}>Edit {selectedEdit.action}:</span>
              {!selectedEdit.track && (
                <>
                  <label className="nle-num" title="Start time (seconds)">Start
                    <input type="number" step="0.01" min="0" key={`pos-${selectedEdit.id}`} defaultValue={selectedEdit.start.toFixed(3)}
                      onChange={(e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) { const dur = selectedEdit.end - selectedEdit.start; const ns = Math.max(0, Math.min((duration || v + dur) - dur, v)); setEditTiming(selectedEdit.id, { start: ns, end: ns + dur }); } }} />
                  </label>
                  <label className="nle-num" title="Length in seconds (expands to the right; start stays put)">Length
                    <input type="number" step="0.01" min="0.05" key={`len-${selectedEdit.id}`} defaultValue={(selectedEdit.end - selectedEdit.start).toFixed(3)}
                      onChange={(e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) { const ne = Math.min(duration || (selectedEdit.start + v), selectedEdit.start + Math.max(0.05, v)); setEditTiming(selectedEdit.id, { end: ne }); } }} />
                  </label>
                </>
              )}
              {selectedEdit.action === 'blur' && (
                <>
                  <select value={selectedEdit.fxType} onChange={(e) => commit(prev => prev.map(ed => ed.id === selectedEditId ? { ...ed, fxType: e.target.value as FxType } : ed))} style={selectStyle}>
                    <option value="blur">Blur</option>
                    <option value="pixelate">Pixelate</option>
                    <option value="solid">Solid Bar</option>
                  </select>
                  <input type="range" min="1" max="100" value={selectedEdit.fxIntensity} onChange={(e) => commit(prev => prev.map(ed => ed.id === selectedEditId ? { ...ed, fxIntensity: Number(e.target.value) } : ed))} style={{ width: 60 }} />
                  <select value={selectedEdit.customMediaId || ''} onChange={(e) => assignMediaToEdit(e.target.value || undefined)} style={selectStyle}>
                    <option value="">No Overlay Image</option>
                    {mediaPool.filter(m => m.type === 'image').map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </>
              )}
              {selectedEdit.action === 'bleep' && (
                <select value={selectedEdit.customMediaId || ''} onChange={(e) => assignMediaToEdit(e.target.value || undefined)} style={selectStyle}>
                  <option value="">Default Mute</option>
                  {mediaPool.filter(m => m.type === 'audio').map(m => <option key={m.id} value={m.id}>Play: {m.name}</option>)}
                </select>
              )}
              {selectedEdit.action === 'blur' && !isAudio && !selectedEdit.track && (
                <button className="nle-btn sm" style={{ background: '#0d9488', color: '#fff' }}
                  onClick={() => trackEdit(selectedEdit)} disabled={tracking}
                  title="Follow this subject through the scene">
                  {tracking ? <><Loader2 size={13} className="lc-spin" /> Tracking…</> : <><Crosshair size={13} /> Track</>}
                </button>
              )}
              {selectedEdit.action === 'blur' && selectedEdit.track && (
                <button className="nle-btn sm outline" onClick={() => untrackEdit(selectedEdit.id)} title="Stop following — back to a fixed, resizable box"><XCircle size={13} /> Untrack</button>
              )}
              {selectedEdit.action === 'blur' && selectedEdit.source !== 'ai' && !isAudio && (
                <button className="nle-btn sm" style={{ background: '#7c3aed', color: '#fff' }}
                  onClick={() => teachAsPositive(selectedEdit)} disabled={flaggedPositives.has(selectedEdit.id)}
                  title="Tell the AI this should have been flagged — adds a training example">
                  {flaggedPositives.has(selectedEdit.id) ? <><Check size={13} /> Taught AI</> : <><Brain size={13} /> Should've been flagged</>}
                </button>
              )}
              <button className="nle-btn sm outline" onClick={() => { commit(prev => prev.filter(e => e.id !== selectedEditId)); setSelectedEditId(null); }}><Trash2 size={13} /> Remove</button>
            </div>
          ) : (
            <span className="nle-manual-group" data-tour="manual" style={{ display: 'inline-flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="nle-tool" onClick={() => setInMarker(currentTime)}><MapPin size={14} /> In (I)</button>
              <button className="nle-tool" onClick={() => setOutMarker(currentTime)}><MapPin size={14} /> Out (O)</button>
              <button className="nle-tool danger" onClick={applyManualCut} disabled={inMarker === null || outMarker === null}><Scissors size={14} /> Cut Region</button>
              <button className="nle-tool" onClick={applyManualBleep} disabled={inMarker === null || outMarker === null}><Volume2 size={14} /> Bleep Region</button>
            </span>
          )}
        </div>

        <div className="nle-tools-right">
          <span className="zoom-label" data-tour="zoom">Zoom</span>
          <input type="range" min="1" max="10" step="0.1" value={zoom} onChange={(e) => setZoom(parseFloat(e.target.value))} className="nle-zoom-slider" />
          <div className="nle-divider"></div>
          <div className="nle-export-wrap" data-tour="export">
            <button className="nle-btn primary" onClick={() => setExportMenuOpen(o => !o)} disabled={exporting} title="Export">
              {exporting
                ? <><Loader2 size={14} className="lc-spin" /></>
                : <><Download size={14} /> Export <ChevronUp size={13} style={{ opacity: 0.8 }} /></>}
            </button>
            {exportMenuOpen && !exporting && (
              <>
                <div className="nle-export-backdrop" onClick={() => setExportMenuOpen(false)} />
                <div className="nle-export-menu">
                  <div className="nle-export-title">Export as</div>
                  <button className="nle-export-opt" onClick={() => runExport(false)}>
                    {isAudio ? <Music size={15} /> : <Film size={15} />}
                    <span>{isAudio ? 'Audio' : 'Video'}</span>
                  </button>
                  {!isAudio && (
                    <button className="nle-export-opt" onClick={() => runExport(true)} disabled={!hasTranscript}>
                      <Captions size={15} />
                      <span>Video + subtitles{!hasTranscript && ' (no transcript)'}</span>
                    </button>
                  )}
                  <button className="nle-export-opt" onClick={exportTranscript} disabled={!hasTranscript}>
                    <FileText size={15} />
                    <span>Transcript (.srt){!hasTranscript && ' (none)'}</span>
                  </button>
                  <label className={`nle-export-check ${!hasTranscript ? 'disabled' : ''}`}>
                    <input type="checkbox" checked={removeBleeped} disabled={!hasTranscript}
                      onChange={(e) => setRemoveBleeped(e.target.checked)} />
                    <span>Remove bleeped words from subtitles</span>
                  </label>
                  <div className="nle-export-note">Cuts are always synced to the subtitles.</div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="nle-timeline-workspace" data-tour="timeline">
        <div className="nle-track-headers">
          <div className="nle-track-header ruler-header"></div>
          <div className="nle-track-header video-header"><span>{isAudio ? 'Track' : 'Video'}</span></div>
          {!isAudio && <div className="nle-track-header ai-header"><span>FX</span></div>}
          <div className="nle-track-header audio-header"><span>Audio</span></div>
        </div>

        <div className="nle-tracks-viewport" ref={timelineRef} onClick={handleTimelineClick}>
          <div className="nle-tracks-container" style={{ width: `${zoom * 100}%` }}>
            <div className="nle-time-ruler" onMouseDown={(e) => { setScrubbing(true); applyScrub(e.clientX); }}>
              {rulerTicks}
              {duration > 0 && results.map(d => (
                <div key={`m-${d.id}`} className="nle-det-marker" title={`${d.text} @ ${d.time}`}
                  style={{ left: `${(d.start / duration) * 100}%`, width: `${((d.end - d.start) / duration) * 100}%`, background: d.type === 'unsafe' ? '#7c3aed' : '#f59e0b' }} />
              ))}
            </div>

            {inMarker !== null && <div className="nle-marker-flag" style={{ left: `${(inMarker / duration) * 100}%` }} />}
            {outMarker !== null && <div className="nle-marker-flag out" style={{ left: `${(outMarker / duration) * 100}%` }} />}
            {inMarker !== null && outMarker !== null && (
              <div className="nle-selection-overlay" style={{ left: `${(Math.min(inMarker, outMarker) / duration) * 100}%`, width: `${(Math.abs(outMarker - inMarker) / duration) * 100}%` }} />
            )}

            {duration > 0 && (
              <div className="nle-playhead" style={{ left: `${(currentTime / duration) * 100}%` }}>
                <div className="nle-playhead-head" onMouseDown={(e) => { e.stopPropagation(); setScrubbing(true); }}></div>
                <div className="nle-playhead-line"></div>
              </div>
            )}

            <div className="nle-track lane-video">
              <div className="nle-clip base" style={{ left: '0%', width: '100%' }}><span className="label">Main Video</span></div>
              {edits.filter(e => e.action === 'cut').map(cut => (
                <div key={cut.id} className={`nle-clip ${selectedEditId === cut.id ? 'selected' : ''}`} onClick={(e) => { e.stopPropagation(); setSelectedEditId(cut.id); }} onMouseDown={(e) => startClipMove(e, cut)}
                  style={{ left: `${(cut.start / duration) * 100}%`, width: `${((cut.end - cut.start) / duration) * 100}%`, background: '#09090b', border: '1px solid #ef4444', zIndex: 10 }}>
                  <div className="nle-clip-handle left" onMouseDown={(e) => { e.stopPropagation(); setTimelineResizing({ id: cut.id, edge: 'left' }); }} />
                  <span className="label" style={{ color: '#ef4444' }}>CUT</span>
                  <div className="nle-clip-handle right" onMouseDown={(e) => { e.stopPropagation(); setTimelineResizing({ id: cut.id, edge: 'right' }); }} />
                </div>
              ))}
            </div>

            {!isAudio && <div className="nle-track lane-ai">
              {edits.filter(e => e.action === 'blur').map(fx => {
                const assignedMedia = mediaPool.find(m => m.id === fx.customMediaId);
                const name = fx.track ? 'Tracked' : assignedMedia ? assignedMedia.name : fx.fxType === 'solid' ? 'Solid Bar' : fx.fxType === 'pixelate' ? 'Pixelate' : 'Blur';
                return (
                  <div key={fx.id} className={`nle-clip fx ${selectedEditId === fx.id ? 'selected' : ''}`}
                    style={{ left: `${(fx.start / duration) * 100}%`, width: `${((fx.end - fx.start) / duration) * 100}%` }}
                    onClick={(e) => { e.stopPropagation(); setSelectedEditId(fx.id); }} onMouseDown={(e) => startClipMove(e, fx)}>
                    <div className="nle-clip-handle left" onMouseDown={(e) => { e.stopPropagation(); setTimelineResizing({ id: fx.id, edge: 'left' }); }} />
                    <span className="label">{fx.source === 'ai' && <Shield size={11} style={{ verticalAlign: '-2px', marginRight: 3 }} />}{name}</span>
                    <div className="nle-clip-handle right" onMouseDown={(e) => { e.stopPropagation(); setTimelineResizing({ id: fx.id, edge: 'right' }); }} />
                  </div>
                );
              })}
            </div>}

            <div className="nle-track lane-audio">
              <div className="nle-clip base" style={{ left: '0%', width: '100%' }}><span className="label">Main Audio</span></div>
              {edits.filter(e => e.action === 'bleep').map(bleep => {
                const assignedMedia = mediaPool.find(m => m.id === bleep.customMediaId);
                const isDemo = bleep.id === DEMO_EDIT_ID;
                return (
                  <div key={bleep.id} className={`nle-clip swear ${isDemo ? 'tour-demo' : ''} ${selectedEditId === bleep.id ? 'selected' : ''}`}
                    style={{ left: `${(bleep.start / duration) * 100}%`, width: `${((bleep.end - bleep.start) / duration) * 100}%`, zIndex: isDemo ? 25 : 10 }}
                    onClick={(e) => { e.stopPropagation(); setSelectedEditId(bleep.id); }} onMouseDown={(e) => startClipMove(e, bleep)}>
                    <div className="nle-clip-handle left" onMouseDown={(e) => { e.stopPropagation(); setTimelineResizing({ id: bleep.id, edge: 'left' }); }} />
                    <span className="label">{isDemo ? '⟷ drag me' : assignedMedia ? assignedMedia.name : 'MUTED'}</span>
                    <div className="nle-clip-handle right" onMouseDown={(e) => { e.stopPropagation(); setTimelineResizing({ id: bleep.id, edge: 'right' }); }} />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {hbar.show && (
        <div className="nle-hscroll" title="Scroll the timeline">
          <div className="nle-hscroll-thumb" style={{ left: `${hbar.left}%`, width: `${hbar.width}%` }} onMouseDown={startHbarDrag} />
        </div>
      )}

      {exportState.status !== 'idle' && (
        <div className={`nle-export-banner ${exportState.status}`} style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center' }}>
          {exportState.status === 'processing' && <><Loader2 size={15} className="lc-spin" /> {exportState.message} {exportState.progress ? `(${exportState.progress}%)` : ''}</>}
          {exportState.status === 'success' && <><CheckCircle2 size={15} /> {exportState.message}</>}
          {exportState.status === 'error' && <><XCircle size={15} /> Export failed: {exportState.message}</>}
        </div>
      )}

      <EditorTutorial open={tutorialOpen} onClose={() => { setTutorialOpen(false); setTourDemo(false); }} isAudio={isAudio} onDemo={setTourDemo} />

      <ConfirmModal
        open={confirmExit}
        danger
        title="Discard this project?"
        message={<>Exiting will close this session and <strong>discard all your edits</strong>. This can't be undone.</>}
        confirmLabel="Discard & Exit"
        cancelLabel="Keep Editing"
        onConfirm={() => { submitImageryFeedback(); setConfirmExit(false); onBack(); }}
        onCancel={() => setConfirmExit(false)}
      />

      <ConfirmModal
        open={!!pendingTrack}
        title="Heads up — modest hardware"
        message={<>This machine ({capRef.current?.cores || '?'} cores, {capRef.current?.memGB || '?'} GB) may make subject tracking slow or less reliable. Want to try it anyway?</>}
        confirmLabel="Track anyway"
        cancelLabel="Cancel"
        onConfirm={() => { trackWarnedRef.current = true; const e = pendingTrack; setPendingTrack(null); if (e) runTrack(e); }}
        onCancel={() => setPendingTrack(null)}
      />
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  background: '#1c1f26', color: '#e6eef8', border: '1px solid #3a3f4a', borderRadius: 6,
  fontSize: 11, padding: '0 8px', height: 28, cursor: 'pointer', outline: 'none', fontWeight: 600,
};
