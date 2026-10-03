const fs = require('fs')

// Quiet frames below this peak are treated as silence when trimming ends.
const TRIM_PEAK = Math.pow(10, -50 / 20)

function writeAll(fd, buffer) {
  let offset = 0
  while (offset < buffer.length) {
    const wrote = fs.writeSync(fd, buffer, offset)
    if (wrote <= 0) throw new Error('Failed to write audio data')
    offset += wrote
  }
}

function readExact(fd, buffer, length, position) {
  let offset = 0
  while (offset < length) {
    const got = fs.readSync(fd, buffer, offset, length - offset, position + offset)
    if (got <= 0) break
    offset += got
  }
  return offset
}

function createFloatCapture(filePath) {
  const fd = fs.openSync(filePath, 'w')
  let bytes = 0
  return {
    path: filePath,
    get bytes() {
      return bytes
    },
    append(buffer) {
      writeAll(fd, buffer)
      bytes += buffer.length
    },
    close() {
      fs.closeSync(fd)
    },
  }
}

function frameCount(filePath, channels) {
  const size = fs.statSync(filePath).size
  const frameBytes = channels * 4
  return Math.floor(size / frameBytes)
}

function findAudibleRange(filePath, options) {
  const channels = options.channels
  const sampleRate = options.sampleRate
  const peakThreshold = options.peakThreshold == null ? TRIM_PEAK : options.peakThreshold
  const padSeconds = options.padSeconds == null ? 0.12 : options.padSeconds
  const frameBytes = channels * 4
  const totalFrames = frameCount(filePath, channels)
  if (totalFrames <= 0) return { allSilent: true, totalFrames: 0, startFrame: 0, endFrame: 0 }

  const fd = fs.openSync(filePath, 'r')
  const chunkFrames = Math.max(1, sampleRate)
  const buf = Buffer.alloc(chunkFrames * frameBytes)
  let first = -1
  let last = -1

  try {
    for (let frame = 0; frame < totalFrames; frame += chunkFrames) {
      const nFrames = Math.min(chunkFrames, totalFrames - frame)
      const got = readExact(fd, buf, nFrames * frameBytes, frame * frameBytes)
      const framesRead = Math.floor(got / frameBytes)
      for (let i = 0; i < framesRead; i++) {
        let peak = 0
        for (let c = 0; c < channels; c++) {
          const sample = Math.abs(buf.readFloatLE((i * channels + c) * 4))
          if (sample > peak) peak = sample
        }
        if (peak >= peakThreshold) {
          if (first < 0) first = frame + i
          last = frame + i
        }
      }
    }
  } finally {
    fs.closeSync(fd)
  }

  if (first < 0) {
    return { allSilent: true, totalFrames, startFrame: 0, endFrame: totalFrames }
  }

  const pad = Math.floor(sampleRate * padSeconds)
  const startFrame = Math.max(0, first - pad)
  const endFrame = Math.min(totalFrames, last + 1 + pad)
  return { allSilent: false, totalFrames, startFrame, endFrame }
}

function writeInt24(buffer, offset, sample) {
  const clamped = Math.max(-1, Math.min(1, sample))
  let value = Math.round(clamped * 8388607)
  if (value > 8388607) value = 8388607
  if (value < -8388608) value = -8388608
  buffer[offset] = value & 0xff
  buffer[offset + 1] = (value >> 8) & 0xff
  buffer[offset + 2] = (value >> 16) & 0xff
}

function buildWavHeader(sampleRate, channels, dataBytes) {
  const header = Buffer.alloc(44)
  const blockAlign = channels * 3
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * blockAlign, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(24, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataBytes, 40)
  return header
}

function writeWav24(floatPath, wavPath, options) {
  const channels = options.channels
  const sampleRate = options.sampleRate
  const frameBytes = channels * 4
  const totalFrames = frameCount(floatPath, channels)
  const startFrame = Math.max(0, options.startFrame || 0)
  const endFrame = options.endFrame == null ? totalFrames : Math.min(totalFrames, options.endFrame)
  const frames = Math.max(0, endFrame - startFrame)
  const dataBytes = frames * channels * 3

  const fdIn = fs.openSync(floatPath, 'r')
  const fdOut = fs.openSync(wavPath, 'w')
  try {
    writeAll(fdOut, buildWavHeader(sampleRate, channels, dataBytes))
    const chunkFrames = Math.max(1, Math.floor(48000 / Math.max(1, channels)))
    const inBuf = Buffer.alloc(chunkFrames * frameBytes)
    const outBuf = Buffer.alloc(chunkFrames * channels * 3)
    for (let frame = startFrame; frame < endFrame; frame += chunkFrames) {
      const nFrames = Math.min(chunkFrames, endFrame - frame)
      const got = readExact(fdIn, inBuf, nFrames * frameBytes, frame * frameBytes)
      const framesRead = Math.floor(got / frameBytes)
      let out = 0
      for (let i = 0; i < framesRead * channels; i++) {
        writeInt24(outBuf, out, inBuf.readFloatLE(i * 4))
        out += 3
      }
      writeAll(fdOut, outBuf.subarray(0, framesRead * channels * 3))
    }
  } finally {
    fs.closeSync(fdIn)
    fs.closeSync(fdOut)
  }

  return { frames, dataBytes, sampleRate, channels }
}

function rms(floatPath, channels) {
  const frameBytes = channels * 4
  const totalFrames = frameCount(floatPath, channels)
  if (totalFrames <= 0) return 0
  const fd = fs.openSync(floatPath, 'r')
  const chunkFrames = Math.max(1, 48000)
  const buf = Buffer.alloc(chunkFrames * frameBytes)
  let sum = 0
  let count = 0
  try {
    for (let frame = 0; frame < totalFrames; frame += chunkFrames) {
      const nFrames = Math.min(chunkFrames, totalFrames - frame)
      const got = readExact(fd, buf, nFrames * frameBytes, frame * frameBytes)
      const samples = Math.floor(got / 4)
      for (let i = 0; i < samples; i++) {
        const sample = buf.readFloatLE(i * 4)
        sum += sample * sample
        count++
      }
    }
  } finally {
    fs.closeSync(fd)
  }
  if (!count) return 0
  return Math.sqrt(sum / count)
}

module.exports = {
  TRIM_PEAK,
  createFloatCapture,
  frameCount,
  findAudibleRange,
  writeWav24,
  rms,
}
