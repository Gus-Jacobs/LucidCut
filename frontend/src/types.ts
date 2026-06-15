// Shared detection types flowing from the worker -> parsing -> review -> editor.

export type BoxCoords = { x: number; y: number; w: number; h: number }

// A single censorable region within an imagery detection, in percent coords.
export type DetectionRegion = {
  class: string
  label: string
  category: 'explicit' | 'revealing' | 'suggestive'
  score: number
  box: BoxCoords
  track?: { t: number; box: BoxCoords }[]
}

export type Detection = {
  id: string
  type: 'swear' | 'unsafe'
  time: string
  text: string
  start: number
  end: number
  confidence: number
  severity?: number
  // imagery-only
  nsfw_severity?: 'hard' | 'soft'
  regions?: DetectionRegion[]
  bbox?: BoxCoords
}

export function secondsToTimecode(s: number): string {
  const sec = Math.floor(s % 60).toString().padStart(2, '0')
  const min = Math.floor((s / 60) % 60).toString().padStart(2, '0')
  const hrs = Math.floor(s / 3600).toString().padStart(2, '0')
  return `${hrs}:${min}:${sec}`
}
