'use strict'

const fs = require('fs')
const path = require('path')

// Packaged Electron GUI apps have no visible console — console.log/error just
// vanish. This gives support a real file to ask for when something like
// "ffprobe failed" happens on a machine we can't see. Written under
// LUCIDCUT_DATA_DIR so it survives updates like everything else there.
const DATA_DIR = process.env.LUCIDCUT_DATA_DIR || path.resolve(__dirname, '..', 'user-data')
const LOG_DIR = path.join(DATA_DIR, 'logs')
const LOG_FILE = path.join(LOG_DIR, 'backend.log')
const MAX_BYTES = 5 * 1024 * 1024 // rotate once the log gets unwieldy to open

function ensureDir() {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }) } catch (e) { /* best-effort */ }
}

function rotateIfNeeded() {
  try {
    const { size } = fs.statSync(LOG_FILE)
    if (size > MAX_BYTES) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`)
  } catch (e) { /* file may not exist yet — fine */ }
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`
  console.log(line) // still useful when running from a terminal (dev, debugging)
  try {
    ensureDir()
    rotateIfNeeded()
    fs.appendFileSync(LOG_FILE, line + '\n')
  } catch (e) { /* logging must never crash the app */ }
}

module.exports = { log, LOG_FILE }
