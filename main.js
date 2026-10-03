const { app, BaseWindow, WebContentsView, session, dialog, ipcMain, shell, protocol, webContents } = require('electron')
const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')
const wav = require('./lib/wav')

const PARTITION = 'persist:browser'
const CHROME_HEIGHT = 104
const SELF_TEST = process.argv.includes('--self-test')
const COOKIE_CHECK = process.argv.includes('--self-test-cookies')

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')

if (app.userAgentFallback) {
  app.userAgentFallback = app.userAgentFallback.replace(/\sElectron\/\S+/, '')
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
])

let win = null
let chromeView = null
let browserView = null
let browserSession = null
let capture = null
let recordingFinished = null
let captureDir = ''
let settingsPath = ''
let closeAfterSave = false
let quitting = false
let outputMuted = false

function captureDirectory() {
  return path.join(__dirname, 'captured')
}

function loadSettings() {
  try {
    const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    return {
      silenceStop: data.silenceStop !== false,
      outputMuted: data.outputMuted === true,
      lastUrl: typeof data.lastUrl === 'string' ? data.lastUrl : '',
    }
  } catch {
    return { silenceStop: true, outputMuted: false, lastUrl: '' }
  }
}

function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch }
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2))
  return next
}

function cleanupTemps() {
  if (!fs.existsSync(captureDir)) return
  for (const name of fs.readdirSync(captureDir)) {
    if (name.startsWith('.recording-') && name.endsWith('.f32')) {
      fs.rmSync(path.join(captureDir, name), { force: true })
    }
  }
}

function browserFrame() {
  const contents = browserView && browserView.webContents
  if (!contents || contents.isDestroyed()) return null
  try {
    return contents.mainFrame
  } catch {
    return null
  }
}

function displayUrl(url) {
  if (!url) return ''
  if (url.startsWith('file://') && url.includes('start.html')) return ''
  return url
}

function sendNav() {
  if (!chromeView || chromeView.webContents.isDestroyed() || !browserView) return
  const contents = browserView.webContents
  if (contents.isDestroyed()) return
  chromeView.webContents.send('nav-updated', {
    url: displayUrl(contents.getURL()),
    loading: contents.isLoading(),
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward(),
  })
}

function layout() {
  if (!win || win.isDestroyed()) return
  const bounds = win.getContentBounds()
  const width = Math.max(0, bounds.width)
  const height = Math.max(0, bounds.height)
  chromeView.setBounds({ x: 0, y: 0, width, height: Math.min(CHROME_HEIGHT, height) })
  browserView.setBounds({
    x: 0,
    y: CHROME_HEIGHT,
    width,
    height: Math.max(0, height - CHROME_HEIGHT),
  })
}

function normalizeAddress(input) {
  const value = String(input || '').trim()
  if (!value || /^\s*javascript:/i.test(value)) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    if (/^https?:\/\//i.test(value)) return value
    return null
  }
  if (/^(localhost|(\d{1,3}\.){3}\d{1,3})(:\d+)?(\/.*)?$/i.test(value)) return `http://${value}`
  if (/^[\w.-]+\.[a-z]{2,}([/:?#].*)?$/i.test(value)) return `https://${value}`
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`
}

function fileNameFor(pageUrl) {
  let host = 'page'
  try {
    const parsed = new URL(pageUrl)
    host = parsed.protocol === 'file:' ? 'local' : (parsed.hostname || 'page')
  } catch {}
  host = host.replace(/[^a-zA-Z0-9.-]+/g, '_').replace(/^_+|_+$/g, '') || 'page'
  if (host.length > 60) host = host.slice(0, 60)
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  return `${stamp}_${host}.wav`
}

function uniquePath(filePath) {
  if (!fs.existsSync(filePath)) return filePath
  const ext = path.extname(filePath)
  const base = filePath.slice(0, -ext.length)
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}_${i}${ext}`
    if (!fs.existsSync(candidate)) return candidate
  }
  return filePath
}

function formatDuration(seconds) {
  const whole = Math.max(0, Math.floor(seconds || 0))
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const secs = whole % 60
  const pad = (value) => String(value).padStart(2, '0')
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(secs)}`
  return `${minutes}:${pad(secs)}`
}

function asBuffer(payload) {
  if (Buffer.isBuffer(payload)) return payload
  if (payload instanceof ArrayBuffer) return Buffer.from(payload)
  if (ArrayBuffer.isView(payload)) {
    return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)
  }
  return Buffer.from(payload)
}

function popupOptions() {
  return {
    width: 520,
    height: 760,
    autoHideMenuBar: true,
    backgroundColor: '#12141a',
    webPreferences: {
      partition: PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  }
}

function applyOutputMute() {
  for (const contents of webContents.getAllWebContents()) {
    if (contents.isDestroyed() || !browserSession || contents.session !== browserSession) continue
    contents.setAudioMuted(outputMuted)
  }
}

function registerBrowserContents(contents) {
  if (!browserSession || contents.session !== browserSession) return
  contents.setBackgroundThrottling(false)
  contents.setAudioMuted(outputMuted)
  contents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: popupOptions(),
  }))
  contents.on('will-attach-webview', (event) => event.preventDefault())
}

function installAppProtocol() {
  const root = path.resolve(__dirname, 'src')
  protocol.handle('app', (request) => {
    let relative = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '')
    relative = relative.replace(/^local\//, '')
    const filePath = path.resolve(root, relative)
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
      return new Response('Forbidden', { status: 403 })
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return new Response('Not found', { status: 404 })
    }
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
    }
    const body = fs.readFileSync(filePath)
    return new Response(new Uint8Array(body), {
      headers: { 'Content-Type': types[path.extname(filePath).toLowerCase()] || 'application/octet-stream' },
    })
  })
}

function attachIpc() {
  ipcMain.handle('get-settings', () => loadSettings())
  ipcMain.handle('set-silence-stop', (_event, enabled) => {
    saveSettings({ silenceStop: !!enabled })
    return { ok: true }
  })
  ipcMain.handle('set-output-muted', (_event, muted) => {
    outputMuted = !!muted
    if (!SELF_TEST) saveSettings({ outputMuted })
    applyOutputMute()
    return { ok: true }
  })
  ipcMain.handle('open-folder', async () => {
    const error = await shell.openPath(captureDir)
    return error ? { ok: false, error } : { ok: true }
  })
  ipcMain.handle('navigate', async (_event, input) => {
    const url = normalizeAddress(input)
    if (!url || !browserView) return { ok: false }
    try {
      await browserView.webContents.loadURL(url)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  })
  ipcMain.handle('back', () => {
    const history = browserView && browserView.webContents.navigationHistory
    if (history && history.canGoBack()) history.goBack()
  })
  ipcMain.handle('forward', () => {
    const history = browserView && browserView.webContents.navigationHistory
    if (history && history.canGoForward()) history.goForward()
  })
  ipcMain.handle('reload', () => {
    if (!browserView) return
    const contents = browserView.webContents
    if (contents.isLoading()) contents.stop()
    else contents.reload()
  })
  ipcMain.handle('begin-file', (_event, meta) => {
    if (capture) return { ok: true }
    try {
      fs.mkdirSync(captureDir, { recursive: true })
      const channels = Math.max(1, Math.min(8, Number(meta && meta.channels) || 2))
      const sampleRate = Math.max(8000, Math.min(192000, Number(meta && meta.sampleRate) || 48000))
      const pageUrl = browserView.webContents.getURL()
      const wavPath = uniquePath(path.join(captureDir, fileNameFor(pageUrl)))
      const floatPath = path.join(captureDir, `.recording-${Date.now()}.f32`)
      capture = {
        floatCapture: wav.createFloatCapture(floatPath),
        floatPath,
        wavPath,
        sampleRate,
        channels,
        pageUrl,
      }
      recordingFinished = {}
      recordingFinished.promise = new Promise((resolve) => {
        recordingFinished.resolve = resolve
      })
      if (SELF_TEST) {
        setTimeout(() => {
          if (capture && chromeView && !chromeView.webContents.isDestroyed()) {
            chromeView.webContents.send('request-stop', { reason: 'user', skipDialog: true })
          }
        }, 2500)
      }
      return { ok: true }
    } catch (error) {
      console.error(error)
      return { ok: false, error: error.message }
    }
  })

  ipcMain.on('audio-chunk', (_event, payload) => {
    if (!capture) return
    const buffer = asBuffer(payload)
    const frameBytes = capture.channels * 4
    if (buffer.length < frameBytes || buffer.length % frameBytes !== 0) return
    capture.floatCapture.append(buffer)
  })

  ipcMain.handle('end-file', async (_event, info) => {
    const current = capture
    capture = null
    if (!current) return { ok: false, error: 'Nothing was recorded.' }
    const reason = info && info.reason
    const skipDialog = SELF_TEST || !!(info && info.skipDialog) || reason === 'quit'
    try {
      current.floatCapture.close()
      const totalFrames = wav.frameCount(current.floatPath, current.channels)
      const durationSeconds = totalFrames / current.sampleRate
      if (totalFrames <= 0) {
        fs.rmSync(current.floatPath, { force: true })
        const empty = { ok: false, error: 'Nothing was recorded.', selfTestRms: 0 }
        if (recordingFinished) recordingFinished.resolve(empty)
        return empty
      }

      wav.writeWav24(current.floatPath, current.wavPath, {
        sampleRate: current.sampleRate,
        channels: current.channels,
      })

      let trimmed = false
      let note = ''
      if (!skipDialog) {
        const choice = await dialog.showMessageBox(win, {
          type: 'question',
          buttons: ['Keep as recorded', 'Trim silence at ends'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          title: 'Recording finished',
          message: reason === 'silence'
            ? 'Recording stopped after 1 minute of silence. Trim the quiet start and end?'
            : 'Trim silence at the beginning and end?',
          detail: `${path.basename(current.wavPath)}\nLength: ${formatDuration(durationSeconds)}\n\nThis removes quiet audio at the beginning and end. The middle of the recording stays as it is.`,
        })
        if (choice.response === 1) {
          const range = wav.findAudibleRange(current.floatPath, {
            channels: current.channels,
            sampleRate: current.sampleRate,
          })
          const removedFrames = range.startFrame + (range.totalFrames - range.endFrame)
          if (range.allSilent) {
            note = 'The recording looks silent, so it was kept as recorded.'
          } else if (removedFrames < current.sampleRate * 0.2) {
            note = 'No significant silence at the ends.'
          } else {
            const tempWav = `${current.wavPath}.tmp`
            wav.writeWav24(current.floatPath, tempWav, {
              sampleRate: current.sampleRate,
              channels: current.channels,
              startFrame: range.startFrame,
              endFrame: range.endFrame,
            })
            fs.rmSync(current.wavPath, { force: true })
            fs.renameSync(tempWav, current.wavPath)
            trimmed = true
          }
        }
      }

      const level = wav.rms(current.floatPath, current.channels)
      fs.rmSync(current.floatPath, { force: true })
      const result = {
        ok: true,
        trimmed,
        note,
        filePath: current.wavPath,
        fileName: path.basename(current.wavPath),
        durationSeconds: trimmed ? undefined : durationSeconds,
        sampleRate: current.sampleRate,
        channels: current.channels,
        rms: level,
      }
      if (trimmed) {
        const header = fs.statSync(current.wavPath)
        const dataBytes = Math.max(0, header.size - 44)
        result.durationSeconds = dataBytes / (current.sampleRate * current.channels * 3)
      } else {
        result.durationSeconds = durationSeconds
      }
      result.selfTestRms = level
      console.log('RECORDING_RMS', level.toFixed(5))
      if (recordingFinished) recordingFinished.resolve(result)
      return result
    } catch (error) {
      console.error(error)
      try { fs.rmSync(current.floatPath, { force: true }) } catch {}
      const failed = { ok: false, error: error.message }
      if (recordingFinished) recordingFinished.resolve(failed)
      return failed
    } finally {
      if (closeAfterSave && win && !win.isDestroyed()) {
        closeAfterSave = false
        setImmediate(() => {
          if (win && !win.isDestroyed()) win.close()
        })
      }
    }
  })
}

function rememberUrl(url) {
  if (!/^https?:\/\//i.test(url || '')) return
  saveSettings({ lastUrl: url })
}

async function createMainWindow() {
  captureDir = captureDirectory()
  settingsPath = path.join(app.getPath('userData'), 'settings.json')
  fs.mkdirSync(captureDir, { recursive: true })
  cleanupTemps()

  outputMuted = loadSettings().outputMuted === true
  browserSession = session.fromPartition(PARTITION)
  if (app.userAgentFallback) browserSession.setUserAgent(app.userAgentFallback)

  const allowed = new Set([
    'media',
    'geolocation',
    'notifications',
    'fullscreen',
    'pointerLock',
    'clipboard-sanitized-write',
    'clipboard-read',
  ])
  browserSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(allowed.has(permission))
  })
  browserSession.setPermissionCheckHandler((_contents, permission) => allowed.has(permission))

  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'display-capture' || permission === 'media')
  })
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => {
    return permission === 'display-capture' || permission === 'media'
  })
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    if (SELF_TEST) console.log('DISPLAY_MEDIA', request.videoRequested, request.audioRequested)
    const frame = browserFrame()
    if (!frame) {
      callback({})
      return
    }
    const streams = { audio: frame, enableLocalEcho: true }
    if (request.videoRequested) streams.video = frame
    callback(streams)
  }, { useSystemPicker: false })

  win = new BaseWindow({
    width: 1280,
    height: 860,
    minWidth: 760,
    minHeight: 520,
    show: false,
    center: true,
    backgroundColor: '#12141a',
    autoHideMenuBar: true,
    title: 'Browser Audio Capture',
  })

  chromeView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  browserView = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  chromeView.setBackgroundColor('#1a1e27')
  browserView.setBackgroundColor('#12141a')
  win.contentView.addChildView(chromeView)
  win.contentView.addChildView(browserView)

  const browserContents = browserView.webContents
  browserContents.setBackgroundThrottling(false)
  browserContents.on('did-start-loading', sendNav)
  browserContents.on('did-stop-loading', sendNav)
  browserContents.on('did-navigate', (_event, url) => {
    rememberUrl(url)
    sendNav()
  })
  browserContents.on('did-navigate-in-page', (_event, url) => {
    rememberUrl(url)
    sendNav()
  })
  browserContents.on('page-title-updated', (_event, title) => {
    if (!win.isDestroyed()) {
      win.setTitle(title ? `${title} — Browser Audio Capture` : 'Browser Audio Capture')
    }
  })

  chromeView.webContents.on('page-title-updated', (event) => event.preventDefault())
  chromeView.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    if (input.control && input.key.toLowerCase() === 'l') {
      event.preventDefault()
      chromeView.webContents.send('focus-url')
    }
  })
  browserContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    if (input.alt && input.key === 'Left') {
      event.preventDefault()
      if (browserContents.navigationHistory.canGoBack()) browserContents.navigationHistory.goBack()
    } else if (input.alt && input.key === 'Right') {
      event.preventDefault()
      if (browserContents.navigationHistory.canGoForward()) browserContents.navigationHistory.goForward()
    } else if (input.control && input.key.toLowerCase() === 'l') {
      event.preventDefault()
      chromeView.webContents.focus()
      chromeView.webContents.send('focus-url')
    } else if (input.key === 'F9') {
      event.preventDefault()
      chromeView.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F9' })
      chromeView.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F9' })
    }
  })

  win.on('resize', layout)
  win.on('close', (event) => {
    if (capture && !closeAfterSave) {
      event.preventDefault()
      closeAfterSave = true
      chromeView.webContents.send('request-stop', { reason: 'quit', skipDialog: true })
    }
  })

  const settings = loadSettings()
  const chromeReady = new Promise((resolve) => {
    chromeView.webContents.once('did-finish-load', resolve)
  })
  const browserReady = new Promise((resolve) => {
    browserContents.once('did-finish-load', resolve)
  })

  await chromeView.webContents.loadURL('app://local/index.html')
  if (SELF_TEST) await browserContents.loadFile(path.join(__dirname, 'src', 'test-tone.html'))
  else if (/^https?:\/\//i.test(settings.lastUrl)) await browserContents.loadURL(settings.lastUrl)
  else await browserContents.loadFile(path.join(__dirname, 'src', 'start.html'))

  await chromeReady
  await browserReady
  layout()
  win.show()
  sendNav()
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function runSelfTest() {
  const failures = []
  const timeout = setTimeout(() => {
    console.error('SELFTEST_FAIL timeout')
    app.exit(1)
  }, 30000)

  try {
    await browserSession.cookies.set({
      url: 'https://example.com/',
      name: 'bac_persist',
      value: 'ok',
      expirationDate: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
      sameSite: 'lax',
      secure: true,
    })
    await browserSession.cookies.flushStore()

    browserView.webContents.on('console-message', (details) => {
      console.log('BROWSER:', details.message)
    })
    chromeView.webContents.on('console-message', (details) => {
      console.log('CHROME:', details.message)
    })

    if (process.argv.includes('--self-test-mute')) {
      const muteRect = await chromeView.webContents.executeJavaScript(`(() => {
        const box = document.getElementById('mute').getBoundingClientRect()
        return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
      })()`)
      chromeView.webContents.focus()
      chromeView.webContents.sendInputEvent({ type: 'mouseDown', x: muteRect.x, y: muteRect.y, button: 'left', clickCount: 1 })
      chromeView.webContents.sendInputEvent({ type: 'mouseUp', x: muteRect.x, y: muteRect.y, button: 'left', clickCount: 1 })
      const muteStarted = Date.now()
      while (!browserView.webContents.isAudioMuted() && Date.now() - muteStarted < 3000) await delay(50)
      console.log('AUDIO_MUTED', browserView.webContents.isAudioMuted())
      if (!browserView.webContents.isAudioMuted()) failures.push('mute button did not silence the browser')
    }

    const toneState = await browserView.webContents.executeJavaScript('window.__toneReady')
    console.log('TONE_STATE', toneState)
    if (toneState !== 'running') {
      browserView.webContents.focus()
      browserView.webContents.sendInputEvent({ type: 'mouseDown', x: 40, y: 40, button: 'left', clickCount: 1 })
      browserView.webContents.sendInputEvent({ type: 'mouseUp', x: 40, y: 40, button: 'left', clickCount: 1 })
      await delay(300)
    }

    const rect = await chromeView.webContents.executeJavaScript(`(() => {
      const box = document.getElementById('record').getBoundingClientRect()
      return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
    })()`)
    console.log('RECORD_BUTTON', JSON.stringify(rect))
    chromeView.webContents.focus()
    chromeView.webContents.sendInputEvent({ type: 'mouseDown', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
    chromeView.webContents.sendInputEvent({ type: 'mouseUp', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })

    const started = Date.now()
    while (!recordingFinished && Date.now() - started < 8000) await delay(50)
    if (!recordingFinished) failures.push('recording did not start')
    else {
      const result = await Promise.race([
        recordingFinished.promise,
        delay(12000).then(() => null),
      ])
      if (!result) failures.push('recording did not finish')
      else if (!result.ok) failures.push(result.error || 'recording failed')
      else if (!(result.selfTestRms > 0.02)) failures.push('captured audio was silent, rms=' + result.selfTestRms)
      else if (result.channels < 1) failures.push('missing channel count')
    }

    await delay(200)
    const files = fs.readdirSync(captureDir).filter((name) => name.endsWith('.wav'))
    const newest = files
      .map((name) => path.join(captureDir, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
    if (!newest) failures.push('no wav was written')
    else {
      const header = Buffer.alloc(44)
      const fd = fs.openSync(newest, 'r')
      fs.readSync(fd, header, 0, 44, 0)
      fs.closeSync(fd)
      if (header.toString('ascii', 0, 4) !== 'RIFF') failures.push('wav header missing')
      if (header.readUInt16LE(34) !== 24) failures.push('wav is not 24-bit')
      const status = await chromeView.webContents.executeJavaScript('document.getElementById("status").textContent')
      console.log('STATUS', status)
      console.log('SAVED', newest, 'bytes', fs.statSync(newest).size)
      if (fs.statSync(newest).size < 1000) failures.push('wav too small')
      if (!/Saved /.test(status)) failures.push('ui did not report a save: ' + status)
      if (failures.length === 0) fs.rmSync(newest, { force: true })
    }
  } catch (error) {
    failures.push(error.stack || error.message)
  } finally {
    clearTimeout(timeout)
  }

  if (failures.length) {
    console.error('SELFTEST_FAIL')
    for (const failure of failures) console.error(failure)
    app.exit(1)
    return
  }
  console.log('SELFTEST_PASS')
  app.exit(0)
}

async function checkCookies() {
  const persisted = session.fromPartition(PARTITION)
  const cookies = await persisted.cookies.get({ name: 'bac_persist' })
  const ok = cookies.some((cookie) => cookie.value === 'ok' && cookie.expirationDate)
  console.log(ok ? 'SELFTEST_COOKIE_PASS' : 'SELFTEST_COOKIE_FAIL')
  if (!ok) console.log(JSON.stringify(cookies))
  app.exit(ok ? 0 : 1)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })
  app.on('web-contents-created', (_event, contents) => {
    registerBrowserContents(contents)
  })
  app.on('window-all-closed', () => {
    app.quit()
  })
  app.on('before-quit', (event) => {
    if (quitting || !browserSession) return
    event.preventDefault()
    quitting = true
    Promise.resolve()
      .then(() => browserSession.flushStorageData())
      .then(() => browserSession.cookies.flushStore())
      .catch((error) => console.error(error))
      .finally(() => app.quit())
  })

  app.whenReady().then(async () => {
    installAppProtocol()
    if (COOKIE_CHECK) {
      await checkCookies()
      return
    }
    attachIpc()
    try {
      await createMainWindow()
      if (SELF_TEST) await runSelfTest()
    } catch (error) {
      console.error(error)
      app.exit(1)
    }
  }).catch((error) => {
    console.error(error)
    app.exit(1)
  })
}
