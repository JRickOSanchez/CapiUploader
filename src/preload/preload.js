const { contextBridge, ipcRenderer, webUtils } = require('electron')

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args)

contextBridge.exposeInMainWorld('capi', {
  settings: {
    get: () => invoke('settings:get'),
    setKey: (key) => invoke('settings:setKey', key),
    clearKey: () => invoke('settings:clearKey'),
    setTheme: (theme, resolved) => invoke('settings:setTheme', theme, resolved),
  },
  system: {
    prefersDark: () => invoke('system:prefersDark'),
    onThemeChanged: (cb) => ipcRenderer.on('system:themeChanged', (_e, dark) => cb(dark)),
    openExternal: (url) => invoke('shell:open', url),
  },
  api: {
    me: () => invoke('api:me'),
    works: () => invoke('api:works'),
    chapters: (workId) => invoke('api:chapters', workId),
  },
  files: {
    pathFor: (file) => webUtils.getPathForFile(file),
    resolve: (paths) => invoke('files:resolve', paths),
    pick: (mode) => invoke('files:pick', mode),
    resolveChapters: (paths) => invoke('files:resolveChapters', paths),
    pickChapters: () => invoke('files:pickChapters'),
  },
  upload: {
    start: (payload) => invoke('chapter:upload', payload),
    cancel: () => invoke('chapter:cancel'),
    onProgress: (cb) => {
      const listener = (_e, p) => cb(p)
      ipcRenderer.on('upload:progress', listener)
      return () => ipcRenderer.removeListener('upload:progress', listener)
    },
  },
})
