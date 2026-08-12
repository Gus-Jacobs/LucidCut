'use strict'

const express = require('express')
const multer = require('multer')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { v4: uuidv4 } = require('uuid')
const { spawn, execFile } = require('child_process')
const cors = require('cors')

const { sanitizeEdits, buildExportArgs, expandTrackedEdits } = require('./lib/exportPipeline')
const { probeVideo } = require('./lib/probe')

const app = express()
app.use(cors())
app.use(express.json({ limit: '5mb' }))
app.use(express.urlencoded({ extended: true, limit: '5mb' }))

// Persistent, update-safe user data (uploads, staged outputs, training crops,
// personalized models, saved projects). In the packaged Electron app this is the
// OS userData dir (passed via env), so it's writable in production and a code
// update never wipes a user's projects or learned model.
const DATA_DIR = process.env.LUCIDCUT_DATA_DIR || path.resolve(__dirname, 'user-data')

const UPLOAD_DIR = path.join(DATA_DIR, 'uploads')
const OUTPUTS_DIR = path.join(DATA_DIR, 'outputs')
const EDITED_DIR = path.join(OUTPUTS_DIR, 'edited')
const TRAINING_PENDING_DIR = path.join(DATA_DIR, 'training', 'pending')
const TRAINING_LABELED_DIR = path.join(DATA_DIR, 'training', 'labeled')
const MODELS_DIR = path.join(DATA_DIR, 'models')
const PROJECTS_DIR = path.join(DATA_DIR, 'projects') // saved project manifests (recents/restore)

const VENV_PYTHON = process.platform === 'win32'
  ? path.resolve(__dirname, '.venv', 'Scripts', 'python.exe')
  : path.resolve(__dirname, '.venv', 'bin', 'python3')
const PYTHON_BIN = process.env.LUCIDCUT_PYTHON || VENV_PYTHON
const WORKER_SCRIPT = path.join(__dirname, 'worker', 'process_video.py')
const TRAIN_SCRIPT = path.join(__dirname, 'worker', 'train_model.py')
const TRACK_SCRIPT = path.join(__dirname, 'worker', 'track_object.py')

// In a packaged build, Electron passes paths to the frozen worker exe + bundled
// ffmpeg/ffprobe. In dev these are unset, so we fall back to the venv + PATH.
const WORKER_EXE = process.env.LUCIDCUT_WORKER_EXE || null
const FFMPEG = process.env.LUCIDCUT_FFMPEG || 'ffmpeg'
const FFPROBE = process.env.LUCIDCUT_FFPROBE || 'ffprobe'

// Spawn a worker task either via the frozen exe (packaged) or python+script (dev).
function spawnWorker(kind, args, opts) {
  if (WORKER_EXE) return spawn(WORKER_EXE, [kind, ...args], opts)
  const script = kind === 'process' ? WORKER_SCRIPT : kind === 'train' ? TRAIN_SCRIPT : TRACK_SCRIPT
  return spawn(PYTHON_BIN, [script, ...args], opts)
}
const MAX_FILE_AGE_MS = 24 * 60 * 60 * 1000
const PROJECT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000 // keep saved projects 30 days
// Local desktop app — no upload size cap. (kept as a generous safety ceiling)
const MAX_MEDIA_BYTES = 1024 * 1024 * 1024 // custom overlay images / sfx
const MAX_CONCURRENT_JOBS = 1 // whisper + nsfw models are heavy; queue the rest
const MIN_SAMPLES_PER_CLASS = 8 // each class needs this many labels before training

for (const dir of [UPLOAD_DIR, OUTPUTS_DIR, EDITED_DIR,
  TRAINING_PENDING_DIR,
  path.join(TRAINING_LABELED_DIR, 'positive'),
  path.join(TRAINING_LABELED_DIR, 'negative'),
  MODELS_DIR, PROJECTS_DIR]) {
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
  // outputs/edited are retained as long as the project (30 days) so recents stay playable
  cleanupOldFiles(OUTPUTS_DIR, PROJECT_RETENTION_MS)
  cleanupOldFiles(EDITED_DIR, PROJECT_RETENTION_MS)
  cleanupOldProjects()
}
// runCleanup() is called once after the project registry loads, below.
setInterval(runCleanup, 60 * 60 * 1000).unref()

// ---------------------------------------------------------------------------
// uploads — never trust client file names: store under a uuid, keep only a
// validated extension. The original name survives as metadata.
// ---------------------------------------------------------------------------
// ffmpeg handles far more than this — these are the common containers we accept.
const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.mpg', '.mpeg',
  '.wmv', '.flv', '.ts', '.m2ts', '.mts', '.3gp', '.ogv', '.vob', '.divx'])
const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.oga', '.aac', '.opus',
  '.wma', '.aif', '.aiff', '.amr', '.weba'])
// LucidCut now accepts both video and audio (music) sources.
const INPUT_EXT = new Set([...VIDEO_EXT, ...AUDIO_EXT])
const MEDIA_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp3', '.wav', '.ogg', '.m4a', '.aac'])

function safeExt(originalName, allowed) {
  const ext = path.extname(originalName || '').toLowerCase()
  return allowed.has(ext) ? ext : ''
}

const videoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `${uuidv4()}${safeExt(file.originalname, INPUT_EXT) || '.mp4'}`),
  }),
  // no fileSize limit — this is a local desktop tool
  limits: { files: 1 },
  fileFilter: (req, file, cb) => {
    const okType = /^(video|audio)\//.test(file.mimetype || '')
    const okExt = safeExt(file.originalname, INPUT_EXT) !== ''
    cb(okType || okExt ? null : new Error('unsupported file type — please upload a video or audio file'), okType || okExt)
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
  // never leak filesystem paths to the client, and never serialize the child handle
  const { inputPath, outputPath, resultsPath, editedOutputPath, proc, ...rest } = job
  return rest
}

// compact view of an active (queued/processing) job for the queue UI
function queueJob(job) {
  return {
    id: job.id, name: job.originalName || 'Untitled', mediaType: job.mediaType || 'video',
    status: job.status, progress: job.progress || 0, statusMessage: job.statusMessage || '',
    steps: job.steps || [], error: job.error || null,
  }
}

// ---------------------------------------------------------------------------
// project persistence — a manifest per finished job survives restarts/crashes,
// powering the home "Recents" list, edit autosave, and crash recovery.
// ---------------------------------------------------------------------------
function manifestPath(id) { return path.join(PROJECTS_DIR, `${id}.json`) }

function writeProjectManifest(job) {
  const manifest = {
    id: job.id,
    name: job.originalName || 'Untitled',
    mediaType: job.mediaType || 'video',
    duration: job.duration || 0,
    createdAt: job.createdAt || Date.now(),
    completedAt: job.finishedAt || Date.now(),
    outputPath: job.outputPath,
    resultsPath: job.resultsPath,
    results: job.results || null,
    edits: job.edits || null, // user's timeline edits (autosaved while editing)
  }
  try { fs.writeFileSync(manifestPath(job.id), JSON.stringify(manifest)) }
  catch (e) { console.error(`[project ${job.id}] manifest write failed: ${e.message}`) }
}

function readProjectManifest(id) {
  try { return JSON.parse(fs.readFileSync(manifestPath(id), 'utf8')) }
  catch (e) { return null }
}

// Rebuild in-memory jobs from saved manifests so results/download/export keep
// working for projects opened from Recents after a restart.
function loadProjects() {
  let files = []
  try { files = fs.readdirSync(PROJECTS_DIR).filter(f => f.endsWith('.json')) } catch (e) { return }
  for (const f of files) {
    const m = readProjectManifest(path.basename(f, '.json'))
    if (!m || !m.id) continue
    if (jobs[m.id]) continue // a live job takes precedence
    jobs[m.id] = {
      id: m.id, status: 'completed', progress: 100, statusMessage: 'Complete', steps: [],
      mediaType: m.mediaType, originalName: m.name, duration: m.duration,
      outputPath: m.outputPath, resultsPath: m.resultsPath, results: m.results,
      edits: m.edits, createdAt: m.createdAt, finishedAt: m.completedAt, restored: true,
    }
  }
}

function cleanupOldProjects() {
  let files = []
  try { files = fs.readdirSync(PROJECTS_DIR).filter(f => f.endsWith('.json')) } catch (e) { return }
  const now = Date.now()
  for (const f of files) {
    const id = path.basename(f, '.json')
    const m = readProjectManifest(id)
    const age = now - ((m && (m.completedAt || m.createdAt)) || 0)
    if (m && age <= PROJECT_RETENTION_MS) continue
    deleteProjectFiles(id, m)
  }
}

function deleteProjectFiles(id, manifest) {
  const m = manifest || readProjectManifest(id)
  const paths = [manifestPath(id)]
  if (m) {
    if (m.outputPath) { paths.push(m.outputPath, m.outputPath + '.results.json', m.outputPath + '.feedback.json') }
    if (m.resultsPath) paths.push(m.resultsPath)
  }
  for (const p of paths) { try { if (p && fs.existsSync(p)) fs.unlinkSync(p) } catch (e) {} }
  delete jobs[id]
}

// restore saved projects, then run the first cleanup pass
loadProjects()
runCleanup()

let queuePaused = false
const WORKER_SILENCE_MS = 15 * 60 * 1000 // a worker silent this long is treated as hung

function enqueueJob(job) {
  jobQueue.push(job.id)
  pumpQueue()
}

function pumpQueue() {
  while (!queuePaused && runningJobs < MAX_CONCURRENT_JOBS && jobQueue.length > 0) {
    const job = jobs[jobQueue.shift()]
    if (job && job.status === 'queued') startWorker(job)
  }
}

// Stop a job: kill it if processing (frees the slot, next one starts), or drop it
// from the queue if still waiting. Marks it 'canceled' so the UI removes it.
function cancelJob(id) {
  const job = jobs[id]
  if (!job) return false
  if (job.status === 'queued') {
    const i = jobQueue.indexOf(id)
    if (i >= 0) jobQueue.splice(i, 1)
    job.status = 'canceled'
    job.statusMessage = 'Canceled'
    try { if (fs.existsSync(job.inputPath)) fs.unlinkSync(job.inputPath) } catch (e) {}
    return true
  }
  if (job.status === 'processing') {
    job.canceled = true
    try { job.proc && job.proc.kill() } catch (e) {}
    // finishJob runs on the child's close event, freeing the slot + pumping the queue
    return true
  }
  return false
}

// Watchdog: a worker that goes totally silent for too long is hung — kill it so
// it can never block the queue forever.
setInterval(() => {
  const now = Date.now()
  for (const id of Object.keys(jobs)) {
    const job = jobs[id]
    if (job.status === 'processing' && job.lastOutputAt && now - job.lastOutputAt > WORKER_SILENCE_MS) {
      console.error(`[job ${id}] no output for ${Math.round((now - job.lastOutputAt) / 60000)}m — treating as hung`)
      job.timedOut = true
      try { job.proc && job.proc.kill() } catch (e) {}
    }
  }
}, 30000).unref()

function startWorker(job) {
  runningJobs++
  job.status = 'processing'
  job.statusMessage = 'Starting analysis...'
  job.steps = []

  job.lastOutputAt = Date.now()
  let py
  try {
    py = spawnWorker('process', [job.inputPath, job.outputPath, JSON.stringify(job.config)], {
      env: {
        ...process.env,
        LUCIDCUT_DATA_DIR: DATA_DIR,
        LUCIDCUT_JOB_ID: job.id,
      },
    })
  } catch (e) {
    finishJob(job, 1, `failed to start worker: ${e.message}`)
    return
  }
  job.proc = py

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
    job.lastOutputAt = Date.now() // feed the hung-worker watchdog
    stderrTail = (stderrTail + text).slice(-3000)
    for (const line of text.split(/\r?\n|\r/)) {
      const cleanLine = line.trim()
      if (!cleanLine) continue
      // new protocol: "[step] Human label" — arrival-ordered checklist
      const stepMatch = cleanLine.match(/\[step\]\s*(.+)$/)
      if (stepMatch) {
        const label = stepMatch[1].trim()
        // close out whatever was running, then open the new step
        for (const s of job.steps) if (s.status === 'active') s.status = 'done'
        job.steps.push({ label, status: 'active' })
        job.statusMessage = label
      }
      // legacy "[step-N] msg" lines still drive the status text
      else if (cleanLine.includes('[step-')) {
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
  job.proc = null
  job.finishedAt = Date.now()
  job.resultsPath = job.outputPath + '.results.json'

  if (job.canceled) {
    job.status = 'canceled'
    job.statusMessage = 'Canceled'
  } else if (job.timedOut) {
    job.status = 'failed'
    job.statusMessage = 'Timed out'
    job.error = 'Processing stalled and was stopped. Please try again or use a different file.'
    if (job.steps) for (const s of job.steps) if (s.status === 'active') s.status = 'error'
  } else {
    try {
      if (fs.existsSync(job.resultsPath)) job.results = JSON.parse(fs.readFileSync(job.resultsPath, 'utf8'))
    } catch (e) {
      console.error(`[job ${job.id}] failed to read results: ${e.message}`)
    }
    if (code === 0) {
      job.status = 'completed'
      job.progress = 100
      job.statusMessage = 'Complete'
      if (job.steps) for (const s of job.steps) s.status = 'done'
      writeProjectManifest(job) // persist so it shows in Recents & survives restarts
    } else {
      job.status = 'failed'
      job.statusMessage = 'Processing failed'
      if (job.steps) for (const s of job.steps) if (s.status === 'active') s.status = 'error'
      job.error = (job.results && job.results.error)
        || (errorContext || '').split('\n').filter(Boolean).slice(-3).join(' ')
        || 'unknown worker error'
      console.error(`[job ${job.id}] failed: ${job.error}`)
    }
  }

  // input upload is no longer needed — the staged copy lives in outputs/
  try { if (fs.existsSync(job.inputPath)) fs.unlinkSync(job.inputPath) } catch (e) {}
  pumpQueue()
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------
app.get('/health', (req, res) => {
  execFile(FFMPEG, ['-version'], { timeout: 5000 }, (err) => {
    res.json({
      status: 'ok',
      ffmpeg: !err,
      python: fs.existsSync(PYTHON_BIN),
      activeJobs: runningJobs,
      queuedJobs: jobQueue.length,
    })
  })
})

app.post('/api/upload', videoUpload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no video file received' })
  const dropInput = () => { try { fs.unlinkSync(req.file.path) } catch (_) {} }

  let impurityDetectionConfig = {}
  if (req.body && req.body.impurityDetection) {
    try {
      impurityDetectionConfig = typeof req.body.impurityDetection === 'string'
        ? JSON.parse(req.body.impurityDetection)
        : req.body.impurityDetection
    } catch (e) {
      dropInput()
      return res.status(400).json({ error: 'invalid impurityDetection config' })
    }
  }

  const inputExt = path.extname(req.file.path).toLowerCase()
  const mediaType = AUDIO_EXT.has(inputExt) ? 'audio' : 'video'

  // SAFETY NET: never queue a long job on a broken/incomplete upload. Probe the
  // file first and confirm it's a complete, playable media file.
  let probe
  try {
    probe = await probeVideo(req.file.path)
  } catch (e) {
    dropInput()
    return res.status(400).json({ error: 'This file could not be read — it may be corrupted or still transferring. Please re-select it and try again.' })
  }
  if (!probe.duration || probe.duration <= 0) {
    dropInput()
    return res.status(400).json({ error: 'Could not determine this file\'s length — it looks incomplete or corrupted. Please try a different file.' })
  }
  if (mediaType === 'video' && !probe.hasVideo) {
    dropInput()
    return res.status(400).json({ error: 'No video track was found in this file.' })
  }
  if (!probe.hasAudio && !probe.hasVideo) {
    dropInput()
    return res.status(400).json({ error: 'This file has no audio or video streams.' })
  }

  const jobId = uuidv4()
  const job = {
    id: jobId,
    status: 'queued',
    progress: 0,
    statusMessage: 'Queued...',
    steps: [],
    mediaType,
    duration: probe.duration,
    inputPath: req.file.path,
    outputPath: path.join(OUTPUTS_DIR, `${jobId}${inputExt}`),
    originalName: req.file.originalname,
    createdAt: Date.now(),
    config: { impurityDetection: impurityDetectionConfig },
  }
  jobs[jobId] = job
  enqueueJob(job)

  res.json({ jobId })
})

// ---------------------------------------------------------------------------
// queue: list active jobs + control them (stop / pause / resume)
// ---------------------------------------------------------------------------
app.get('/api/queue', (req, res) => {
  const active = Object.values(jobs)
    .filter(j => j.status === 'queued' || j.status === 'processing')
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .map(queueJob)
  res.json({ paused: queuePaused, jobs: active })
})

// stop a processing job (next one proceeds) or remove a queued one
app.post('/api/jobs/:id/cancel', (req, res) => {
  const ok = cancelJob(req.params.id)
  if (!ok) return res.status(404).json({ error: 'job not found or already finished' })
  res.json({ status: 'canceled' })
})

app.post('/api/queue/pause', (req, res) => { queuePaused = true; res.json({ paused: true }) })
app.post('/api/queue/resume', (req, res) => { queuePaused = false; pumpQueue(); res.json({ paused: false }) })

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs[req.params.id]
  if (!job) return res.status(404).json({ error: 'job not found' })
  res.json(publicJob(job))
})

app.get('/api/jobs/:id/results', (req, res) => {
  const job = jobs[req.params.id]
  if (!job) return res.status(404).json({ error: 'job not found' })
  const rp = job.resultsPath
  if (rp && fs.existsSync(rp)) {
    try { return res.json(JSON.parse(fs.readFileSync(rp, 'utf8'))) }
    catch (e) { return res.status(500).json({ error: 'failed to read results' }) }
  }
  // restored projects may have the results in memory even if the file is gone
  if (job.results) return res.json(job.results)
  return res.status(404).json({ error: 'results not ready' })
})

// ---------------------------------------------------------------------------
// projects (recents / restore / autosave)
// ---------------------------------------------------------------------------
app.get('/api/projects', (req, res) => {
  let files = []
  try { files = fs.readdirSync(PROJECTS_DIR).filter(f => f.endsWith('.json')) } catch (e) {}
  const cutoff = Date.now() - PROJECT_RETENTION_MS
  const list = files.map(f => readProjectManifest(path.basename(f, '.json')))
    .filter(m => m && (m.completedAt || m.createdAt || 0) >= cutoff)
    .map(m => ({
      id: m.id, name: m.name, mediaType: m.mediaType, duration: m.duration,
      createdAt: m.createdAt, completedAt: m.completedAt,
      available: !!(m.outputPath && fs.existsSync(m.outputPath)),
      detectionCount: m.results ? ((m.results.profanity_detections || []).length + (m.results.imagery_detections || []).length) : 0,
    }))
    .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))
  res.json({ projects: list })
})

app.get('/api/projects/:id', (req, res) => {
  const m = readProjectManifest(req.params.id)
  if (!m) return res.status(404).json({ error: 'project not found' })
  const available = !!(m.outputPath && fs.existsSync(m.outputPath))
  res.json({
    id: m.id, name: m.name, mediaType: m.mediaType, duration: m.duration,
    results: m.results, edits: m.edits || null, available,
  })
})

// autosave the editor's timeline edits for crash recovery
app.post('/api/projects/:id/edits', (req, res) => {
  const m = readProjectManifest(req.params.id)
  if (!m) return res.status(404).json({ error: 'project not found' })
  const edits = req.body && req.body.edits
  if (!Array.isArray(edits) || edits.length > 2000) return res.status(400).json({ error: 'invalid edits' })
  m.edits = edits
  try { fs.writeFileSync(manifestPath(m.id), JSON.stringify(m)); if (jobs[m.id]) jobs[m.id].edits = edits }
  catch (e) { return res.status(500).json({ error: 'failed to save edits' }) }
  res.json({ status: 'saved' })
})

app.delete('/api/projects/:id', (req, res) => {
  if (!readProjectManifest(req.params.id)) return res.status(404).json({ error: 'project not found' })
  deleteProjectFiles(req.params.id)
  res.json({ status: 'deleted' })
})

app.delete('/api/projects', (req, res) => {
  let files = []
  try { files = fs.readdirSync(PROJECTS_DIR).filter(f => f.endsWith('.json')) } catch (e) {}
  for (const f of files) deleteProjectFiles(path.basename(f, '.json'))
  res.json({ status: 'cleared', count: files.length })
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
    // turn imagery feedback into labeled training crops, then (maybe) retrain
    let labeled = 0
    try { labeled = labelCropsFromFeedback(job.id, feedback) } catch (e) {
      console.error(`[feedback] labeling failed: ${e.message}`)
    }
    if (labeled > 0) maybeTrainModel()
    res.json({ status: 'saved', count: feedback.length, labeled })
  } catch (e) {
    console.error(`[feedback] write failed: ${e.message}`)
    res.status(500).json({ error: 'failed to save feedback' })
  }
})

// Report a rough hardware tier so the editor can pick the right tracker and warn
// before heavy features on weak machines.
function hardwareTier() {
  const cores = os.cpus() ? os.cpus().length : 2
  const memGB = os.totalmem() / (1024 ** 3)
  let tier = 'mid'
  if (cores >= 8 && memGB >= 16) tier = 'high'
  else if (cores <= 2 || memGB < 4) tier = 'low'
  return { tier, cores, memGB: Math.round(memGB) }
}
app.get('/api/capabilities', (req, res) => {
  res.json(hardwareTier())
})

// Follow-track a subject: given a start time + initial box, return per-keyframe
// boxes that follow it through the scene (lightweight OpenCV tracker, tier-aware).
app.post('/api/jobs/:id/track', (req, res) => {
  const job = jobs[req.params.id]
  if (!job || !job.outputPath || !fs.existsSync(job.outputPath)) {
    return res.status(404).json({ error: 'job not found or source video expired' })
  }
  const { time, box } = req.body || {}
  if (typeof time !== 'number' || !box || typeof box !== 'object') {
    return res.status(400).json({ error: 'time (number) and box are required' })
  }
  const tier = (req.body && req.body.tier) || hardwareTier().tier
  const payload = JSON.stringify({ video: job.outputPath, time, box, tier })
  let py
  try {
    py = spawnWorker('track', [payload], { env: { ...process.env, LUCIDCUT_DATA_DIR: DATA_DIR } })
  } catch (e) {
    return res.status(500).json({ error: `failed to start tracker: ${e.message}` })
  }
  let out = '', err = ''
  py.stdout.on('data', d => { out += d.toString() })
  py.stderr.on('data', d => { err = (err + d.toString()).slice(-500) })
  const killer = setTimeout(() => { try { py.kill() } catch (e) {} }, 120000)
  py.on('error', (e) => { clearTimeout(killer); res.status(500).json({ error: `tracker error: ${e.message}` }) })
  py.on('close', () => {
    clearTimeout(killer)
    try {
      const line = out.trim().split('\n').filter(Boolean).pop() || '{}'
      const result = JSON.parse(line)
      if (result.error) return res.status(500).json({ error: result.error })
      res.json(result)
    } catch (e) {
      res.status(500).json({ error: 'tracking failed', detail: (err || out).slice(-300) })
    }
  })
})

// A user-confirmed training crop captured in the editor (e.g. an FX box the user
// marked as "should have been flagged"). Saved straight into the labeled set.
app.post('/api/jobs/:id/sample', (req, res) => {
  const { label, image } = req.body || {}
  if (label !== 'positive' && label !== 'negative') {
    return res.status(400).json({ error: 'label must be positive or negative' })
  }
  if (typeof image !== 'string' || !image.startsWith('data:image/')) {
    return res.status(400).json({ error: 'image must be a data URL' })
  }
  try {
    const buf = Buffer.from(image.split(',')[1] || '', 'base64')
    if (buf.length === 0 || buf.length > 4 * 1024 * 1024) {
      return res.status(413).json({ error: 'image missing or too large' })
    }
    const dest = path.join(TRAINING_LABELED_DIR, label, `manual-${uuidv4()}.jpg`)
    fs.writeFileSync(dest, buf)
    maybeTrainModel()
    res.json({ status: 'saved' })
  } catch (e) {
    console.error(`[sample] write failed: ${e.message}`)
    res.status(500).json({ error: 'failed to save sample' })
  }
})

// ---------------------------------------------------------------------------
// personalized model: label crops from review feedback, then train in the bg
// ---------------------------------------------------------------------------
function countSamples(label) {
  try {
    return fs.readdirSync(path.join(TRAINING_LABELED_DIR, label))
      .filter(f => f.endsWith('.jpg')).length
  } catch (e) { return 0 }
}

// Move a pending detection crop (saved by the worker as <jobId>/<detId>.jpg)
// into labeled/positive|negative based on the user's Review-screen choice.
function labelCropsFromFeedback(jobId, feedback) {
  const pendingDir = path.join(TRAINING_PENDING_DIR, jobId)
  if (!fs.existsSync(pendingDir)) return 0
  let moved = 0
  for (const f of feedback) {
    if (f.type !== 'unsafe' || !f.id) continue
    // keep / change_severity = a real detection (positive); remove = false positive
    let label
    if (f.action === 'remove') label = 'negative'
    else if (f.action === 'keep' || f.action === 'change_severity') label = 'positive'
    else continue // 'add' has no source crop

    const srcJpg = path.join(pendingDir, `${f.id}.jpg`)
    if (!fs.existsSync(srcJpg)) continue
    const destBase = path.join(TRAINING_LABELED_DIR, label, `${jobId}_${f.id}`)
    try {
      fs.renameSync(srcJpg, `${destBase}.jpg`)
      const srcMeta = path.join(pendingDir, `${f.id}.json`)
      if (fs.existsSync(srcMeta)) fs.renameSync(srcMeta, `${destBase}.json`)
      moved++
    } catch (e) {
      console.error(`[feedback] could not file crop ${f.id}: ${e.message}`)
    }
  }
  return moved
}

let trainingProc = null
function maybeTrainModel() {
  if (trainingProc) return // already training
  const pos = countSamples('positive')
  const neg = countSamples('negative')
  if (pos < MIN_SAMPLES_PER_CLASS || neg < MIN_SAMPLES_PER_CLASS) {
    console.log(`[train] not enough samples yet (pos=${pos}, neg=${neg}, need ${MIN_SAMPLES_PER_CLASS} each)`)
    return
  }
  console.log(`[train] retraining personalized filter (pos=${pos}, neg=${neg})`)
  try {
    trainingProc = spawnWorker('train', [], {
      env: { ...process.env, LUCIDCUT_DATA_DIR: DATA_DIR },
    })
  } catch (e) {
    console.error(`[train] failed to start: ${e.message}`)
    trainingProc = null
    return
  }
  let tail = ''
  const onData = (d) => { tail = (tail + d.toString()).slice(-1000) }
  trainingProc.stdout.on('data', onData)
  trainingProc.stderr.on('data', onData)
  trainingProc.on('error', (e) => { console.error(`[train] ${e.message}`); trainingProc = null })
  trainingProc.on('close', (code) => {
    console.log(`[train] finished (code ${code})${tail ? `: ${tail.trim().split('\n').slice(-2).join(' ')}` : ''}`)
    trainingProc = null
  })
}

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
    edits = sanitizeEdits(expandTrackedEdits(rawEdits), probe.duration)
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

  const outExt = probe.hasVideo ? 'mp4' : 'm4a'
  const outputFilename = `${job.id}_final_${Date.now()}.${outExt}`
  const exportPath = path.join(EDITED_DIR, outputFilename)

  // optional burn-in subtitles (.srt already timed to the edited timeline by the client)
  let subtitleBase = null
  let subtitlePath = null
  const rawSubs = typeof req.body.subtitles === 'string' ? req.body.subtitles.trim() : ''
  if (rawSubs && probe.hasVideo) {
    subtitleBase = `${job.id}_${Date.now()}.srt`
    subtitlePath = path.join(EDITED_DIR, subtitleBase)
    try {
      fs.writeFileSync(subtitlePath, rawSubs, 'utf8')
    } catch (e) {
      dropUploads()
      return res.status(500).json({ error: `could not write subtitles: ${e.message}` })
    }
  }
  const dropSubs = () => { if (subtitlePath) { try { fs.unlinkSync(subtitlePath) } catch (e) {} } }

  let built
  try {
    built = buildExportArgs({
      inputPath: job.outputPath,
      outputPath: exportPath,
      edits,
      customFiles,
      duration: probe.duration,
      hasAudio: probe.hasAudio,
      hasVideo: probe.hasVideo,
      width: probe.width,
      height: probe.height,
      subtitleFile: subtitleBase,
    })
  } catch (e) {
    dropUploads()
    dropSubs()
    return res.status(400).json({ error: e.message })
  }

  console.log(`[export ${job.id}] ffmpeg ${built.args.join(' ')}`)
  job.export = { status: 'processing', progress: 0, startedAt: Date.now(), error: null }

  // cwd = EDITED_DIR so the subtitles filter resolves the .srt by basename
  const ffmpeg = spawn(FFMPEG, built.args, { cwd: EDITED_DIR })
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
    dropSubs()
  })
  ffmpeg.on('close', (code) => {
    if (code === 0) {
      job.export.status = 'completed'
      job.export.progress = 100
      job.editedOutputPath = exportPath
      job.editedFileName = `${path.basename(job.originalName || 'media', path.extname(job.originalName || ''))}_censored.${outExt}`
      console.log(`[export ${job.id}] complete`)
    } else {
      job.export.status = 'failed'
      job.export.error = stderrTail.split('\n').filter(Boolean).slice(-4).join(' ')
      console.error(`[export ${job.id}] ffmpeg exited ${code}:\n${stderrTail}`)
    }
    dropUploads()
    dropSubs()
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
