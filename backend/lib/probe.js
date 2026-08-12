'use strict'

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
    ], { timeout: 15000 }, (err, stdout) => {
      if (err) return reject(new Error(`ffprobe failed: ${err.message}`))
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
        reject(new Error(`ffprobe parse failed: ${e.message}`))
      }
    })
  })
}

module.exports = { probeVideo }
