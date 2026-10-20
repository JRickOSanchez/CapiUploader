const { contextBridge, ipcRenderer, webUtils } = require('electron')

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args)

contextBridge.exposeInMainWorld('capi', {
  settings: {
    setTheme: (theme, resolved) => invoke('settings:setTheme', theme, resolved),
  },
  // Scans registrados: la interfaz nunca recibe las claves, solo sus datos públicos.
  profiles: {
    list: () => invoke('profiles:list'),
    add: (key) => invoke('profiles:add', key),
    setActive: (id) => invoke('profiles:setActive', id),
    remove: (id) => invoke('profiles:remove', id),
    verify: (id) => invoke('profiles:verify', id),
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
    // Avance de la conversión de PSD: { done, total } y al final { finished: true }.
    onPsdProgress: (cb) => ipcRenderer.on('psd:progress', (_e, p) => cb(p)),
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
