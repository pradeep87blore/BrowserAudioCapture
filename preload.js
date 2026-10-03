const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('capture', {
  prepareCapture: (tabId) => ipcRenderer.sendSync('prepare-capture', tabId),
  cancelCapture: (tabId) => ipcRenderer.sendSync('cancel-capture', tabId),
  beginFile: (meta) => ipcRenderer.invoke('begin-file', meta),
  writeChunk: (tabId, samples) => {
    const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)
    ipcRenderer.send('audio-chunk', tabId, bytes)
  },
  endFile: (tabId, info) => ipcRenderer.invoke('end-file', tabId, info),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSilenceStop: (enabled) => ipcRenderer.invoke('set-silence-stop', enabled),
  setOutputMuted: (muted, tabId) => ipcRenderer.invoke('set-output-muted', muted, tabId),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  openDownload: (tabId) => ipcRenderer.invoke('open-download', tabId),
  navigate: (url) => ipcRenderer.invoke('navigate', url),
  back: () => ipcRenderer.invoke('back'),
  forward: () => ipcRenderer.invoke('forward'),
  reload: () => ipcRenderer.invoke('reload'),
  newTab: () => ipcRenderer.invoke('new-tab'),
  closeTab: (tabId) => ipcRenderer.invoke('close-tab', tabId),
  selectTab: (tabId) => ipcRenderer.invoke('select-tab', tabId),
  onTabs: (callback) => {
    ipcRenderer.on('tabs-updated', (_event, data) => callback(data))
  },
  onDownload: (callback) => {
    ipcRenderer.on('download-update', (_event, data) => callback(data))
  },
  onFocusUrl: (callback) => {
    ipcRenderer.on('focus-url', () => callback())
  },
  onRequestStop: (callback) => {
    ipcRenderer.on('request-stop', (_event, payload) => callback(payload || {}))
  },
})
