const fs = require('fs')
const os = require('os')
const path = require('path')
const wav = require('../lib/wav')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bac-wav-'))
const floatPath = path.join(dir, 'tone.f32')
const wavPath = path.join(dir, 'tone.wav')
const sampleRate = 48000
const channels = 2
const capture = wav.createFloatCapture(floatPath)

function pushSeconds(seconds, fill) {
  const frames = Math.floor(sampleRate * seconds)
  const samples = new Float32Array(frames * channels)
  for (let i = 0; i < frames; i++) {
    const value = fill(i / sampleRate)
    samples[i * channels] = value
    samples[i * channels + 1] = value * 0.5
  }
  capture.append(Buffer.from(samples.buffer))
}

pushSeconds(1, () => 0)
pushSeconds(1, (t) => Math.sin(2 * Math.PI * 440 * t) * 0.2)
pushSeconds(1, () => 0)
capture.close()

const range = wav.findAudibleRange(floatPath, { channels, sampleRate, padSeconds: 0.12 })
assert(!range.allSilent, 'expected the tone to be audible')
const pad = Math.floor(sampleRate * 0.12)
assert(Math.abs(range.startFrame - (sampleRate - pad)) < sampleRate * 0.02, 'trim start is off: ' + range.startFrame)
assert(Math.abs(range.endFrame - (sampleRate * 2 + pad)) < sampleRate * 0.02, 'trim end is off: ' + range.endFrame)

const silentPath = path.join(dir, 'silent.f32')
const silent = wav.createFloatCapture(silentPath)
silent.append(Buffer.alloc(sampleRate * channels * 4))
silent.close()
const silentRange = wav.findAudibleRange(silentPath, { channels, sampleRate })
assert(silentRange.allSilent, 'expected all-silent file')

const written = wav.writeWav24(floatPath, wavPath, {
  sampleRate,
  channels,
  startFrame: range.startFrame,
  endFrame: range.endFrame,
})
const header = fs.readFileSync(wavPath)
assert(header.toString('ascii', 0, 4) === 'RIFF', 'missing RIFF')
assert(header.toString('ascii', 8, 12) === 'WAVE', 'missing WAVE')
assert(header.readUInt16LE(20) === 1, 'expected PCM format')
assert(header.readUInt16LE(22) === channels, 'channel count')
assert(header.readUInt32LE(24) === sampleRate, 'sample rate')
assert(header.readUInt16LE(34) === 24, 'expected 24-bit')
assert(header.readUInt32LE(40) === written.dataBytes, 'data size mismatch')
assert(header.length > 44, 'wav is header-only')

const fullRms = wav.rms(floatPath, channels)
assert(fullRms > 0.02, 'rms too low: ' + fullRms)

fs.rmSync(dir, { recursive: true, force: true })
console.log('WAV checks passed')
