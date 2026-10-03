const SILENCE_RMS = Math.pow(10, -50 / 20)
const SILENCE_LIMIT_SECONDS = 60
const DEFAULT_STATUS = 'Play audio in the page, then press Record.'

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
const downloadsButton = document.getElementById('downloads')
const newTabButton = document.getElementById('new-tab')
const tabsEl = document.getElementById('tabs')

const sessions = new Map()
let tabList = []
let activeTabId = null
let editingUrl = false
let lastUrl = ''
let silenceStop = true
let outputMuted = false

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

function sessionFor(tabId) {
  const id = Number(tabId)
  if (!sessions.has(id)) {
    sessions.set(id, {
      tabId: id,
      state: 'idle',
      statusText: DEFAULT_STATUS,
      statusKind: '',
      timer: '0:00',
      meter: 0,
      audioContext: null,
      mediaStream: null,
      workletNode: null,
      sourceNode: null,
      sinkNode: null,
      channels: 2,
      sampleRate: 48000,
      recordedFrames: 0,
      silentFrames: 0,
      startedFile: null,
      writeChain: Promise.resolve(),
      stopReason: 'user',
      stopLock: null,
    })
  }
  return sessions.get(id)
}

function activeSession() {
  return activeTabId == null ? null : sessions.get(activeTabId) || null
}

function paintActive() {
  const session = activeSession()
  const recording = session && (session.state === 'recording' || session.state === 'stopping')
  recordButton.disabled = !!(session && (session.state === 'starting' || session.state === 'stopping'))
  recordButton.classList.toggle('recording', !!recording)
  recordButton.setAttribute('aria-label', recording ? 'Stop recording' : 'Record')
  recordButton.title = recording ? 'Stop recording this tab (F9)' : 'Record this tab (F9)'
  timerEl.textContent = session ? session.timer : '0:00'
  meterFill.style.transform = `scaleX(${session ? session.meter : 0})`
  statusEl.textContent = session ? session.statusText : DEFAULT_STATUS
  statusEl.classList.toggle('recording', !!(session && session.statusKind === 'recording'))
  statusEl.classList.toggle('error', !!(session && session.statusKind === 'error'))
}

function renderTabs() {
  tabsEl.replaceChildren()
  for (const tab of tabList) {
    const session = sessionFor(tab.id)
    const recording = session.state === 'recording' || session.state === 'starting' || session.state === 'stopping'
    const el = document.createElement('div')
    el.className = 'tab' + (tab.id === activeTabId ? ' active' : '') + (recording ? ' recording' : '')
    el.title = tab.url || tab.title

    const rec = document.createElement('button')
    rec.type = 'button'
    rec.className = 'tab-rec'
    rec.textContent = recording ? '■' : '●'
    rec.title = recording ? 'Stop recording this tab' : 'Record this tab'
    rec.addEventListener('click', (event) => {
      event.stopPropagation()
      toggleRecording(sessionFor(tab.id))
    })

    const title = document.createElement('button')
    title.type = 'button'
    title.className = 'tab-title'
    title.textContent = tab.title || 'New tab'
    title.addEventListener('click', () => window.capture.selectTab(tab.id))

    const down = document.createElement('button')
    down.type = 'button'
    down.className = 'tab-down'
    down.textContent = '↓'
    down.disabled = !tab.lastDownload
    down.title = tab.lastDownload ? `Show ${tab.lastDownload}` : 'No download from this tab yet'
    down.addEventListener('click', (event) => {
      event.stopPropagation()
      void window.capture.openDownload(tab.id)
    })

    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'tab-close'
    close.textContent = '×'
    close.title = 'Close tab'
    close.addEventListener('click', (event) => {
      event.stopPropagation()
      void window.capture.closeTab(tab.id)
    })

    el.append(rec, title, down, close)
    el.addEventListener('click', () => window.capture.selectTab(tab.id))
    tabsEl.append(el)
  }
}

function setStatus(session, text, kind) {
  session.statusText = text
  session.statusKind = kind || ''
  if (session.tabId === activeTabId) paintActive()
}

function renderMute() {
  muteButton.classList.toggle('muted', outputMuted)
  muteButton.setAttribute('aria-pressed', outputMuted ? 'true' : 'false')
  muteButton.setAttribute('aria-label', outputMuted ? 'Unmute this tab' : 'Mute this tab')
  muteButton.title = outputMuted
    ? 'This tab is muted. Recording still captures it.'
    : 'Mute this tab. Recording still captures it.'
}

async function captureStream(tabId) {
  const attempts = [
    { video: false, audio: true },
    { video: true, audio: true },
  ]
  let lastError = null
  for (const constraints of attempts) {
    window.capture.prepareCapture(tabId)
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia(constraints)
      if (stream.getAudioTracks().length === 0) {
        stream.getTracks().forEach((track) => track.stop())
        throw new Error('The browser did not return an audio track.')
      }
      for (const track of stream.getVideoTracks()) track.enabled = false
      return stream
    } catch (error) {
      window.capture.cancelCapture(tabId)
      lastError = error
    }
  }
  throw lastError || new Error('Could not capture browser audio.')
}

function teardownAudio(session) {
  try { session.sourceNode && session.sourceNode.disconnect() } catch {}
  try { session.workletNode && session.workletNode.disconnect() } catch {}
  try { session.sinkNode && session.sinkNode.disconnect() } catch {}
  if (session.mediaStream) session.mediaStream.getTracks().forEach((track) => track.stop())
  const closing = session.audioContext ? session.audioContext.close() : Promise.resolve()
  session.sourceNode = null
  session.workletNode = null
  session.sinkNode = null
  session.mediaStream = null
  session.audioContext = null
  return closing
}

async function processChunk(session, data) {
  if (session.state !== 'recording' && session.state !== 'stopping') return
  const chunkChannels = data.channels || session.channels
  if (!session.startedFile) {
    session.channels = chunkChannels
    session.startedFile = window.capture.beginFile({
      tabId: session.tabId,
      sampleRate: session.sampleRate,
      channels: session.channels,
    }).then((result) => {
      if (!result || result.ok === false) {
        throw new Error((result && result.error) || 'Could not open the recording file.')
      }
      return result
    })
  }
  await session.startedFile
  if (!data.samples || data.samples.length === 0) return
  let sum = 0
  for (let i = 0; i < data.samples.length; i++) sum += data.samples[i] * data.samples[i]
  const rms = Math.sqrt(sum / Math.max(1, data.samples.length))
  const db = 20 * Math.log10(rms + 1e-8)
  session.meter = Math.max(0, Math.min(1, (db + 60) / 60))
  window.capture.writeChunk(session.tabId, data.samples)
  const frames = data.samples.length / chunkChannels
  session.recordedFrames += frames
  if (rms < SILENCE_RMS) session.silentFrames += frames
  else session.silentFrames = 0
  session.timer = formatDuration(session.recordedFrames / session.sampleRate)
  const silentSeconds = session.silentFrames / session.sampleRate
  if (silenceStop && silentSeconds >= 2 && session.state === 'recording') {
    setStatus(session, `Silence for ${Math.floor(silentSeconds)}s — auto-stop at ${SILENCE_LIMIT_SECONDS}s`, 'recording')
  } else if (session.state === 'recording') {
    setStatus(session, 'Recording', 'recording')
  }
  if (session.tabId === activeTabId) paintActive()
  if (silenceStop && silentSeconds >= SILENCE_LIMIT_SECONDS && session.state === 'recording') {
    void stopRecording(session, { reason: 'silence' })
  }
}

function enqueueChunk(session, data) {
  session.writeChain = session.writeChain.then(() => processChunk(session, data)).catch((error) => {
    console.error(error)
    setStatus(session, error.message || 'Failed while writing audio.', 'error')
  })
}

function markState(session, state) {
  const previous = session.state
  session.state = state
  if (session.tabId === activeTabId) paintActive()
  if (previous !== state) renderTabs()
}

async function startRecording(session) {
  if (!session || session.state !== 'idle') return
  markState(session, 'starting')
  session.stopReason = 'user'
  session.recordedFrames = 0
  session.silentFrames = 0
  session.startedFile = null
  session.writeChain = Promise.resolve()
  session.timer = '0:00'
  session.meter = 0
  setStatus(session, 'Starting…')

  try {
    session.audioContext = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' })
    const resumed = session.audioContext.resume()
    session.mediaStream = await captureStream(session.tabId)
    await resumed
    if (session.audioContext.state === 'suspended') await session.audioContext.resume()
    session.sampleRate = session.audioContext.sampleRate
    const track = session.mediaStream.getAudioTracks()[0]
    track.addEventListener('ended', () => {
      if (session.state === 'recording') void stopRecording(session, { reason: 'ended' })
    })
    await session.audioContext.audioWorklet.addModule(new URL('recorder-worklet.js', window.location.href).href)
    session.workletNode = new AudioWorkletNode(session.audioContext, 'recorder-processor')
    session.workletNode.port.onmessage = (event) => enqueueChunk(session, event.data || {})
    session.sourceNode = session.audioContext.createMediaStreamSource(session.mediaStream)
    session.sinkNode = session.audioContext.createGain()
    session.sinkNode.gain.value = 0
    session.sourceNode.connect(session.workletNode)
    session.workletNode.connect(session.sinkNode)
    session.sinkNode.connect(session.audioContext.destination)
    markState(session, 'recording')
    setStatus(session, 'Recording', 'recording')
  } catch (error) {
    console.error(error)
    window.capture.cancelCapture(session.tabId)
    await teardownAudio(session)
    markState(session, 'idle')
    setStatus(session, error.message || 'Could not start recording.', 'error')
  }
}

function stopRecording(session, options = {}) {
  if (!session) return Promise.resolve()
  if (session.stopLock) return session.stopLock
  if (session.state !== 'recording' && session.state !== 'starting') return Promise.resolve()
  session.stopLock = finishRecording(session, options).finally(() => {
    session.stopLock = null
  })
  return session.stopLock
}

async function finishRecording(session, options) {
  const reason = options.reason || session.stopReason
  markState(session, 'stopping')
  setStatus(session, 'Saving…')
  try {
    try { session.sourceNode && session.sourceNode.disconnect() } catch {}
    if (session.workletNode) {
      let flushDone = false
      const node = session.workletNode
      const flushed = new Promise((resolve) => {
        node.port.onmessage = (event) => {
          enqueueChunk(session, event.data || {})
          if (event.data && event.data.flush) {
            flushDone = true
            resolve()
          }
        }
        node.port.postMessage({ command: 'flush' })
        setTimeout(() => {
          if (!flushDone) resolve()
        }, 500)
      })
      await flushed
    }
    await session.writeChain
    await delay(50)
    await session.writeChain
    await teardownAudio(session)
    const result = await window.capture.endFile(session.tabId, {
      reason,
      skipDialog: !!options.skipDialog,
    })
    session.timer = formatDuration(result.durationSeconds || 0)
    session.meter = 0
    if (!result.ok) setStatus(session, result.error || 'Recording failed.', 'error')
    else if (result.trimmed) setStatus(session, `Trimmed and saved ${result.fileName}`)
    else if (result.note) setStatus(session, `Saved ${result.fileName}. ${result.note}`)
    else setStatus(session, `Saved ${result.fileName}`)
  } catch (error) {
    console.error(error)
    await teardownAudio(session)
    setStatus(session, error.message || 'Could not save the recording.', 'error')
  } finally {
    markState(session, 'idle')
  }
}

function toggleRecording(session) {
  const target = session || activeSession()
  if (!target) return
  if (target.state === 'idle') void startRecording(target)
  else if (target.state === 'recording') void stopRecording(target, { reason: 'user' })
}

function onTabs(payload) {
  tabList = payload.tabs || []
  activeTabId = payload.activeId
  const seen = new Set(tabList.map((tab) => tab.id))
  for (const id of sessions.keys()) {
    const session = sessions.get(id)
    if (!seen.has(id) && session.state === 'idle') sessions.delete(id)
  }
  for (const tab of tabList) sessionFor(tab.id)
  const active = tabList.find((tab) => tab.id === activeTabId)
  if (active) {
    lastUrl = active.url || ''
    if (!editingUrl) urlInput.value = lastUrl
    backButton.disabled = !active.canGoBack
    forwardButton.disabled = !active.canGoForward
    reloadButton.textContent = active.loading ? '×' : '↻'
    reloadButton.setAttribute('aria-label', active.loading ? 'Stop loading' : 'Reload')
    outputMuted = !!active.muted
    renderMute()
    const session = sessionFor(active.id)
    if (session.state === 'idle' && active.loading && (session.statusText === DEFAULT_STATUS || session.statusText === 'Loading…')) {
      session.statusText = 'Loading…'
    } else if (session.state === 'idle' && !active.loading && session.statusText === 'Loading…') {
      session.statusText = DEFAULT_STATUS
    }
  }
  renderTabs()
  paintActive()
}

backButton.addEventListener('click', () => window.capture.back())
forwardButton.addEventListener('click', () => window.capture.forward())
reloadButton.addEventListener('click', () => window.capture.reload())
folderButton.addEventListener('click', () => window.capture.openFolder())
downloadsButton.addEventListener('click', () => window.capture.openDownload(activeTabId))
newTabButton.addEventListener('click', () => window.capture.newTab())
recordButton.addEventListener('click', () => toggleRecording(activeSession()))

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

silenceInput.addEventListener('change', () => {
  silenceStop = silenceInput.checked
  void window.capture.setSilenceStop(silenceStop)
})

muteButton.addEventListener('click', () => {
  outputMuted = !outputMuted
  renderMute()
  void window.capture.setOutputMuted(outputMuted, activeTabId)
})

window.addEventListener('keydown', (event) => {
  if (event.key === 'F9') {
    event.preventDefault()
    toggleRecording(activeSession())
  }
})

window.capture.onTabs(onTabs)
window.capture.onDownload((payload) => {
  const session = sessions.get(payload.tabId) || activeSession()
  if (!session || session.state === 'recording' || session.state === 'stopping' || session.state === 'starting') return
  if (payload.state === 'completed') setStatus(session, `Downloaded ${payload.fileName}`)
  else if (payload.state === 'progress') setStatus(session, `Downloading ${payload.fileName}`)
  else if (payload.state === 'interrupted' || payload.state === 'cancelled') {
    setStatus(session, `Download ${payload.state}`, 'error')
  }
})
window.capture.onFocusUrl(() => {
  urlInput.focus()
  urlInput.select()
})
window.capture.onRequestStop((payload) => {
  const options = {
    reason: payload.reason || 'quit',
    skipDialog: !!payload.skipDialog,
  }
  if (payload.all) {
    for (const session of sessions.values()) void stopRecording(session, options)
    return
  }
  const session = payload.tabId ? sessions.get(payload.tabId) : activeSession()
  void stopRecording(session, options)
})

window.capture.getSettings().then((settings) => {
  silenceStop = settings.silenceStop !== false
  silenceInput.checked = silenceStop
}).catch((error) => {
  console.error(error)
})
