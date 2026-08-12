import { secondsToTimecode, type Detection } from '../types'

// Build the editor's Detection[] from a raw results.json payload.
// Used after parsing AND when restoring a saved project from Recents, so the two
// paths always produce identical detection objects (ids must stay stable:
// `prof-<i>` / `unsafe-<i>` — the latter maps to saved training crops).
export function buildDetections(data: any): Detection[] {
  const profanity: Detection[] = (data?.profanity_detections || []).map((m: any, idx: number) => ({
    id: `prof-${idx}`,
    type: 'swear' as const,
    time: secondsToTimecode(m.start || 0),
    text: m.word,
    severity: m.severity,
    confidence: m.confidence ?? 1,
    start: m.start || 0,
    end: m.end || 0,
  }))

  const imagery: Detection[] = (data?.imagery_detections || []).map((u: any, idx: number) => {
    const severity = u.severity === 'hard' ? 5 : 3
    const regionLabels = (u.regions || []).map((r: any) => r.label)
    const uniqueLabels = Array.from(new Set(regionLabels))
    const label = uniqueLabels.length
      ? uniqueLabels.join(', ')
      : (u.severity === 'hard' ? 'Explicit content' : 'Sensitive content')
    return {
      id: `unsafe-${idx}`,
      type: 'unsafe' as const,
      time: secondsToTimecode(u.start || 0),
      text: label,
      severity,
      confidence: u.confidence ?? u.max_confidence ?? 0,
      start: u.start || 0,
      end: u.end || 0,
      nsfw_severity: u.severity,
      regions: u.regions || [],
      bbox: u.bbox,
    }
  })

  return [...profanity, ...imagery].sort((a, b) => a.start - b.start)
}
