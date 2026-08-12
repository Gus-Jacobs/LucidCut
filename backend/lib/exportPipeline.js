'use strict'

/**
 * Pure construction of the ffmpeg export command.
 *
 * Everything here returns argv arrays for child_process.spawn — no shell is
 * ever involved, so file names and user input can never become shell syntax.
 */

const FX_TYPES = new Set(['blur', 'solid', 'pixelate'])

/**
 * Validate and normalize the edits array sent by the client.
 * Throws Error with a user-readable message on structurally invalid input.
 * Returns a cleaned copy: numbers coerced, boxes clamped to 0-100%,
 * ranges clamped to [0, duration], zero-length edits dropped.
 */
/**
 * Expand any edit carrying a `track` (per-keyframe boxes from the follow-tracker)
 * into a series of short static box edits — one per keyframe interval — so the
 * normal static-box ffmpeg pipeline renders a moving/tracked blur with no special
 * casing. Non-tracked edits pass through unchanged. Dense tracks are downsampled.
 */
function expandTrackedEdits(rawEdits, maxSegmentsPerTrack = 150) {
  if (!Array.isArray(rawEdits)) return rawEdits
  const out = []
  for (const e of rawEdits) {
    if (!e || !Array.isArray(e.track) || e.track.length < 2) { out.push(e); continue }
    let kf = e.track
    if (kf.length > maxSegmentsPerTrack) {
      const stride = Math.ceil(kf.length / maxSegmentsPerTrack)
      kf = kf.filter((_, i) => i % stride === 0 || i === kf.length - 1)
    }
    for (let i = 0; i < kf.length; i++) {
      if (!kf[i] || !kf[i].box) continue
      const start = Number(kf[i].t)
      const end = i < kf.length - 1 ? Number(kf[i + 1].t) : (Number(e.end) > start ? Number(e.end) : start + 0.2)
      if (!(end > start)) continue
      out.push({
        action: e.action, start, end, box: kf[i].box,
        fxType: e.fxType, fxIntensity: e.fxIntensity, customMediaId: e.customMediaId,
      })
    }
  }
  return out
}

function sanitizeEdits(rawEdits, duration) {
  if (!Array.isArray(rawEdits)) throw new Error('edits must be an array')
  if (rawEdits.length > 4000) throw new Error('too many edits (max 4000)')

  const clampPct = (v) => Math.max(0, Math.min(100, Number(v) || 0))
  const edits = []

  for (const e of rawEdits) {
    if (!e || typeof e !== 'object') continue
    if (!['cut', 'bleep', 'blur'].includes(e.action)) {
      throw new Error(`unknown edit action: ${String(e.action).slice(0, 30)}`)
    }
    let start = Number(e.start)
    let end = Number(e.end)
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new Error('edit start/end must be numbers')
    }
    start = Math.max(0, start)
    end = duration > 0 ? Math.min(end, duration) : end
    if (end - start < 0.01) continue

    const clean = { action: e.action, start, end }
    if (typeof e.customMediaId === 'string') clean.customMediaId = e.customMediaId

    if (e.action === 'blur') {
      if (!e.box || typeof e.box !== 'object') continue
      clean.box = {
        x: clampPct(e.box.x),
        y: clampPct(e.box.y),
        w: clampPct(e.box.w),
        h: clampPct(e.box.h),
      }
      // keep the box inside the frame
      clean.box.w = Math.min(clean.box.w, 100 - clean.box.x)
      clean.box.h = Math.min(clean.box.h, 100 - clean.box.y)
      if (clean.box.w < 0.5 || clean.box.h < 0.5) continue
      clean.fxType = FX_TYPES.has(e.fxType) ? e.fxType : 'blur'
      const intensity = Number(e.fxIntensity)
      clean.fxIntensity = Number.isFinite(intensity)
        ? Math.max(1, Math.min(100, intensity))
        : 15
    }
    edits.push(clean)
  }
  return edits
}

/**
 * Build the full ffmpeg argv for an export.
 *
 * @param {object} opts
 * @param {string} opts.inputPath   main video file
 * @param {string} opts.outputPath  destination file
 * @param {Array}  opts.edits       sanitized edits (see sanitizeEdits)
 * @param {Map|object} opts.customFiles  id -> {path, isImage} for user media
 * @param {number} opts.duration    video duration in seconds (0 = unknown)
 * @param {boolean} opts.hasAudio   whether input has an audio stream
 * @param {boolean} opts.hasVideo   whether input has a video stream (false = audio-only file)
 * @param {number} opts.width       video width in px
 * @param {number} opts.height      video height in px
 * @returns {{args: string[], reencodes: boolean}}
 */
function buildExportArgs(opts) {
  const {
    inputPath, outputPath, edits,
    duration = 0, hasAudio = true, hasVideo = true, width = 0, height = 0,
    subtitleFile = null, // basename of an .srt to burn in (spawn cwd = its dir)
  } = opts
  const customFiles = opts.customFiles instanceof Map
    ? opts.customFiles
    : new Map(Object.entries(opts.customFiles || {}))

  // audio-only sources can't carry visual fx — drop blurs there
  const blurs = hasVideo ? edits.filter(e => e.action === 'blur') : []
  const bleeps = hasAudio ? edits.filter(e => e.action === 'bleep') : []
  const cuts = edits.filter(e => e.action === 'cut').sort((a, b) => a.start - b.start)

  const inputArgs = ['-i', inputPath]
  const graph = []
  let inputIndex = 1
  let currentV = hasVideo ? '0:v' : null
  let currentA = hasAudio ? '0:a' : null

  // ---- 1. visual fx (operate on the original timeline, before cuts) ----
  blurs.forEach((b, i) => {
    const px = (b.box.x / 100).toFixed(4)
    const py = (b.box.y / 100).toFixed(4)
    const pw = (b.box.w / 100).toFixed(4)
    const ph = (b.box.h / 100).toFixed(4)
    const between = `between(t,${b.start.toFixed(3)},${b.end.toFixed(3)})`
    const next = `vfx${i}`
    const custom = b.customMediaId && customFiles.get(b.customMediaId)

    if (custom && custom.isImage) {
      inputArgs.push('-loop', '1', '-i', custom.path)
      if (width > 0 && height > 0) {
        const ow = Math.max(2, Math.round(width * b.box.w / 100 / 2) * 2)
        const oh = Math.max(2, Math.round(height * b.box.h / 100 / 2) * 2)
        graph.push(`[${inputIndex}:v]scale=${ow}:${oh}[ovr${i}]`)
      } else {
        graph.push(`[${inputIndex}:v][${currentV}]scale2ref=w='main_w*${pw}':h='main_h*${ph}'[ovr${i}][sref${i}]`)
        currentV = `sref${i}`
      }
      graph.push(`[${currentV}][ovr${i}]overlay=x='W*${px}':y='H*${py}':enable='${between}'[${next}]`)
      inputIndex++
    } else if (b.fxType === 'solid') {
      const opacity = (b.fxIntensity / 100).toFixed(2)
      graph.push(`[${currentV}]drawbox=x='iw*${px}':y='ih*${py}':w='iw*${pw}':h='ih*${ph}':color=black@${opacity}:t=fill:enable='${between}'[${next}]`)
    } else if (b.fxType === 'pixelate') {
      // crop region -> shrink -> nearest-neighbor upscale -> overlay back
      const factor = Math.max(2, Math.min(50, Math.round(b.fxIntensity / 2)))
      graph.push(`[${currentV}]split=2[pbg${i}][pfg${i}]`)
      graph.push(`[pfg${i}]crop=w='iw*${pw}':h='ih*${ph}':x='iw*${px}':y='ih*${py}',scale='ceil(iw/${factor})':'ceil(ih/${factor})',scale='${factor}*iw':'${factor}*ih':flags=neighbor[pix${i}]`)
      graph.push(`[pbg${i}][pix${i}]overlay=x='W*${px}':y='H*${py}':enable='${between}'[${next}]`)
    } else {
      // blur radius must stay below half the cropped region's smaller side
      const radius = Math.max(2, Math.min(50, Math.round(b.fxIntensity)))
      graph.push(`[${currentV}]split=2[bbg${i}][bfg${i}]`)
      graph.push(`[bfg${i}]crop=w='iw*${pw}':h='ih*${ph}':x='iw*${px}':y='ih*${py}',boxblur=luma_radius='min(${radius},max(1,min(w,h)/2-1))':luma_power=2:chroma_radius='min(${radius},max(1,min(cw,ch)/2-1))'[blr${i}]`)
      graph.push(`[bbg${i}][blr${i}]overlay=x='W*${px}':y='H*${py}':enable='${between}'[${next}]`)
    }
    currentV = next
  })

  // ---- 2. audio bleeps + optional replacement sfx ----
  if (bleeps.length > 0) {
    // Whisper word timestamps tend to land tight around the vowel, so a small
    // pad keeps the bleep from clipping the consonants and leaking the word.
    // Lead is a touch wider than trail since the onset is the most recognizable.
    const LEAD_PADDING = 0.3
    const TRAIL_PADDING = 0.25
    bleeps.forEach((b, i) => {
      const start = Math.max(0, b.start - LEAD_PADDING).toFixed(3)
      const end = (b.end + TRAIL_PADDING).toFixed(3)
      const next = `mute${i}`
      graph.push(`[${currentA}]volume=0:enable='between(t,${start},${end})'[${next}]`)
      currentA = next
    })

    const mixInputs = [`[${currentA}]`]
    bleeps.forEach((b, i) => {
      const custom = b.customMediaId && customFiles.get(b.customMediaId)
      if (custom && !custom.isImage) {
        inputArgs.push('-i', custom.path)
        const delayMs = Math.max(0, Math.floor((b.start - LEAD_PADDING) * 1000))
        graph.push(`[${inputIndex}:a]adelay=${delayMs}|${delayMs},apad[sfx${i}]`)
        mixInputs.push(`[sfx${i}]`)
        inputIndex++
      }
    })
    if (mixInputs.length > 1) {
      graph.push(`${mixInputs.join('')}amix=inputs=${mixInputs.length}:duration=first:dropout_transition=0:normalize=0[amixed]`)
      currentA = 'amixed'
    }
  }

  // ---- 3. cuts: trim out removed ranges and concat the keepers ----
  if (cuts.length > 0) {
    const keep = []
    let lastEnd = 0
    for (const cut of cuts) {
      if (cut.start > lastEnd + 0.01) keep.push({ start: lastEnd, end: cut.start })
      lastEnd = Math.max(lastEnd, cut.end)
    }
    const tail = duration > 0 ? duration : 999999
    if (tail > lastEnd + 0.01) keep.push({ start: lastEnd, end: tail })
    if (keep.length === 0) throw new Error('cuts would remove the entire video')

    const segLabels = []
    if (keep.length > 1) {
      if (currentV) graph.push(`[${currentV}]split=${keep.length}${keep.map((_, i) => `[vs${i}]`).join('')}`)
      if (currentA) graph.push(`[${currentA}]asplit=${keep.length}${keep.map((_, i) => `[as${i}]`).join('')}`)
      keep.forEach((seg, i) => {
        if (currentV) graph.push(`[vs${i}]trim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},setpts=PTS-STARTPTS[vseg${i}]`)
        if (currentA) graph.push(`[as${i}]atrim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},asetpts=PTS-STARTPTS[aseg${i}]`)
        segLabels.push(`${currentV ? `[vseg${i}]` : ''}${currentA ? `[aseg${i}]` : ''}`)
      })
    } else {
      const seg = keep[0]
      if (currentV) graph.push(`[${currentV}]trim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},setpts=PTS-STARTPTS[vseg0]`)
      if (currentA) graph.push(`[${currentA}]atrim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},asetpts=PTS-STARTPTS[aseg0]`)
      segLabels.push(`${currentV ? '[vseg0]' : ''}${currentA ? '[aseg0]' : ''}`)
    }
    graph.push(`${segLabels.join('')}concat=n=${keep.length}:v=${currentV ? 1 : 0}:a=${currentA ? 1 : 0}${currentV ? '[outv]' : ''}${currentA ? '[outa]' : ''}`)
    if (currentV) currentV = 'outv'
    if (currentA) currentA = 'outa'
  }

  // ---- 4. burn-in subtitles (last video step; .srt timed to the edited timeline) ----
  // The file is referenced by basename and resolved against ffmpeg's cwd, which
  // sidesteps Windows drive-letter (C:) escaping inside the subtitles filter.
  if (subtitleFile && currentV) {
    graph.push(`[${currentV}]subtitles=${subtitleFile}[vsub]`)
    currentV = 'vsub'
  }

  // ---- assemble argv ----
  const reencodes = graph.length > 0
  const args = ['-hide_banner', '-nostats', ...inputArgs]
  if (reencodes) args.push('-filter_complex', graph.join(';'))

  if (currentV) args.push('-map', currentV.includes(':') ? currentV : `[${currentV}]`)
  if (currentA) args.push('-map', currentA.includes(':') ? currentA : `[${currentA}]`)

  if (reencodes) {
    if (currentV) args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p')
    if (currentA) args.push('-c:a', 'aac', '-b:a', '192k')
  } else {
    args.push('-c', 'copy')
  }
  args.push('-progress', 'pipe:1', '-y', outputPath)

  return { args, reencodes }
}

module.exports = { sanitizeEdits, buildExportArgs, expandTrackedEdits }
