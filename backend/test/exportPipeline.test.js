'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { sanitizeEdits, buildExportArgs, expandTrackedEdits } = require('../lib/exportPipeline')

test('sanitizeEdits rejects non-arrays', () => {
  assert.throws(() => sanitizeEdits({}, 10), /must be an array/)
})

test('sanitizeEdits rejects unknown actions', () => {
  assert.throws(() => sanitizeEdits([{ action: 'explode', start: 0, end: 1 }], 10), /unknown edit action/)
})

test('sanitizeEdits drops zero-length and clamps ranges to duration', () => {
  const edits = sanitizeEdits([
    { action: 'cut', start: 1, end: 1 },          // zero length -> dropped
    { action: 'cut', start: 5, end: 999 },        // end clamped to duration
  ], 10)
  assert.strictEqual(edits.length, 1)
  assert.strictEqual(edits[0].end, 10)
})

test('sanitizeEdits clamps blur boxes inside the frame and drops tiny boxes', () => {
  const edits = sanitizeEdits([
    { action: 'blur', start: 0, end: 2, box: { x: 90, y: 90, w: 50, h: 50 } }, // overflow -> clamped
    { action: 'blur', start: 0, end: 2, box: { x: 0, y: 0, w: 0.1, h: 0.1 } }, // tiny -> dropped
  ], 10)
  assert.strictEqual(edits.length, 1)
  assert.ok(edits[0].box.x + edits[0].box.w <= 100.001)
  assert.ok(edits[0].box.y + edits[0].box.h <= 100.001)
})

test('sanitizeEdits defaults fxType and clamps intensity', () => {
  const [e] = sanitizeEdits([{ action: 'blur', start: 0, end: 1, box: { x: 10, y: 10, w: 20, h: 20 }, fxType: 'bogus', fxIntensity: 9999 }], 10)
  assert.strictEqual(e.fxType, 'blur')
  assert.strictEqual(e.fxIntensity, 100)
})

test('sanitizeEdits enforces a hard cap on edit count', () => {
  const many = Array.from({ length: 4001 }, () => ({ action: 'cut', start: 0, end: 1 }))
  assert.throws(() => sanitizeEdits(many, 10), /too many edits/)
})

test('expandTrackedEdits turns a tracked edit into per-keyframe static boxes', () => {
  const tracked = {
    action: 'blur', start: 1, end: 2.5, fxType: 'pixelate', fxIntensity: 30,
    track: [
      { t: 1.0, box: { x: 10, y: 10, w: 20, h: 20 } },
      { t: 1.5, box: { x: 12, y: 11, w: 20, h: 20 } },
      { t: 2.0, box: { x: 15, y: 13, w: 20, h: 20 } },
    ],
  }
  const out = expandTrackedEdits([tracked, { action: 'cut', start: 5, end: 6 }])
  // 3 keyframes -> 3 static segments, plus the untouched cut
  const blurs = out.filter(e => e.action === 'blur')
  assert.strictEqual(blurs.length, 3)
  assert.ok(blurs.every(b => b.box && b.fxType === 'pixelate'))
  assert.strictEqual(blurs[0].start, 1.0)
  assert.strictEqual(blurs[2].end, 2.5) // last segment extends to the edit end
  assert.ok(out.some(e => e.action === 'cut')) // non-tracked passes through
})

test('expandTrackedEdits leaves non-tracked edits untouched', () => {
  const edits = [{ action: 'blur', start: 0, end: 1, box: { x: 1, y: 1, w: 2, h: 2 } }]
  assert.deepStrictEqual(expandTrackedEdits(edits), edits)
})

test('buildExportArgs uses stream copy when there are no edits', () => {
  const { args, reencodes } = buildExportArgs({
    inputPath: '/in.mp4', outputPath: '/out.mp4', edits: [], duration: 10, hasAudio: true,
  })
  assert.strictEqual(reencodes, false)
  assert.ok(args.includes('-c'))
  assert.ok(args.includes('copy'))
})

test('buildExportArgs never invokes a shell: paths stay as discrete argv entries', () => {
  const evil = '/tmp/foo; rm -rf ~/.mp4'
  const { args } = buildExportArgs({
    inputPath: evil, outputPath: '/out.mp4',
    edits: sanitizeEdits([{ action: 'cut', start: 1, end: 2 }], 10),
    duration: 10, hasAudio: true,
  })
  // the dangerous string appears as one argv element, never concatenated/split
  assert.ok(args.includes(evil))
})

test('buildExportArgs builds a filter graph for blur + cut and re-encodes', () => {
  const edits = sanitizeEdits([
    { action: 'blur', start: 0.5, end: 2, box: { x: 10, y: 10, w: 30, h: 30 }, fxType: 'blur', fxIntensity: 20 },
    { action: 'cut', start: 3, end: 4 },
  ], 10)
  const { args, reencodes } = buildExportArgs({
    inputPath: '/in.mp4', outputPath: '/out.mp4', edits, duration: 10, hasAudio: true, width: 1920, height: 1080,
  })
  assert.strictEqual(reencodes, true)
  const fc = args[args.indexOf('-filter_complex') + 1]
  assert.match(fc, /boxblur/)
  assert.match(fc, /concat=n=2/)
  assert.ok(args.includes('libx264'))
})

test('buildExportArgs supports pixelate and solid fx', () => {
  const edits = sanitizeEdits([
    { action: 'blur', start: 0, end: 1, box: { x: 5, y: 5, w: 20, h: 20 }, fxType: 'pixelate', fxIntensity: 30 },
    { action: 'blur', start: 0, end: 1, box: { x: 50, y: 50, w: 20, h: 20 }, fxType: 'solid', fxIntensity: 100 },
  ], 10)
  const { args } = buildExportArgs({ inputPath: '/in.mp4', outputPath: '/out.mp4', edits, duration: 10, hasAudio: true })
  const fc = args[args.indexOf('-filter_complex') + 1]
  assert.match(fc, /flags=neighbor/) // pixelate
  assert.match(fc, /drawbox/)        // solid
})

test('buildExportArgs omits audio mapping when the source has none', () => {
  const edits = sanitizeEdits([{ action: 'cut', start: 3, end: 4 }], 10)
  const { args } = buildExportArgs({ inputPath: '/in.mp4', outputPath: '/out.mp4', edits, duration: 10, hasAudio: false })
  const fc = args[args.indexOf('-filter_complex') + 1]
  assert.match(fc, /concat=n=2:v=1:a=0/)
  assert.ok(!fc.includes('atrim'))
})

test('buildExportArgs drops bleeps when there is no audio track', () => {
  const edits = sanitizeEdits([{ action: 'bleep', start: 1, end: 2 }], 10)
  const { args, reencodes } = buildExportArgs({ inputPath: '/in.mp4', outputPath: '/out.mp4', edits, duration: 10, hasAudio: false })
  // nothing to do on the video side -> stream copy
  assert.strictEqual(reencodes, false)
})

test('buildExportArgs handles audio-only sources: cuts + bleeps, no video stream', () => {
  const edits = sanitizeEdits([
    { action: 'bleep', start: 1, end: 2 },
    { action: 'cut', start: 5, end: 6 },
    { action: 'blur', start: 0, end: 1, box: { x: 10, y: 10, w: 20, h: 20 } }, // ignored (no video)
  ], 10)
  const { args, reencodes } = buildExportArgs({
    inputPath: '/song.mp3', outputPath: '/out.m4a', edits,
    duration: 10, hasAudio: true, hasVideo: false,
  })
  assert.strictEqual(reencodes, true)
  const fc = args[args.indexOf('-filter_complex') + 1]
  assert.match(fc, /concat=n=2:v=0:a=1/) // audio-only concat
  assert.ok(!fc.includes('boxblur'))     // blur dropped
  assert.ok(!fc.includes('[0:v]'))       // video stream never referenced
  assert.ok(!args.includes('libx264'))   // no video codec
  assert.ok(args.includes('-c:a'))       // audio is encoded
})

test('buildExportArgs burns in subtitles by basename (cwd-relative) and re-encodes', () => {
  const { args, reencodes } = buildExportArgs({
    inputPath: '/in.mp4', outputPath: '/out.mp4', edits: [],
    duration: 10, hasAudio: true, hasVideo: true, subtitleFile: 'job_123.srt',
  })
  assert.strictEqual(reencodes, true)
  const fc = args[args.indexOf('-filter_complex') + 1]
  assert.match(fc, /subtitles=job_123\.srt/)
  assert.ok(!fc.includes(':\\') && !fc.includes('C:')) // no absolute drive path to escape
  assert.ok(args.includes('libx264'))
})

test('buildExportArgs ignores subtitles for audio-only sources', () => {
  const { args } = buildExportArgs({
    inputPath: '/song.mp3', outputPath: '/out.m4a',
    edits: sanitizeEdits([{ action: 'bleep', start: 1, end: 2 }], 10),
    duration: 10, hasAudio: true, hasVideo: false, subtitleFile: 'job_123.srt',
  })
  const idx = args.indexOf('-filter_complex')
  const fc = idx >= 0 ? args[idx + 1] : ''
  assert.ok(!fc.includes('subtitles='))
})

test('buildExportArgs throws when cuts would remove the whole video', () => {
  const edits = sanitizeEdits([{ action: 'cut', start: 0, end: 10 }], 10)
  assert.throws(() => buildExportArgs({ inputPath: '/in.mp4', outputPath: '/out.mp4', edits, duration: 10, hasAudio: true }), /entire video/)
})

test('overlapping cuts merge into contiguous removed ranges', () => {
  const edits = sanitizeEdits([
    { action: 'cut', start: 2, end: 5 },
    { action: 'cut', start: 4, end: 7 },
  ], 20)
  const { args } = buildExportArgs({ inputPath: '/in.mp4', outputPath: '/out.mp4', edits, duration: 20, hasAudio: true })
  const fc = args[args.indexOf('-filter_complex') + 1]
  // keep [0,2] and [7,20] -> two segments concatenated
  assert.match(fc, /concat=n=2/)
})
