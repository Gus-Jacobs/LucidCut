'use strict'

const express = require('express')
const multer = require('multer')
const path = require('path')
const fs = require('fs')
const { v4: uuidv4 } = require('uuid')
const { spawn, execFile } = require('child_process')
const cors = require('cors')

const { sanitizeEdits, buildExportArgs } = require('./lib/exportPipeline')
const { probeVideo } = require('./lib/probe')

const app = express()
app.use(cors())
app.use(express.json({ limit: '5mb' }))
app.use(express.urlencoded({ extended: true, limit: '5mb' }))

const UPLOAD_DIR = path.resolve(__dirname, 'uploads')
const OUTPUTS_DIR = path.resolve(__dirname, 'outputs')
const EDITED_DIR = path.join(OUTPUTS_DIR, 'edited')
const PYTHON_BIN = process.env.LUCIDCUT_PYTHON || path.resolve(__dirname, '.venv', 'bin', 'python3')
const WORKER_SCRIPT = path.join(__dirname, 'worker', 'process_video.py')
const MAX_FILE_AGE_MS = 24 * 60 * 60 * 1000
const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024 // 2GB
const MAX_MEDIA_BYTES = 100 * 1024 * 1024 // custom overlay images / sfx
const MAX_CONCURRENT_JOBS = 1 // whisper + nsfw models are heavy; queue the rest

for (const dir of [UPLOAD_DIR, OUTPUTS_DIR, EDITED_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

// ---------------------------------------------------------------------------
// housekeeping
// ---------------------------------------------------------------------------
function cleanupOldFiles(dirPath, maxAgeMs) {
  if (!fs.existsSync(dirPath)) return
  const now = Date.now()
  let entries = []
  try { entries = fs.readdirSync(dirPath, { withFileTypes: true }) } catch (e) { return }
  for (const entry of entries) {
    const filePath = path.join(dirPath, entry.name)
    try {
      if (entry.isDirectory()) continue
      const stats = fs.statSync(filePath)
      if (now - stats.mtimeMs > maxAgeMs) fs.unlinkSync(filePath)
    } catch (e) {
      console.error(`[cleanup] ${filePath}: ${e.message}`)
    }
  }
}

function runCleanup() {
  cleanupOldFiles(UPLOAD_DIR, MAX_FILE_AGE_MS)
  cleanupOldFiles(OUTPUTS_DIR, MAX_FILE_AGE_MS)
  cleanupOldFiles(EDITED_DIR, MAX_FILE_AGE_MS)
}
runCleanup()
setInterval(runCleanup, 60 * 60 * 1000).unref()

// ---------------------------------------------------------------------------
// uploads — never trust client file names: store under a uuid, keep only a
// validated extension. The original name survives as metadata.
// ---------------------------------------------------------------------------
const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v'])
const MEDIA_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp3', '.wav', '.ogg', '.m4a', '.aac'])

function safeExt(originalName, allowed) {
  const ext = path.extname(originalName || '').toLowerCase()
  return allowed.has(ext) ? ext : ''
}

const videoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `${uuidv4()}${safeExt(file.originalname, VIDEO_EXT) || '.mp4'}`),
  }),
  limits: { fileSize: MAX_VIDEO_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const okType = (file.mimetype || '').startsWith('video/')
    const okExt = safeExt(file.originalname, VIDEO_EXT) !== ''
    cb(okType || okExt ? null : new Error('unsupported file type — please upload a video'), okType || okExt)
  },
})

const mediaUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `media-${uuidv4()}${safeExt(file.originalname, MEDIA_EXT)}`),
  }),
  limits: { fileSize: MAX_MEDIA_BYTES, files: 20 },
  fileFilter: (req, file, cb) => {
    const ok = /^(image|audio)\//.test(file.mimetype || '')
    cb(ok ? null : new Error('custom media must be an image or audio file'), ok)
  },
})

// ---------------------------------------------------------------------------
// job state (in-memory; files on disk are the source of truth for results)
// ---------------------------------------------------------------------------
const jobs = {}
const jobQueue = []
let runningJobs = 0

function publicJob(job) {
  // never leak filesystem paths to the client
  const { inputPath, outputPath, resultsPath, editedOutputPath, ...rest } = job
  return rest
}

function enqueueJob(job) {
  jobQueue.push(job.id)
  pumpQueue()
}

function pumpQueue() {
  while (runningJobs < MAX_CONCURRENT_JOBS && jobQueue.length > 0) {
    const job = jobs[jobQueue.shift()]
    if (job && job.status === 'queued') startWorker(job)
  }
}

function startWorker(job) {
  runningJobs++
  job.status = 'processing'
  job.statusMessage = 'Starting analysis...'

  let py
  try {
    py = spawn(PYTHON_BIN, [WORKER_SCRIPT, job.inputPath, job.outputPath, JSON.stringify(job.config)])
  } catch (e) {
    finishJob(job, 1, `failed to start worker: ${e.message}`)
    return
  }

  // smooth progress interpolation: trickle the bar between python's real updates
  let actualProgress = 0
  const progressInterval = setInterval(() => {
    if (job.status !== 'processing') { clearInterval(progressInterval); return }
    if (actualProgress > job.progress) {
      job.progress += Math.max(1, Math.floor((actualProgress - job.progress) / 2))
    } else if (job.progress < actualProgress + 15 && job.progress < 95) {
      job.progress += 1
    }
  }, 800)

  let stderrTail = ''
  const handleOutput = (d) => {
    const text = d.toString()
    stderrTail = (stderrTail + text).slice(-3000)
    for (const line of text.split(/\r?\n|\r/)) {
      const cleanLine = line.trim()
      if (!cleanLine) continue
      if (cleanLine.includes('[step-')) {
        job.statusMessage = cleanLine.substring(cleanLine.indexOf('[step-'))
      }
      if (cleanLine.includes('[progress]')) {
        const valMatch = cleanLine.match(/\[progress\]\s*(\d+)/)
        if (valMatch) {
          const val = parseInt(valMatch[1], 10)
          if (!isNaN(val) && val > actualProgress) actualProgress = val
        }
      }
    }
  }

  py.stdout.on('data', handleOutput)
  py.stderr.on('data', handleOutput)
  py.on('error', (e) => {
    clearInterval(progressInterval)
    finishJob(job, 1, `worker process error: ${e.message}`)
  })
  py.on('close', (code) => {
    clearInterval(progressInterval)
    finishJob(job, code, stderrTail)
  })
}

function finishJob(job, code, errorContext) {
  if (job.status !== 'processing' && job.status !== 'queued') return
  runningJobs = Math.max(0, runningJobs - 1)
  job.finishedAt = Date.now()
  job.resultsPath = job.outputPath + '.results.json'

  try {
    if (fs.existsSync(job.resultsPath)) {
      job.results = JSON.parse(fs.readFileSync(job.resultsPath, 'utf8'))
    }
  } catch (e) {
    console.error(`[job ${job.id}] failed to read results: ${e.message}`)
  }

  if (code === 0) {
    job.status = 'completed'
    job.progress = 100
    job.statusMessage = 'Complete'
  } else {
    job.status = 'failed'
    job.statusMessage = 'Processing failed'
    job.error = (job.results && job.results.error)
      || (errorContext || '').split('\n').filter(Boolean).slice(-3).join(' ')
      || 'unknown worker error'
    console.error(`[job ${job.id}] failed: ${job.error}`)
  }

  // input upload is no longer needed — the staged copy lives in outputs/
  try { if (fs.existsSync(job.inputPath)) fs.unlinkSync(job.inputPath) } catch (e) {}
  pumpQueue()
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------
app.get('/health', (req, res) => {
  execFile('ffmpeg', ['-version'], { timeout: 5000 }, (err) => {
    res.json({
      status: 'ok',
      ffmpeg: !err,
      python: fs.existsSync(PYTHON_BIN),
      activeJobs: runningJobs,
      queuedJobs: jobQueue.length,
    })
  })
})

app.post('/api/upload', videoUpload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no video file received' })

  let impurityDetectionConfig = {}
  if (req.body && req.body.impurityDetection) {
    try {
      impurityDetectionConfig = typeof req.body.impurityDetection === 'string'
        ? JSON.parse(req.body.impurityDetection)
        : req.body.impurityDetection
    } catch (e) {
      try { fs.unlinkSync(req.file.path) } catch (_) {}
      return res.status(400).json({ error: 'invalid impurityDetection config' })
    }
  }

  const jobId = uuidv4()
  const job = {
    id: jobId,
    status: 'queued',
    progress: 0,
    statusMessage: 'Queued...',
    inputPath: req.file.path,
    outputPath: path.join(OUTPUTS_DIR, `${jobId}${path.extname(req.file.path)}`),
    originalName: req.file.originalname,
    createdAt: Date.now(),
    config: { impurityDetection: impurityDetectionConfig },
  }
  jobs[jobId] = job
  enqueueJob(job)

  res.json({ jobId })
})

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs[req.params.id]
  if (!job) return res.status(404).json({ error: 'job not found' })
  res.json(publicJob(job))
})

app.get('/api/jobs/:id/results', (req, res) => {
  const job = jobs[req.params.id]
  if (!job) return res.status(404).json({ error: 'job not found' })
  const rp = job.resultsPath
  if (!rp || !fs.existsSync(rp)) return res.status(404).json({ error: 'results not ready' })
  try {
    return res.json(JSON.parse(fs.readFileSync(rp, 'utf8')))
  } catch (e) {
    return res.status(500).json({ error: 'failed to read results' })
  }
})

app.post('/api/jobs/:id/feedback', (req, res) => {
  const job = jobs[req.params.id]
  if (!job) return res.status(404).json({ error: 'job not found' })
  const feedback = req.body && req.body.feedback
  if (!Array.isArray(feedback)) return res.status(400).json({ error: 'feedback array required' })
  if (feedback.length > 1000) return res.status(400).json({ error: 'too many feedback entries' })

  const payload = {
    jobId: job.id,
    videoName: job.originalName,
    timestamp: new Date().toISOString(),
    feedback,
  }
  const feedbackPath = job.outputPath + '.feedback.json'
  try {
    fs.writeFileSync(feedbackPath, JSON.stringify(payload, null, 2))
    job.feedbackSubmitted = true
    res.json({ status: 'saved', count: feedback.length })
  } catch (e) {
    console.error(`[feedback] write failed: ${e.message}`)
    res.status(500).json({ error: 'failed to save feedback' })
  }
})

app.post('/api/jobs/:id/export', mediaUpload.any(), async (req, res) => {
  const job = jobs[req.params.id]
  const uploadedFiles = req.files || []
  const dropUploads = () => uploadedFiles.forEach(f => { try { fs.unlinkSync(f.path) } catch (e) {} })

  if (!job || !job.outputPath || !fs.existsSync(job.outputPath)) {
    dropUploads()
    return res.status(404).json({ error: 'job not found or source video expired' })
  }
  if (job.export && job.export.status === 'processing') {
    dropUploads()
    return res.status(409).json({ error: 'an export is already running for this job' })
  }

  let rawEdits = []
  try {
    rawEdits = typeof req.body.edits === 'string' ? JSON.parse(req.body.edits) : (req.body.edits || [])
  } catch (e) {
    dropUploads()
    return res.status(400).json({ error: 'invalid edits format' })
  }

  let probe
  try {
    probe = await probeVideo(job.outputPath)
  } catch (e) {
    dropUploads()
    return res.status(500).json({ error: `could not analyze source video: ${e.message}` })
  }

  let edits
  try {
    edits = sanitizeEdits(rawEdits, probe.duration)
  } catch (e) {
    dropUploads()
    return res.status(400).json({ error: e.message })
  }

  if (edits.length === 0) {
    dropUploads()
    return res.json({ status: 'ready', downloadUrl: `/api/download/${job.id}/original` })
  }

  const customFiles = new Map()
  for (const f of uploadedFiles) {
    customFiles.set(f.originalname, { path: f.path, isImage: (f.mimetype || '').startsWith('image/') })
  }

  const outputFilename = `${job.id}_final_${Date.now()}.mp4`
  const exportPath = path.join(EDITED_DIR, outputFilename)

  let built
  try {
    built = buildExportArgs({
      inputPath: job.outputPath,
      outputPath: exportPath,
      edits,
      customFiles,
      duration: probe.duration,
      hasAudio: probe.hasAudio,
      width: probe.width,
      height: probe.height,
    })
  } catch (e) {
    dropUploads()
    return res.status(400).json({ error: e.message })
  }

  console.log(`[export ${job.id}] ffmpeg ${built.args.join(' ')}`)
  job.export = { status: 'processing', progress: 0, startedAt: Date.now(), error: null }

  const ffmpeg = spawn('ffmpeg', built.args)
  let stderrTail = ''

  ffmpeg.stdout.on('data', (d) => {
    // -progress pipe:1 emits key=value lines; track out_time_ms against duration
    const m = d.toString().match(/out_time_ms=(\d+)/g)
    if (m && probe.duration > 0) {
      const lastUs = parseInt(m[m.length - 1].slice('out_time_ms='.length), 10)
      job.export.progress = Math.min(99, Math.round((lastUs / 1e6) / probe.duration * 100))
    }
  })
  ffmpeg.stderr.on('data', (d) => {
    stderrTail = (stderrTail + d.toString()).slice(-2000)
  })
  ffmpeg.on('error', (e) => {
    job.export = { ...job.export, status: 'failed', error: `ffmpeg not available: ${e.message}` }
    dropUploads()
  })
  ffmpeg.on('close', (code) => {
    if (code === 0) {
      job.export.status = 'completed'
      job.export.progress = 100
      job.editedOutputPath = exportPath
      job.editedFileName = `${path.basename(job.originalName || 'video', path.extname(job.originalName || ''))}_censored.mp4`
      console.log(`[export ${job.id}] complete`)
    } else {
      job.export.status = 'failed'
      job.export.error = stderrTail.split('\n').filter(Boolean).slice(-4).join(' ')
      console.error(`[export ${job.id}] ffmpeg exited ${code}:\n${stderrTail}`)
    }
    dropUploads()
  })

  res.json({
    status: 'processing',
    statusUrl: `/api/jobs/${job.id}/export-status`,
    downloadUrl: `/api/download/${job.id}/edited`,
  })
})

app.get('/api/jobs/:id/export-status', (req, res) => {
  const job = jobs[req.params.id]
  if (!job) return res.status(404).json({ error: 'job not found' })
  res.json(job.export || { status: 'none' })
})

app.get('/api/download/:jobId/:type', (req, res) => {
  const { jobId, type } = req.params
  const job = jobs[jobId]
  if (!job) return res.status(404).json({ error: 'job not found' })

  let filePath, fileName
  if (type === 'original') {
    filePath = job.outputPath
    fileName = job.originalName || 'video.mp4'
  } else if (type === 'edited') {
    if (job.export && job.export.status === 'failed') {
      return res.status(500).json({ error: 'export_failed', details: job.export.error })
    }
    if (!job.editedOutputPath) return res.status(202).json({ error: 'still_processing' })
    filePath = job.editedOutputPath
    fileName = job.editedFileName || `edited-${jobId}.mp4`
  } else {
    return res.status(400).json({ error: 'unknown download type' })
  }

  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'file_not_found' })
  }
  res.download(filePath, fileName)
})

// ---------------------------------------------------------------------------
// error handling
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'file too large' : err.message
    return res.status(413).json({ error: msg })
  }
  if (err) {
    console.error('[server]', err.message)
    return res.status(400).json({ error: err.message })
  }
  next()
})

app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }))

const PORT = process.env.PORT || 4000
app.listen(PORT, () => console.log(`LucidCut backend listening on ${PORT}`))
