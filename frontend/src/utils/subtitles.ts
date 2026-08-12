// Build subtitles/transcript that follow the editor's cuts and bleeps so the
// exported text always matches the exported media (no leftover or desynced lines).

export type Word = { word: string; start: number; end: number }
export type Segment = { start: number; end: number; text: string; words?: Word[] }
export type Cue = { start: number; end: number; text: string }
export type Range = { start: number; end: number }

/** Merge overlapping/adjacent ranges into a sorted, non-overlapping list. */
export function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].filter(r => r.end > r.start).sort((a, b) => a.start - b.start)
  const out: Range[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r.start <= last.end + 0.001) last.end = Math.max(last.end, r.end)
    else out.push({ ...r })
  }
  return out
}

/** Map an original timestamp to the post-cut (edited) timeline. null = inside a cut. */
function mapTime(t: number, cuts: Range[]): number | null {
  let shift = 0
  for (const c of cuts) {
    if (t >= c.end) shift += c.end - c.start
    else if (t > c.start) return null // falls inside a removed range
    else break
  }
  return Math.max(0, t - shift)
}

const overlaps = (s: number, e: number, ranges: Range[]) =>
  ranges.some(r => s < r.end && e > r.start)

/**
 * Turn Whisper segments into cues on the edited timeline.
 * - cuts are ALWAYS applied (drop removed content, shift later content earlier).
 * - when removeBleeped, words overlapping a bleep range are dropped.
 */
export function buildSubtitleCues(
  segments: Segment[], cuts: Range[], bleeps: Range[], removeBleeped: boolean,
): Cue[] {
  const cues: Cue[] = []

  for (const seg of segments) {
    const words = seg.words && seg.words.length ? seg.words : null
    if (words) {
      const kept: Word[] = []
      for (const w of words) {
        const mid = (w.start + w.end) / 2
        if (mapTime(mid, cuts) === null) continue
        if (removeBleeped && overlaps(w.start, w.end, bleeps)) continue
        kept.push(w)
      }
      if (!kept.length) continue
      const s = mapTime(kept[0].start, cuts)
      const e = mapTime(kept[kept.length - 1].end, cuts)
      if (s === null || e === null) continue
      const text = kept.map(w => w.word).join('').trim()
      if (text) cues.push({ start: s, end: Math.max(e, s + 0.4), text })
    } else {
      const mid = (seg.start + seg.end) / 2
      if (mapTime(mid, cuts) === null) continue
      if (removeBleeped && overlaps(seg.start, seg.end, bleeps)) continue
      const s = mapTime(seg.start, cuts)
      const e = mapTime(seg.end, cuts)
      if (s === null || e === null || !seg.text) continue
      cues.push({ start: s, end: Math.max(e, s + 0.4), text: seg.text })
    }
  }

  // keep cues monotonic / non-overlapping for well-behaved players
  cues.sort((a, b) => a.start - b.start)
  for (let i = 1; i < cues.length; i++) {
    if (cues[i].start < cues[i - 1].end) cues[i - 1].end = Math.max(cues[i - 1].start + 0.2, cues[i].start)
  }
  return cues
}

function fmt(t: number): string {
  if (!isFinite(t) || t < 0) t = 0
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = Math.floor(t % 60)
  const ms = Math.min(999, Math.floor((t - Math.floor(t)) * 1000))
  const p = (n: number, l = 2) => String(n).padStart(l, '0')
  return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`
}

export function toSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${fmt(c.start)} --> ${fmt(c.end)}\n${c.text}`).join('\n\n') + '\n'
}
