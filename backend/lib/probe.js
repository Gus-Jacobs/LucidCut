'use strict'

const fs = require('fs')
const { execFile } = require('child_process')

const FFPROBE = process.env.LUCIDCUT_FFPROBE || 'ffprobe'

/**
 * ffprobe a media file. Resolves {duration, width, height, hasAudio, hasVideo}.
 * Duration is 0 when unknown rather than rejecting, so callers can degrade.
 */
function probeVideo(filePath) {
  return new Promise((resolve, reject) => {
    execFile(FFPROBE, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-show_entries', 'stream=codec_type,width,height',
      '-of', 'json',
      filePath,
    ], { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) {
        // err.code (e.g. ENOENT) means the binary itself couldn't run — a
        // packaging/AV/permissions problem. A clean exit with stderr text
        // means ffprobe ran fine and the *file* is genuinely bad. Distinguishing
        // those from the log is the whole point of capturing this much detail.
        const detail = [
          err.message,
          `binary=${FFPROBE}`,
          `binaryExists=${safeExists(FFPROBE)}`,
          err.code ? `errorCode=${err.code}` : null,
          err.killed ? 'killedByTimeout=true' : null,
          typeof err.signal === 'string' ? `signal=${err.signal}` : null,
          stderr && stderr.trim() ? `stderr=${stderr.trim().slice(0, 500)}` : null,
        ].filter(Boolean).join(' | ')
        return reject(new Error(`ffprobe failed: ${detail}`))
      }
      try {
        const data = JSON.parse(stdout)
        const streams = data.streams || []
        const video = streams.find(s => s.codec_type === 'video')
        resolve({
          duration: parseFloat(data.format && data.format.duration) || 0,
          width: (video && video.width) || 0,
          height: (video && video.height) || 0,
          hasAudio: streams.some(s => s.codec_type === 'audio'),
          hasVideo: !!video,
        })
      } catch (e) {
        reject(new Error(`ffprobe parse failed: ${e.message} | stdout=${(stdout || '').slice(0, 300)}`))
      }
    })
  })
}

function safeExists(p) {
  try { return fs.existsSync(p) } catch (e) { return 'unknown' }
}

module.exports = { probeVideo }
