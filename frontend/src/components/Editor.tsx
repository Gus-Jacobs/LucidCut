import { useState, useRef, useEffect, useCallback } from 'react';
import './Editor.css';
import { apiUrl } from '../utils/api';
import type { Detection, BoxCoords } from '../types';

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

export default function Editor({ jobId, results = [], previewUrl, onBack }: Props) {
  const [aspectRatio, setAspectRatio] = useState<number>(16 / 9);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [exporting, setExporting] = useState(false);
  const [exportState, setExportState] = useState<ExportState>({ status: 'idle' });

  const [edits, setEditsRaw] = useState<TimelineEdit[]>([]);
  const undoStack = useRef<TimelineEdit[][]>([]);
  const redoStack = useRef<TimelineEdit[][]>([]);

  const [activeTool, setActiveTool] = useState<'select' | 'blur_box'>('select');
  const [inMarker, setInMarker] = useState<number | null>(null);
  const [outMarker, setOutMarker] = useState<number | null>(null);
  const [selectedEditId, setSelectedEditId] = useState<string | null>(null);

  const [timelineResizing, setTimelineResizing] = useState<{ id: string; edge: 'left' | 'right' } | null>(null);
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

  // ---- AI detection helpers ----
  const imageryDetections = results.filter(r => r.type === 'unsafe');
  const swearDetections = results.filter(r => r.type === 'swear');

  const isApplied = (start: number, action: string) =>
    edits.some(e => Math.abs(e.start - start) < 0.001 && e.action === action);

  const toggleAiEdit = (det: Detection, action: 'bleep' | 'cut') => {
    if (det.start === undefined || det.end === undefined) return;
    commit(prev => {
      const existing = prev.findIndex(e => Math.abs(e.start - det.start) < 0.001 && e.action === action && e.source === 'ai');
      if (existing >= 0) return prev.filter((_, i) => i !== existing);
      return [...prev, { id: `ai-${action}-${det.id}-${Date.now()}`, action, start: det.start, end: det.end, source: 'ai', label: det.text }];
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
      const kept = prev.filter(e => !(e.source === 'ai' && e.action === 'blur' && e.id.includes(det.id)));
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
    imageryDetections.forEach(det => censorDetection(det, 'pixelate'));
  };

  const isCensored = (det: Detection) =>
    edits.some(e => e.action === 'blur' && e.id.includes(det.id));

  const applyManualCut = () => {
    if (inMarker === null || outMarker === null) return;
    const start = Math.min(inMarker, outMarker);
    const end = Math.max(inMarker, outMarker);
    commit(prev => [...prev, { id: `man-cut-${Date.now()}`, action: 'cut', start, end, source: 'manual' }]);
    setInMarker(null); setOutMarker(null); setActiveTool('select');
  };

  // ---- timeline edge resize ----
  useEffect(() => {
    if (!timelineResizing) return;
    const onMove = (e: MouseEvent) => {
      if (!timelineRef.current) return;
      const rect = timelineRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left + timelineRef.current.scrollLeft;
      const totalWidth = rect.width * zoom;
      let newTime = Math.max(0, Math.min(duration, (x / totalWidth) * duration));
      const snap = duration * 0.015;
      if (Math.abs(newTime - currentTime) < snap) newTime = currentTime;
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
  }, [timelineResizing, duration, zoom, currentTime]);

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
  async function exportEdited() {
    if (!jobId) { setExportState({ status: 'error', message: 'No job ID found.' }); return; }
    if (edits.length === 0) { setExportState({ status: 'error', message: 'Add at least one edit before exporting.' }); return; }
    setExporting(true);
    setExportState({ status: 'processing', message: 'Rendering...', progress: 0 });
    try {
      const formData = new FormData();
      formData.append('edits', JSON.stringify(edits));
      const usedMediaIds = new Set(edits.map(e => e.customMediaId).filter(Boolean));
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
    link.href = objUrl; link.download = `lucidcut_censored_${Date.now()}.mp4`;
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
        <div className="nle-logo">🎬 LucidCut Editor</div>
        <div className="nle-header-actions" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="nle-btn secondary" onClick={undo} disabled={undoStack.current.length === 0} title="Undo (⌘Z)">↶ Undo</button>
          <button className="nle-btn secondary" onClick={redo} disabled={redoStack.current.length === 0} title="Redo (⌘⇧Z)">↷ Redo</button>
          <button className="nle-btn secondary" onClick={onBack}>Exit</button>
        </div>
      </header>

      <div className="nle-upper-workspace">
        <aside className="nle-panel">
          <div className="nle-panel-header">Media Pool</div>
          <div className="nle-panel-content">
            <input type="file" ref={fileInputRef} hidden multiple accept="audio/*,image/*" onChange={handleMediaUpload} />
            <div className="nle-media-dropzone" onClick={() => fileInputRef.current?.click()}>+ Upload Overlay / SFX</div>
            {mediaPool.map(f => (
              <div key={f.id} className="nle-media-item">
                <span>{f.type === 'audio' ? '🎵' : '🖼️'}</span>
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
            {previewUrl ? (
              <div className="nle-video-container" style={{ aspectRatio: `${aspectRatio}` }}>
                <video
                  ref={videoRef} src={previewUrl} className="nle-video-element"
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
                    if (!fx.box) return null;
                    const assignedMedia = mediaPool.find(m => m.id === fx.customMediaId);
                    const selected = selectedEditId === fx.id;
                    return (
                      <div
                        key={fx.id}
                        className={`nle-drawn-box selectable`}
                        onMouseDown={(e) => activeTool === 'select' && startBoxMove(e, fx)}
                        style={{
                          left: `${fx.box.x}%`, top: `${fx.box.y}%`, width: `${fx.box.w}%`, height: `${fx.box.h}%`,
                          backgroundColor: fx.fxType === 'solid' ? `rgba(0,0,0,${(fx.fxIntensity || 100) / 100})` : 'rgba(124,58,237,0.18)',
                          backdropFilter: fx.fxType === 'blur' ? `blur(${fx.fxIntensity}px)` : 'none',
                          border: selected ? '2px solid #3b82f6' : '2px dashed rgba(124,58,237,0.8)',
                          backgroundImage: assignedMedia?.type === 'image' ? `url(${assignedMedia.url})` : 'none',
                          backgroundSize: '100% 100%', backgroundRepeat: 'no-repeat',
                          pointerEvents: activeTool === 'select' ? 'auto' : 'none',
                        }}
                      >
                        {selected && fx.label && <span className="nle-box-tag">{fx.label}</span>}
                        {selected && fx.fxType === 'pixelate' && (
                          <div style={{ position: 'absolute', inset: 0, backgroundImage: 'repeating-linear-gradient(0deg,transparent,transparent 6px,rgba(255,255,255,0.12) 6px,rgba(255,255,255,0.12) 12px),repeating-linear-gradient(90deg,transparent,transparent 6px,rgba(255,255,255,0.12) 6px,rgba(255,255,255,0.12) 12px)' }} />
                        )}
                        {selected && (['nw', 'ne', 'sw', 'se'] as const).map(h => (
                          <div key={h} className={`nle-box-handle ${h}`} onMouseDown={(e) => startBoxResize(e, fx, h)} />
                        ))}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (<div style={{ color: '#6b7280' }}>MEDIA OFFLINE</div>)}
          </div>

          <div className="nle-transport-bar">
            <div className="nle-timecode-display current">{formatTimecode(currentTime)}</div>
            <div className="nle-transport-controls">
              <button className="nle-icon-btn play" onClick={togglePlay}>{isPlaying ? '⏸' : '▶️'}</button>
            </div>
            <div className="nle-timecode-display total">{formatTimecode(duration)}</div>
          </div>
        </main>

        <aside className="nle-panel nle-inspector">
          <div className="nle-panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>AI Detections</span>
            {imageryDetections.length > 0 && (
              <button className="nle-btn sm" style={{ background: '#7c3aed', color: '#fff' }} onClick={censorAll}>🛡️ Censor All</button>
            )}
          </div>
          <div className="nle-panel-content p-0">
            {results.length === 0 && <div style={{ padding: 16, color: '#6b7280', fontSize: 13 }}>No detections. Use the FX Box tool to censor manually.</div>}

            {imageryDetections.map((det) => (
              <div key={det.id} className="nle-queue-item unsafe">
                <div className="nle-queue-header">
                  <span className="tag" style={{ color: getSeverityColor(det.severity) }}>{det.text}</span>
                  <span className="time">{det.time}</span>
                </div>
                <div className="nle-queue-meta">
                  {(det.confidence * 100).toFixed(0)}% · {det.nsfw_severity === 'hard' ? 'explicit' : 'sensitive'}
                  {det.regions && det.regions.length > 0 ? ` · ${det.regions.length} region${det.regions.length > 1 ? 's' : ''}` : ''}
                </div>
                <div className="actions">
                  <button className={`nle-action-btn censor ${isCensored(det) ? 'active' : ''}`} onClick={() => censorDetection(det, 'pixelate')}>
                    {isCensored(det) ? '✓ Censored' : '🛡️ Censor'}
                  </button>
                  <button className={`nle-action-btn ${isApplied(det.start, 'cut') ? 'active' : ''}`} onClick={() => toggleAiEdit(det, 'cut')}>
                    {isApplied(det.start, 'cut') ? '✓ Cut' : '✂️ Cut'}
                  </button>
                </div>
              </div>
            ))}

            {swearDetections.map((det) => (
              <div key={det.id} className="nle-queue-item swear">
                <div className="nle-queue-header">
                  <span className="tag" style={{ color: getSeverityColor(det.severity) }}>{det.text}</span>
                  <span className="time">{det.time}</span>
                </div>
                <div className="actions">
                  <button className={`nle-action-btn ${isApplied(det.start, 'bleep') ? 'active' : ''}`} onClick={() => toggleAiEdit(det, 'bleep')}>
                    {isApplied(det.start, 'bleep') ? '✓ Bleeped' : '🔊 Bleep'}
                  </button>
                  <button className={`nle-action-btn ${isApplied(det.start, 'cut') ? 'active' : ''}`} onClick={() => toggleAiEdit(det, 'cut')}>
                    {isApplied(det.start, 'cut') ? '✓ Cut' : '✂️ Cut'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </aside>
      </div>

      <div className="nle-toolbar">
        <div className="nle-tools-left">
          <button className={`nle-tool ${activeTool === 'select' ? 'active' : ''}`} onClick={() => setActiveTool('select')}>↖ Select</button>
          <button className={`nle-tool ${activeTool === 'blur_box' ? 'active' : ''}`} onClick={() => { setActiveTool('blur_box'); setSelectedEditId(null); }}>🌫️ FX Box</button>
          <div className="nle-divider"></div>

          {selectedEdit ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(59,130,246,0.1)', padding: '4px 12px', borderRadius: 4, border: '1px solid #3b82f6' }}>
              <span style={{ fontSize: 11, color: '#3b82f6', fontWeight: 'bold' }}>Edit {selectedEdit.action}:</span>
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
              <button className="nle-btn sm outline" onClick={() => { commit(prev => prev.filter(e => e.id !== selectedEditId)); setSelectedEditId(null); }}>🗑 Remove</button>
            </div>
          ) : (
            <>
              <button className="nle-tool" onClick={() => setInMarker(currentTime)}>📍 In (I)</button>
              <button className="nle-tool" onClick={() => setOutMarker(currentTime)}>📍 Out (O)</button>
              <button className="nle-tool danger" onClick={applyManualCut} disabled={inMarker === null || outMarker === null}>✂️ Cut Region</button>
            </>
          )}
        </div>

        <div className="nle-tools-right">
          <span className="zoom-label">Zoom</span>
          <input type="range" min="1" max="10" step="0.1" value={zoom} onChange={(e) => setZoom(parseFloat(e.target.value))} className="nle-zoom-slider" />
          <div className="nle-divider"></div>
          <button className="nle-btn primary" onClick={exportEdited} disabled={exporting}>
            {exporting ? '⏳ Rendering...' : '💾 Export Final Video'}
          </button>
        </div>
      </div>

      <div className="nle-timeline-workspace">
        <div className="nle-track-headers">
          <div className="nle-track-header ruler-header"></div>
          <div className="nle-track-header video-header"><span>Video</span></div>
          <div className="nle-track-header ai-header"><span>FX</span></div>
          <div className="nle-track-header audio-header"><span>Audio</span></div>
        </div>

        <div className="nle-tracks-viewport" ref={timelineRef} onClick={handleTimelineClick}>
          <div className="nle-tracks-container" style={{ width: `${zoom * 100}%` }}>
            <div className="nle-time-ruler">
              {rulerTicks}
              {duration > 0 && results.map(d => (
                <div key={`m-${d.id}`} className="nle-det-marker" title={`${d.text} @ ${d.time}`}
                  style={{ left: `${(d.start / duration) * 100}%`, width: `${Math.max(0.3, ((d.end - d.start) / duration) * 100)}%`, background: d.type === 'unsafe' ? '#7c3aed' : '#f59e0b' }} />
              ))}
            </div>

            {inMarker !== null && <div className="nle-marker-flag" style={{ left: `${(inMarker / duration) * 100}%` }} />}
            {outMarker !== null && <div className="nle-marker-flag out" style={{ left: `${(outMarker / duration) * 100}%` }} />}
            {inMarker !== null && outMarker !== null && (
              <div className="nle-selection-overlay" style={{ left: `${(Math.min(inMarker, outMarker) / duration) * 100}%`, width: `${(Math.abs(outMarker - inMarker) / duration) * 100}%` }} />
            )}

            {duration > 0 && (
              <div className="nle-playhead" style={{ left: `${(currentTime / duration) * 100}%` }}>
                <div className="nle-playhead-head"></div>
                <div className="nle-playhead-line"></div>
              </div>
            )}

            <div className="nle-track lane-video">
              <div className="nle-clip base" style={{ left: '0%', width: '100%' }}><span className="label">Main Video</span></div>
              {edits.filter(e => e.action === 'cut').map(cut => (
                <div key={cut.id} className={`nle-clip ${selectedEditId === cut.id ? 'selected' : ''}`} onClick={(e) => { e.stopPropagation(); setSelectedEditId(cut.id); }}
                  style={{ left: `${(cut.start / duration) * 100}%`, width: `${((cut.end - cut.start) / duration) * 100}%`, background: '#09090b', border: '1px solid #ef4444', zIndex: 10 }}>
                  <div className="nle-clip-handle left" onMouseDown={(e) => { e.stopPropagation(); setTimelineResizing({ id: cut.id, edge: 'left' }); }} />
                  <span className="label" style={{ color: '#ef4444' }}>CUT</span>
                  <div className="nle-clip-handle right" onMouseDown={(e) => { e.stopPropagation(); setTimelineResizing({ id: cut.id, edge: 'right' }); }} />
                </div>
              ))}
            </div>

            <div className="nle-track lane-ai">
              {edits.filter(e => e.action === 'blur').map(fx => {
                const assignedMedia = mediaPool.find(m => m.id === fx.customMediaId);
                const name = assignedMedia ? assignedMedia.name : fx.fxType === 'solid' ? 'Solid Bar' : fx.fxType === 'pixelate' ? 'Pixelate' : 'Blur';
                return (
                  <div key={fx.id} className={`nle-clip fx ${selectedEditId === fx.id ? 'selected' : ''}`}
                    style={{ left: `${(fx.start / duration) * 100}%`, width: `${Math.max(0.5, ((fx.end - fx.start) / duration) * 100)}%` }}
                    onClick={(e) => { e.stopPropagation(); setSelectedEditId(fx.id); }}>
                    <div className="nle-clip-handle left" onMouseDown={(e) => { e.stopPropagation(); setTimelineResizing({ id: fx.id, edge: 'left' }); }} />
                    <span className="label">{fx.source === 'ai' ? '🛡️ ' : ''}{name}</span>
                    <div className="nle-clip-handle right" onMouseDown={(e) => { e.stopPropagation(); setTimelineResizing({ id: fx.id, edge: 'right' }); }} />
                  </div>
                );
              })}
            </div>

            <div className="nle-track lane-audio">
              <div className="nle-clip base" style={{ left: '0%', width: '100%' }}><span className="label">Main Audio</span></div>
              {edits.filter(e => e.action === 'bleep').map(bleep => {
                const assignedMedia = mediaPool.find(m => m.id === bleep.customMediaId);
                return (
                  <div key={bleep.id} className={`nle-clip swear ${selectedEditId === bleep.id ? 'selected' : ''}`}
                    style={{ left: `${(bleep.start / duration) * 100}%`, width: `${Math.max(0.5, ((bleep.end - bleep.start) / duration) * 100)}%`, zIndex: 10 }}
                    onClick={(e) => { e.stopPropagation(); setSelectedEditId(bleep.id); }}>
                    <div className="nle-clip-handle left" onMouseDown={(e) => { e.stopPropagation(); setTimelineResizing({ id: bleep.id, edge: 'left' }); }} />
                    <span className="label">{assignedMedia ? assignedMedia.name : 'MUTED'}</span>
                    <div className="nle-clip-handle right" onMouseDown={(e) => { e.stopPropagation(); setTimelineResizing({ id: bleep.id, edge: 'right' }); }} />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {exportState.status !== 'idle' && (
        <div className={`nle-export-banner ${exportState.status}`}>
          {exportState.status === 'processing' && `⏳ ${exportState.message} ${exportState.progress ? `(${exportState.progress}%)` : ''}`}
          {exportState.status === 'success' && `✅ ${exportState.message}`}
          {exportState.status === 'error' && `❌ Export failed: ${exportState.message}`}
        </div>
      )}
    </div>
  );
}

const selectStyle: React.CSSProperties = { background: '#000', color: '#fff', border: '1px solid #3f3f46', borderRadius: 4, fontSize: 11, padding: '2px 4px' };
