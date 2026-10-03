const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('capture', {
  beginFile: (meta) => ipcRenderer.invoke('begin-file', meta),
  writeChunk: (samples) => {
    const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)
    ipcRenderer.send('audio-chunk', bytes)
  },
  endFile: (info) => ipcRenderer.invoke('end-file', info),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSilenceStop: (enabled) => ipcRenderer.invoke('set-silence-stop', enabled),
  setOutputMuted: (muted) => ipcRenderer.invoke('set-output-muted', muted),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  navigate: (url) => ipcRenderer.invoke('navigate', url),
  back: () => ipcRenderer.invoke('back'),
  forward: () => ipcRenderer.invoke('forward'),
  reload: () => ipcRenderer.invoke('reload'),
  onNav: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('nav-updated', listener)
  },
  onFocusUrl: (callback) => {
    ipcRenderer.on('focus-url', () => callback())
  },
  onRequestStop: (callback) => {
    ipcRenderer.on('request-stop', (_event, payload) => callback(payload || {}))
  },
})
