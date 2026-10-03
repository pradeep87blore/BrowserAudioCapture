const SILENCE_RMS = Math.pow(10, -50 / 20)
const SILENCE_LIMIT_SECONDS = 60

const backButton = document.getElementById('back')
const forwardButton = document.getElementById('forward')
const reloadButton = document.getElementById('reload')
const urlInput = document.getElementById('url')
const recordButton = document.getElementById('record')
const muteButton = document.getElementById('mute')
const timerEl = document.getElementById('timer')
const meterFill = document.getElementById('meter-fill')
const statusEl = document.getElementById('status')
const silenceInput = document.getElementById('silence-stop')
const folderButton = document.getElementById('folder')

let state = 'idle'
let editingUrl = false
let lastUrl = ''
let loading = false
let silenceStop = true
let outputMuted = false
let audioContext = null
let mediaStream = null
let workletNode = null
let sourceNode = null
let sinkNode = null
let channels = 2
let sampleRate = 48000
let recordedFrames = 0
let silentFrames = 0
let startedFile = null
let writeChain = Promise.resolve()
let stopReason = 'user'
let stopLock = null

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function formatDuration(seconds) {
  const whole = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const secs = whole % 60
  const pad = (value) => String(value).padStart(2, '0')
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(secs)}`
  return `${minutes}:${pad(secs)}`
}

function setStatus(text, kind) {
  statusEl.textContent = text
  statusEl.classList.toggle('recording', kind === 'recording')
  statusEl.classList.toggle('error', kind === 'error')
}

function updateRecordButton() {
  const busy = state === 'starting' || state === 'stopping'
  const recording = state === 'recording' || state === 'stopping'
  recordButton.disabled = busy
  recordButton.classList.toggle('recording', recording)
  recordButton.setAttribute('aria-label', recording ? 'Stop recording' : 'Record')
  recordButton.title = recording ? 'Stop recording (F9)' : 'Record browser audio (F9)'
}

function resetMeter() {
  meterFill.style.transform = 'scaleX(0)'
}

function updateMeter(samples) {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  const rms = Math.sqrt(sum / Math.max(1, samples.length))
  const db = 20 * Math.log10(rms + 1e-8)
  const level = Math.max(0, Math.min(1, (db + 60) / 60))
  meterFill.style.transform = `scaleX(${level})`
  return rms
}

function updateNav(data) {
  lastUrl = data.url || ''
  loading = !!data.loading
  if (!editingUrl) urlInput.value = lastUrl
  backButton.disabled = !data.canGoBack
  forwardButton.disabled = !data.canGoForward
  reloadButton.textContent = loading ? '×' : '↻'
  reloadButton.setAttribute('aria-label', loading ? 'Stop loading' : 'Reload')
  if (state === 'idle' && data.loading) setStatus('Loading…')
  else if (state === 'idle' && !data.loading && statusEl.textContent === 'Loading…') {
    setStatus('Play audio in the page, then press Record.')
  }
}

async function captureStream() {
  const attempts = [
    { video: false, audio: true },
    { video: true, audio: true },
  ]
  let lastError = null
  for (const constraints of attempts) {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia(constraints)
      if (stream.getAudioTracks().length === 0) {
        stream.getTracks().forEach((track) => track.stop())
        throw new Error('The browser did not return an audio track.')
      }
      for (const track of stream.getVideoTracks()) track.enabled = false
      console.log('CAPTURE_TRACKS', stream.getTracks().map((track) => `${track.kind}:${track.readyState}`).join(','))
      return stream
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error('Could not capture browser audio.')
}

function teardownAudio() {
  try { sourceNode && sourceNode.disconnect() } catch {}
  try { workletNode && workletNode.disconnect() } catch {}
  try { sinkNode && sinkNode.disconnect() } catch {}
  if (mediaStream) mediaStream.getTracks().forEach((track) => track.stop())
  const closing = audioContext ? audioContext.close() : Promise.resolve()
  sourceNode = null
  workletNode = null
  sinkNode = null
  mediaStream = null
  audioContext = null
  return closing
}

async function processChunk(data) {
  if (state !== 'recording' && state !== 'stopping') return
  const chunkChannels = data.channels || channels
  if (!startedFile) {
    channels = chunkChannels
    startedFile = window.capture.beginFile({ sampleRate, channels }).then((result) => {
      if (!result || result.ok === false) {
        throw new Error((result && result.error) || 'Could not open the recording file.')
      }
      return result
    })
  }
  await startedFile
  if (!data.samples || data.samples.length === 0) return
  const rms = updateMeter(data.samples)
  window.capture.writeChunk(data.samples)
  const frames = data.samples.length / chunkChannels
  recordedFrames += frames
  if (rms < SILENCE_RMS) silentFrames += frames
  else silentFrames = 0
  timerEl.textContent = formatDuration(recordedFrames / sampleRate)
  const silentSeconds = silentFrames / sampleRate
  if (silenceStop && silentSeconds >= 2 && state === 'recording') {
    setStatus(`Silence for ${Math.floor(silentSeconds)}s — auto-stop at ${SILENCE_LIMIT_SECONDS}s`, 'recording')
  } else if (state === 'recording') {
    setStatus('Recording', 'recording')
  }
  if (silenceStop && silentSeconds >= SILENCE_LIMIT_SECONDS && state === 'recording') {
    void stopRecording({ reason: 'silence' })
  }
}

function enqueueChunk(data) {
  writeChain = writeChain.then(() => processChunk(data)).catch((error) => {
    console.error(error)
    setStatus(error.message || 'Failed while writing audio.', 'error')
  })
}

async function startRecording() {
  if (state !== 'idle') return
  state = 'starting'
  stopReason = 'user'
  recordedFrames = 0
  silentFrames = 0
  startedFile = null
  writeChain = Promise.resolve()
  timerEl.textContent = '0:00'
  resetMeter()
  updateRecordButton()
  setStatus('Starting…')

  try {
    audioContext = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' })
    const resumed = audioContext.resume()
    mediaStream = await captureStream()
    await resumed
    if (audioContext.state === 'suspended') await audioContext.resume()
    sampleRate = audioContext.sampleRate
    const track = mediaStream.getAudioTracks()[0]
    track.addEventListener('ended', () => {
      if (state === 'recording') void stopRecording({ reason: 'ended' })
    })
    await audioContext.audioWorklet.addModule(new URL('recorder-worklet.js', window.location.href).href)
    workletNode = new AudioWorkletNode(audioContext, 'recorder-processor')
    workletNode.port.onmessage = (event) => enqueueChunk(event.data || {})
    sourceNode = audioContext.createMediaStreamSource(mediaStream)
    sinkNode = audioContext.createGain()
    sinkNode.gain.value = 0
    sourceNode.connect(workletNode)
    workletNode.connect(sinkNode)
    sinkNode.connect(audioContext.destination)
    state = 'recording'
    updateRecordButton()
    setStatus('Recording', 'recording')
  } catch (error) {
    console.error(error)
    await teardownAudio()
    state = 'idle'
    updateRecordButton()
    setStatus(error.message || 'Could not start recording.', 'error')
  }
}

function stopRecording(options = {}) {
  if (stopLock) return stopLock
  if (state !== 'recording' && state !== 'starting') return Promise.resolve()
  stopLock = finishRecording(options).finally(() => {
    stopLock = null
  })
  return stopLock
}

async function finishRecording(options) {
  const reason = options.reason || stopReason
  state = 'stopping'
  updateRecordButton()
  setStatus('Saving…')
  try {
    try { sourceNode && sourceNode.disconnect() } catch {}
    if (workletNode) {
      let flushDone = false
      const flushed = new Promise((resolve) => {
        workletNode.port.onmessage = (event) => {
          enqueueChunk(event.data || {})
          if (event.data && event.data.flush) {
            flushDone = true
            resolve()
          }
        }
        workletNode.port.postMessage({ command: 'flush' })
        setTimeout(() => {
          if (!flushDone) resolve()
        }, 500)
      })
      await flushed
    }
    await writeChain
    await delay(50)
    await writeChain
    await teardownAudio()
    const result = await window.capture.endFile({
      reason,
      skipDialog: !!options.skipDialog,
    })
    timerEl.textContent = formatDuration(result.durationSeconds || 0)
    resetMeter()
    if (!result.ok) {
      setStatus(result.error || 'Recording failed.', 'error')
    } else if (result.trimmed) {
      setStatus(`Trimmed and saved ${result.fileName}`)
    } else if (result.note) {
      setStatus(`Saved ${result.fileName}. ${result.note}`)
    } else {
      setStatus(`Saved ${result.fileName}`)
    }
  } catch (error) {
    console.error(error)
    await teardownAudio()
    setStatus(error.message || 'Could not save the recording.', 'error')
  } finally {
    state = 'idle'
    updateRecordButton()
  }
}

function toggleRecording() {
  if (state === 'idle') void startRecording()
  else if (state === 'recording') void stopRecording({ reason: 'user' })
}

backButton.addEventListener('click', () => window.capture.back())
forwardButton.addEventListener('click', () => window.capture.forward())
reloadButton.addEventListener('click', () => window.capture.reload())
folderButton.addEventListener('click', () => window.capture.openFolder())
recordButton.addEventListener('click', () => toggleRecording())

urlInput.addEventListener('focus', () => {
  editingUrl = true
  urlInput.select()
})
urlInput.addEventListener('blur', () => {
  editingUrl = false
  urlInput.value = lastUrl
})
urlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault()
    void window.capture.navigate(urlInput.value)
    urlInput.blur()
  }
})

function renderMute() {
  muteButton.classList.toggle('muted', outputMuted)
  muteButton.setAttribute('aria-pressed', outputMuted ? 'true' : 'false')
  muteButton.setAttribute('aria-label', outputMuted ? 'Unmute browser audio' : 'Mute browser audio')
  muteButton.title = outputMuted
    ? 'Browser audio is muted. Recording still captures the page.'
    : 'Mute this browser. Recording still captures the page.'
}

silenceInput.addEventListener('change', () => {
  silenceStop = silenceInput.checked
  void window.capture.setSilenceStop(silenceStop)
})

muteButton.addEventListener('click', () => {
  outputMuted = !outputMuted
  renderMute()
  void window.capture.setOutputMuted(outputMuted)
})

window.addEventListener('keydown', (event) => {
  if (event.key === 'F9') {
    event.preventDefault()
    toggleRecording()
  }
})

window.capture.onNav(updateNav)
window.capture.onFocusUrl(() => {
  urlInput.focus()
  urlInput.select()
})
window.capture.onRequestStop((payload) => {
  void stopRecording({
    reason: (payload && payload.reason) || 'quit',
    skipDialog: !!(payload && payload.skipDialog),
  })
})

window.capture.getSettings().then((settings) => {
  silenceStop = settings.silenceStop !== false
  silenceInput.checked = silenceStop
  outputMuted = settings.outputMuted === true
  renderMute()
}).catch((error) => {
  console.error(error)
})
