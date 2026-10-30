const { contextBridge, ipcRenderer, webUtils } = require('electron')

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args)

contextBridge.exposeInMainWorld('capi', {
  settings: {
    setTheme: (theme, resolved) => invoke('settings:setTheme', theme, resolved),
    get: () => invoke('settings:get'),
    setHardwareAcceleration: (on) => invoke('settings:setHardwareAcceleration', on),
    relaunch: () => invoke('app:relaunch'),
    // Ventana aparte con las notas de la versión instalada.
    openWhatsNew: () => invoke('whatsnew:open'),
    // Cambios hechos en otra ventana de la app.
    onThemeChanged: (cb) => ipcRenderer.on('theme:changed', (_e, t) => cb(t)),
  },
  // Scans registrados: la interfaz nunca recibe las claves, solo sus datos públicos.
  profiles: {
    list: () => invoke('profiles:list'),
    add: (key) => invoke('profiles:add', key),
    setActive: (id) => invoke('profiles:setActive', id),
    remove: (id) => invoke('profiles:remove', id),
    verify: (id) => invoke('profiles:verify', id),
    onChanged: (cb) => ipcRenderer.on('profiles:changed', (_e, s) => cb(s)),
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
  // Plataforma activa (Capibara, Crimson Scan o Mangation) y sesiones de Crimson y Mangation.
  platform: {
    state: () => invoke('platform:state'),
    setActive: (platform) => invoke('platform:setActive', platform),
    signIn: (platform, creds) => invoke('platform:signIn', platform, creds),
    signOut: (platform) => invoke('platform:signOut', platform),
    works: (platform) => invoke('platform:works', platform),
    chapters: (platform, workId) => invoke('platform:chapters', platform, workId),
    genres: (platform) => invoke('platform:genres', platform),
    pickImage: (kind) => invoke('platform:pickImage', kind),
    createWork: (platform, fields, images) => invoke('platform:createWork', platform, fields, images),
    deleteChapter: (platform, workId, chapterId) => invoke('platform:deleteChapter', platform, workId, chapterId),
    renumberChapter: (platform, workId, chapterId, number) => invoke('platform:renumberChapter', platform, workId, chapterId, number),
    onChanged: (cb) => ipcRenderer.on('platform:changed', (_e, s) => cb(s)),
    onSessions: (cb) => ipcRenderer.on('platform:sessions', (_e, s) => cb(s)),
  },
  // Crear obras nuevas (la clave necesita works:write).
  works: {
    catalog: () => invoke('works:catalog'),
    searchBase: (q) => invoke('works:searchBase', q),
    searchAuthors: (q) => invoke('works:searchAuthors', q),
    pickImage: (kind) => invoke('works:pickImage', kind),
    create: (input) => invoke('works:create', input),
    // Una obra creada en otra ventana: hay que recargar la lista.
    onChanged: (cb) => ipcRenderer.on('works:changed', (_e, w) => cb(w)),
  },
  // Actualizaciones desde los releases de GitHub: { status, kind, version, percent, download, url, … }
  update: {
    state: () => invoke('update:state'),
    check: () => invoke('update:check'),
    install: () => invoke('update:install'),
    onState: (cb) => ipcRenderer.on('update:state', (_e, s) => cb(s)),
  },
  // Arreglos de un capítulo ya subido.
  chapter: {
    setNumber: (chapterId, number) => invoke('chapter:setNumber', chapterId, number),
    publish: (chapterId, opts) => invoke('chapter:publish', chapterId, opts),
    trash: (chapterId) => invoke('chapter:trash', chapterId),
    restore: (chapterId) => invoke('chapter:restore', chapterId),
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
  // Registro de diagnóstico (Ajustes → Diagnóstico).
  diagnostics: {
    list: (minLevel) => invoke('diag:list', minLevel),
    copy: (minLevel) => invoke('diag:copy', minLevel),
    clear: () => invoke('diag:clear'),
    openFolder: () => invoke('diag:openFolder'),
    reportError: (entry) => invoke('diag:renderer', entry),
  },
  upload: {
    start: (payload) => invoke('chapter:upload', payload),
    cancel: () => invoke('chapter:cancel'),
    keepOnly: (paths) => invoke('upload:keepOnly', paths),
    onProgress: (cb) => {
      const listener = (_e, p) => cb(p)
      ipcRenderer.on('upload:progress', listener)
      return () => ipcRenderer.removeListener('upload:progress', listener)
    },
  },
  // Importar capítulos de otra web (motor de HaruNeko).
  import: {
    // Ventana aparte con la pantalla de importar; al terminar entrega los capítulos a la principal.
    openWindow: () => invoke('import:openWindow'),
    closeWindow: () => invoke('import:closeWindow'),
    handoff: (payload) => invoke('import:handoff', payload),
    onHandoff: (cb) => ipcRenderer.on('import:handoff', (_e, p) => cb(p)),
    identify: (url) => invoke('import:identify', url),
    open: (url, websiteId) => invoke('import:open', url, websiteId),
    download: (payload) => invoke('import:download', payload),
    cancel: () => invoke('import:cancel'),
    release: (key) => invoke('import:release', key),
    // Verificación de Cloudflare en el navegador del usuario: { status: 'open' | 'done' | 'error', site, browser, error }
    onVerify: (cb) => ipcRenderer.on('import:verify', (_e, p) => cb(p)),
    onProgress: (cb) => {
      const listener = (_e, p) => cb(p)
      ipcRenderer.on('import:progress', listener)
      return () => ipcRenderer.removeListener('import:progress', listener)
    },
  },
  // Descargar capítulos de las obras del scan activo.
  download: {
    folder: () => invoke('download:folder'),
    pickFolder: () => invoke('download:pickFolder'),
    start: (payload) => invoke('download:start', payload),
    cancel: () => invoke('download:cancel'),
    open: (dir) => invoke('download:open', dir),
    onProgress: (cb) => {
      const listener = (_e, p) => cb(p)
      ipcRenderer.on('download:progress', listener)
      return () => ipcRenderer.removeListener('download:progress', listener)
    },
  },
})
