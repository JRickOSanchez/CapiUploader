const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')
const { pathToFileURL } = require('node:url')
const store = require('./store')
const api = require('./api')
const psd = require('./psd')
const { downloadChapters } = require('./download')
const scrape = require('./scrape')
const importer = require('./importer')
const updater = require('./updater')

// Solo en desarrollo (sin empaquetar): las pruebas usan su propia carpeta de configuración
// para no tocar nunca la del usuario. La app instalada ignora esta variable.
if (!app.isPackaged && process.env.CAPI_USER_DATA_DIR) app.setPath('userData', process.env.CAPI_USER_DATA_DIR)

const IMAGE_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
}
const MAX_IMAGE_BYTES = 40 * 1024 * 1024
const UPLOAD_CONCURRENCY = 4

let win = null
let currentUpload = null

const naturalCompare = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare

function titleBarColors(theme) {
  return theme === 'dark'
    ? { color: '#00000000', symbolColor: '#e6e8ef', height: 52 }
    : { color: '#00000000', symbolColor: '#1b1e28', height: 52 }
}

function createWindow() {
  const theme = store.get('resolvedTheme') || (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    backgroundColor: theme === 'dark' ? '#0f1117' : '#f5f6fa',
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarColors(theme),
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.removeMenu()
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
  win.once('ready-to-show', () => win.show())
  // Las ventanas ocultas del motor de importación no deben mantener viva la app.
  win.on('closed', () => {
    win = null
    scrape.shutdown()
    if (process.platform !== 'darwin') app.quit()
  })

  // Los enlaces externos se abren en el navegador, nunca dentro de la app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
}

/** Envuelve un handler para devolver { ok, data } | { ok: false, error } al renderer. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) }
    } catch (err) {
      markActiveIfInvalid(err)
      return {
        ok: false,
        error: {
          message: err.message, code: err.code || null, status: err.status || null,
          traceId: err.traceId || null, retryAfter: err.retryAfter ?? null, limit: err.limit || null,
        },
      }
    }
  })
}

function requireKey() {
  const id = store.getActiveId()
  const key = id != null ? store.getProfileKey(id) : null
  if (!key) {
    const err = new Error(id != null
      ? 'No se pudo leer la API key de este scan. Vuelve a agregarla en «Mis scans».'
      : 'Agrega la API key de tu scan para continuar.')
    err.code = 'api.key_missing'
    throw err
  }
  return key
}

/** Si una petición con la clave activa responde «clave inválida», se marca el scan. */
function markActiveIfInvalid(err) {
  if (err?.code !== 'api.key_invalid') return
  const id = store.getActiveId()
  if (id != null) store.updateProfile(id, { status: 'invalid' })
}

// ---------- Ajustes ----------

// ---------- Scans (varias API keys) ----------

/** La versión 1.0 guardaba una sola clave sin datos del scan: se convierte en el primer perfil. */
let migration = null
function migrateLegacy() {
  if (!migration) {
    migration = (async () => {
      const legacy = store.takeLegacyKey()
      if (!legacy) return
      try {
        const me = await api.request(legacy, 'GET', '/me')
        store.upsertProfile(legacy, me.data)
        if (store.get('activeScanId') == null) store.setActiveId(me.data.scan.id)
        store.clearLegacyKey()
      } catch {
        // Nunca se borra la clave vieja por un error: se conserva y se reintenta en el próximo
        // arranque. Solo desaparece al migrarse o cuando el usuario agrega un scan.
        migration = null
      }
    })()
  }
  return migration
}

function profilesState() {
  return { profiles: store.listProfiles(), activeId: store.getActiveId(), encrypted: store.isEncryptionAvailable() }
}

handle('profiles:list', async () => {
  await migrateLegacy()
  return profilesState()
})

handle('profiles:add', async (key) => {
  key = String(key || '').trim()
  if (!/^capi_[A-Za-z0-9]{40}$/.test(key)) {
    const err = new Error('La clave debe ser "capi_" seguido de 40 letras o números.')
    err.code = 'api.invalid_request'
    throw err
  }
  if (currentUpload) throw new Error('Espera a que termine la subida para cambiar de scan.')
  const me = (await api.request(key, 'GET', '/me')).data
  const { profile, replaced } = store.upsertProfile(key, me)
  store.setActiveId(profile.id)
  store.clearLegacyKey()
  return { ...profilesState(), added: profile, replaced, me }
})

handle('profiles:setActive', async (id) => {
  if (currentUpload) throw new Error('Espera a que termine la subida para cambiar de scan.')
  if (!store.getProfile(id)) throw new Error('Ese scan ya no está registrado.')
  store.setActiveId(id)
  return profilesState()
})

handle('profiles:remove', async (id) => {
  if (currentUpload && id === store.getActiveId()) throw new Error('Espera a que termine la subida para quitar este scan.')
  store.removeProfile(id)
  return profilesState()
})

/** Vuelve a consultar /me con la clave del scan para actualizar permisos y estado. */
handle('profiles:verify', async (id) => {
  const key = store.getProfileKey(id)
  if (!key) throw new Error('No se pudo leer la API key de este scan. Vuelve a agregarla.')
  try {
    const me = (await api.request(key, 'GET', '/me')).data
    store.updateProfile(id, {
      name: me.scan.name, slug: me.scan.slug, url: me.scan.url, prefix: me.key.prefix,
      keyName: me.key.name, scopes: me.key.scopes, expiresAt: me.key.expiresAt, status: 'ok',
    })
    return { ...profilesState(), me }
  } catch (err) {
    if (err.code === 'api.key_invalid') store.updateProfile(id, { status: 'invalid' })
    throw err
  }
})

handle('settings:setTheme', async (theme, resolved) => {
  store.set('theme', theme)
  store.set('resolvedTheme', resolved)
  if (win && process.platform !== 'darwin') {
    try { win.setTitleBarOverlay(titleBarColors(resolved)) } catch { /* sin overlay */ }
  }
  win?.setBackgroundColor(resolved === 'dark' ? '#0f1117' : '#f5f6fa')
  return true
})

handle('system:prefersDark', async () => nativeTheme.shouldUseDarkColors)
nativeTheme.on('updated', () => win?.webContents.send('system:themeChanged', nativeTheme.shouldUseDarkColors))

handle('shell:open', async (url) => {
  if (/^https:\/\//.test(url)) await shell.openExternal(url)
  return true
})

// ---------- Actualizaciones ----------

handle('update:state', async () => updater.state())
handle('update:check', async () => updater.check({ manual: true }))
handle('update:install', async () => updater.install())

// ---------- API: lectura ----------

handle('api:me', async () => (await api.request(requireKey(), 'GET', '/me')).data)

handle('api:works', async () => {
  const key = requireKey()
  const all = []
  let page = 1
  let pages = 1
  do {
    const res = await api.request(key, 'GET', `/works?limit=50&page=${page}`)
    all.push(...res.data)
    pages = res.pagination?.pages || 1
    page++
  } while (page <= pages)
  return all
})

handle('api:chapters', async (workId) => {
  const key = requireKey()
  const all = []
  let page = 1
  let pages = 1
  do {
    const res = await api.request(key, 'GET', `/works/${Number(workId)}/chapters?limit=100&order=desc&page=${page}`)
    all.push(...res.data)
    pages = res.pagination?.pages || 1
    page++
  } while (page <= pages)
  return all
})

// Arreglos de un capítulo ya subido (desde «Capítulos subidos»). Ninguno avisa a nadie, salvo
// «Publicar ya» con notify. La papelera se restaura durante 30 días.
const chapterPath = (chapterId) => {
  const id = Number(chapterId)
  if (!Number.isInteger(id) || id < 1) throw new Error('Capítulo no válido.')
  return `/chapters/${id}`
}

handle('chapter:setNumber', async (chapterId, number) => {
  const n = Number(number)
  if (!Number.isFinite(n) || n < 0) throw new Error('Número de capítulo no válido.')
  return (await api.request(requireKey(), 'PATCH', chapterPath(chapterId), { number: n })).data
})
handle('chapter:publish', async (chapterId, { notify = true } = {}) =>
  (await api.request(requireKey(), 'POST', `${chapterPath(chapterId)}/publish`, { notify: notify !== false })).data)
handle('chapter:trash', async (chapterId) => (await api.request(requireKey(), 'DELETE', chapterPath(chapterId))).data)
handle('chapter:restore', async (chapterId) => (await api.request(requireKey(), 'POST', `${chapterPath(chapterId)}/restore`)).data)

// ---------- Archivos ----------

/** Describe una imagen. source es el PSD original cuando la imagen es su conversión. */
async function describeFile(filePath, source = null) {
  const ext = path.extname(filePath).toLowerCase()
  const type = IMAGE_TYPES[ext]
  if (!type) return null
  const st = await fs.stat(filePath)
  if (!st.isFile()) return null
  return {
    path: filePath,
    name: path.basename(source || filePath),
    size: st.size,
    mtime: st.mtimeMs,
    type,
    url: pathToFileURL(filePath).href,
    ...(source ? { source } : {}),
  }
}

function isAccepted(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  return Boolean(IMAGE_TYPES[ext]) || psd.PSD_EXTS.has(ext)
}

/** Resumen de la conversión de PSD para la interfaz (null si no había ninguno). */
function psdReport(summary) {
  if (!summary) return null
  return {
    converted: summary.converted,
    cached: summary.cached,
    keptText: summary.keptText,
    missingFonts: [...summary.missingFonts],
    substituted: summary.substituted,
    failed: summary.failed,
  }
}

/**
 * Describe una lista de rutas en orden. Los PSD se convierten todos juntos (psdc los procesa
 * en paralelo) y se describen como su JPG en caché. Las rutas que no sirven van a skipped.
 */
async function describeMany(paths) {
  const psdPaths = paths.filter(psd.isPsd)
  let converted = null
  let summary = null
  if (psdPaths.length) {
    ;({ result: converted, summary } = await psd.convertAll(psdPaths, (p) => win?.webContents.send('psd:progress', p)))
    win?.webContents.send('psd:progress', { finished: true })
  }
  const files = []
  const skipped = []
  for (const p of paths) {
    let f = null
    if (psd.isPsd(p)) {
      const c = converted.get(p)
      if (c?.out) f = await describeFile(c.out, p).catch(() => null)
    } else {
      f = await describeFile(p).catch(() => null)
    }
    if (f) files.push(f)
    else skipped.push(path.basename(p))
  }
  return { files, skipped, summary }
}

/** Expande carpetas (un nivel) y devuelve solo imágenes válidas, ordenadas por nombre dentro de cada carpeta. */
async function resolvePaths(paths) {
  const candidates = []
  const skipped = []
  for (const p of paths) {
    let st
    try { st = await fs.stat(p) } catch { skipped.push(path.basename(p)); continue }
    if (st.isDirectory()) {
      candidates.push(...await listCandidates(p))
    } else if (isAccepted(p)) {
      candidates.push(p)
    } else {
      skipped.push(path.basename(p))
    }
  }
  const res = await describeMany(candidates)
  return { files: res.files, skipped: [...skipped, ...res.skipped], psd: psdReport(res.summary) }
}

handle('files:resolve', async (paths) => resolvePaths(Array.isArray(paths) ? paths : []))

/** Imágenes y PSD de una carpeta (sin entrar a subcarpetas), en orden natural. */
async function listCandidates(dir) {
  const names = (await fs.readdir(dir)).sort(naturalCompare)
  return names.filter(isAccepted).map((name) => path.join(dir, name))
}

async function listSubdirs(dir) {
  return (await fs.readdir(dir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort(naturalCompare)
}

/**
 * Nombres de las carpetas que contienen al capítulo, de la más cercana a la más lejana,
 * hasta la que contiene lo elegido. Sirven para adivinar la obra: «Lote/Choujin X/Vol 1/Cap 3»
 * → ["Vol 1", "Choujin X", "Lote", …].
 */
function ancestorNames(dir, root) {
  const out = []
  const stop = path.dirname(path.resolve(root))
  let cur = path.dirname(path.resolve(dir))
  while (out.length < 4) {
    const name = path.basename(cur)
    if (!name) break
    out.push(name)
    if (cur === stop || path.dirname(cur) === cur) break
    cur = path.dirname(cur)
  }
  return out
}

/**
 * Modo de varios capítulos: cada carpeta con imágenes es un capítulo. Se aceptan hasta
 * dos niveles bajo lo que se suelta, p. ej. «Lote/Kirara/Cap 4» u «Obra/Vol 1/Cap 4».
 * parent es la carpeta que contiene al capítulo y ancestors todas las que lo contienen;
 * sirven para adivinar la obra.
 */
async function resolveChapters(paths) {
  const found = [] // { name, dir, root, candidates }
  const skipped = []
  let looseFiles = 0
  for (const p of paths) {
    let st
    try { st = await fs.stat(p) } catch { skipped.push(path.basename(p)); continue }
    if (!st.isDirectory()) { looseFiles++; continue }
    const candidates = await listCandidates(p)
    if (candidates.length) {
      found.push({ name: path.basename(p), dir: p, root: p, candidates })
      continue
    }
    let count = 0
    for (const sub of await listSubdirs(p)) {
      const dir = path.join(p, sub)
      const subFiles = await listCandidates(dir).catch(() => [])
      if (subFiles.length) {
        found.push({ name: sub, dir, root: p, candidates: subFiles })
        count++
        continue
      }
      // Segundo nivel: «Lote/Obra/Capítulo».
      for (const sub2 of await listSubdirs(dir).catch(() => [])) {
        const dir2 = path.join(dir, sub2)
        const files2 = await listCandidates(dir2).catch(() => [])
        if (files2.length) {
          found.push({ name: sub2, dir: dir2, root: p, candidates: files2 })
          count++
        }
      }
    }
    if (!count) skipped.push(path.basename(p))
  }

  // Todas las páginas de todos los capítulos de una vez, para convertir los PSD en un solo paso.
  const all = found.flatMap((c) => c.candidates)
  const { files, summary } = await describeMany(all)
  const byPath = new Map(files.map((f) => [f.source || f.path, f]))
  const chapters = []
  for (const c of found) {
    const chFiles = c.candidates.map((p) => byPath.get(p)).filter(Boolean)
    if (!chFiles.length) { skipped.push(c.name); continue }
    const ancestors = ancestorNames(c.dir, c.root)
    chapters.push({ name: c.name, dir: c.dir, parent: ancestors[0] || '', ancestors, files: chFiles })
  }
  return { chapters, skipped, looseFiles, psd: psdReport(summary) }
}

handle('files:resolveChapters', async (paths) => resolveChapters(Array.isArray(paths) ? paths : []))

handle('files:pickChapters', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Selecciona las carpetas de los capítulos',
    properties: ['openDirectory', 'multiSelections'],
  })
  if (res.canceled) return { chapters: [], skipped: [], looseFiles: 0, psd: null }
  return resolveChapters(res.filePaths)
})

handle('files:pick', async (mode) => {
  const res = await dialog.showOpenDialog(win, mode === 'folder'
    ? { title: 'Selecciona la carpeta del capítulo', properties: ['openDirectory'] }
    : {
        title: 'Selecciona las páginas del capítulo',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Imágenes y PSD', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'psd', 'psb'] }],
      })
  if (res.canceled) return { files: [], skipped: [], psd: null }
  return resolvePaths(res.filePaths)
})

// ---------- Subida de capítulo ----------

/**
 * Las claves ya subidas se guardan en memoria para que, si falla la creación del
 * capítulo (p. ej. número repetido), al reintentar no se vuelvan a subir las imágenes.
 */
const uploadedCache = new Map() // `${path}|${size}|${mtime}` -> { key, at }
const CACHE_TTL = 45 * 60 * 1000

function cacheId(f) { return `${f.path}|${f.size}|${f.mtime}` }

function sendProgress(payload) {
  win?.webContents.send('upload:progress', payload)
}

async function runPool(items, limit, worker, signal) {
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      if (signal.aborted) throw abortError()
      const i = next++
      await worker(items[i], i)
    }
  })
  await Promise.all(runners)
}

function abortError() {
  const err = new Error('Subida cancelada.')
  err.code = 'cancelled'
  return err
}

handle('chapter:upload', async (payload) => {
  if (currentUpload) throw new Error('Ya hay una subida en curso.')
  const key = requireKey()
  const controller = new AbortController()
  currentUpload = controller
  const { signal } = controller

  try {
    const { workId, chapter } = payload
    // Cada archivo llega como ruta o como { path, single } (página simple en doble página).
    const entries = payload.files.map((f) => (typeof f === 'string' ? { path: f, single: false } : { path: f.path, single: Boolean(f.single) }))
    const paths = entries.map((e) => e.path)
    const singles = entries.map((e) => e.single)

    // 1. Volver a leer metadatos reales de cada archivo (tamaño exacto).
    sendProgress({ phase: 'prepare' })
    const files = []
    for (const p of paths) {
      const f = await describeFile(p)
      if (!f) throw new Error(`Archivo no válido o inexistente: ${path.basename(p)}`)
      if (f.size > MAX_IMAGE_BYTES) throw new Error(`${f.name} supera los 40 MB.`)
      if (f.size === 0) throw new Error(`${f.name} está vacío.`)
      files.push(f)
    }
    if (files.length < 1 || files.length > 500) throw new Error('El capítulo debe tener entre 1 y 500 páginas.')

    const keys = new Array(files.length)
    const pending = []
    const now = Date.now()
    files.forEach((f, i) => {
      const c = uploadedCache.get(cacheId(f))
      if (c && now - c.at < CACHE_TTL) {
        keys[i] = c.key
        sendProgress({ phase: 'file', index: i, status: 'done', reused: true })
      } else {
        pending.push(i)
      }
    })

    const totalBytes = files.reduce((s, f) => s + f.size, 0)
    let doneBytes = files.reduce((s, f, i) => s + (keys[i] ? f.size : 0), 0)
    sendProgress({ phase: 'upload', doneBytes, totalBytes, done: files.length - pending.length, total: files.length })

    // 2. Pedir URLs firmadas en lotes de 100.
    for (let b = 0; b < pending.length; b += 100) {
      if (signal.aborted) throw abortError()
      const batch = pending.slice(b, b + 100)
      sendProgress({ phase: 'sign', done: b, total: pending.length })
      const res = await api.request(key, 'POST', '/uploads', {
        files: batch.map((i) => ({ contentType: files[i].type, size: files[i].size })),
      }, signal)
      const uploads = res.data.uploads

      // 3. Subir cada imagen a su URL firmada.
      await runPool(batch, UPLOAD_CONCURRENCY, async (fileIndex, j) => {
        const f = files[fileIndex]
        const u = uploads[j]
        sendProgress({ phase: 'file', index: fileIndex, status: 'uploading' })
        const body = await fs.readFile(f.path)
        try {
          await api.putFile(u.uploadUrl, u.contentType, body, signal)
        } catch (err) {
          sendProgress({ phase: 'file', index: fileIndex, status: 'error' })
          throw new Error(`No se pudo subir la página ${fileIndex + 1} (${f.name}): ${err.message}`)
        }
        keys[fileIndex] = u.key
        uploadedCache.set(cacheId(f), { key: u.key, at: Date.now() })
        doneBytes += f.size
        sendProgress({ phase: 'file', index: fileIndex, status: 'done' })
        sendProgress({
          phase: 'upload', doneBytes, totalBytes,
          done: keys.filter(Boolean).length, total: files.length,
        })
      }, signal)
    }

    if (signal.aborted) throw abortError()

    // 4. Crear el capítulo.
    sendProgress({ phase: 'create' })
    const body = { number: chapter.number, pages: keys.map((k, i) => (singles[i] ? { key: k, single: true } : k)) }
    if (chapter.title) body.title = chapter.title
    if (chapter.volumeNumber != null) body.volumeNumber = chapter.volumeNumber
    // announcePage: número de página (1 = la primera), null = portada; sin el campo, el default del scan.
    if (chapter.announcePage !== undefined) body.announcePage = chapter.announcePage
    if (chapter.publishAt) body.publishAt = chapter.publishAt
    if (chapter.notify === false) body.notify = false
    const created = await api.request(key, 'POST', `/works/${Number(workId)}/chapters`, body, signal)

    // Tras crearse, las claves ya pertenecen al capítulo: no deben reutilizarse.
    files.forEach((f) => uploadedCache.delete(cacheId(f)))

    // 5. Comprobar las páginas simples (y corregirlas si alguna no quedó marcada).
    let singleCheck = null
    if (singles.some(Boolean) && created.data?.id) {
      sendProgress({ phase: 'verify' })
      singleCheck = await ensureSingles(key, created.data.id, singles)
    }
    sendProgress({ phase: 'done' })
    return { ...created.data, singleCheck }
  } catch (err) {
    if (signal.aborted && err.code !== 'cancelled') throw abortError()
    throw err
  } finally {
    currentUpload = null
  }
})

/**
 * Lee las páginas del capítulo y marca/desmarca las que no coincidan con lo pedido.
 * Nunca hace fallar la subida: el capítulo ya está creado.
 */
async function ensureSingles(key, chapterId, wanted) {
  try {
    const read = async () => (await api.request(key, 'GET', `/chapters/${Number(chapterId)}/pages`)).data.pages
    let pages = await read()
    const diff = (want) => pages.filter((pg, i) => Boolean(wanted[i]) === want && Boolean(pg.single) !== want).map((pg) => pg.id)
    const toSet = diff(true)
    const toUnset = diff(false)
    if (toSet.length) await api.request(key, 'PATCH', `/chapters/${Number(chapterId)}/pages`, { pageIds: toSet, single: true })
    if (toUnset.length) await api.request(key, 'PATCH', `/chapters/${Number(chapterId)}/pages`, { pageIds: toUnset, single: false })
    if (toSet.length || toUnset.length) pages = await read()
    const marked = pages.filter((pg) => pg.single).length
    const expected = wanted.filter(Boolean).length
    return { ok: marked === expected && pages.every((pg, i) => Boolean(pg.single) === Boolean(wanted[i])), marked, expected, fixed: toSet.length + toUnset.length }
  } catch (err) {
    return { ok: false, error: err.message, expected: wanted.filter(Boolean).length }
  }
}

handle('chapter:cancel', async () => {
  currentUpload?.abort()
  return true
})

// ---------- Descargar de Capibara ----------

let currentDownload = null
// Solo se abren en el explorador carpetas creadas por una descarga.
const openableDirs = new Set()

function defaultDownloadDir() {
  return store.get('downloadDir') || path.join(app.getPath('downloads'), 'CapiUploader')
}

handle('download:folder', async () => defaultDownloadDir())

handle('download:pickFolder', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Carpeta donde guardar los capítulos',
    defaultPath: defaultDownloadDir(),
    properties: ['openDirectory', 'createDirectory'],
  })
  if (res.canceled) return null
  store.set('downloadDir', res.filePaths[0])
  return res.filePaths[0]
})

handle('download:start', async ({ work, chapters, dest, format } = {}) => {
  if (currentDownload) throw new Error('Ya hay una descarga en curso.')
  if (!work?.id || !Array.isArray(chapters) || !chapters.length) throw new Error('Elige los capítulos a descargar.')
  const key = requireKey()
  const controller = new AbortController()
  currentDownload = controller
  try {
    const target = typeof dest === 'string' && path.isAbsolute(dest) ? dest : defaultDownloadDir()
    const list = chapters.map((c) => ({
      id: Number(c.id), number: c.number, volumeNumber: c.volumeNumber ?? null, title: c.title || '',
      pages: Number.isInteger(c.pages) ? c.pages : null,
    })).filter((c) => Number.isInteger(c.id))
    const summary = await downloadChapters({
      key,
      work: { id: Number(work.id), title: String(work.title || '') },
      chapters: list,
      dest: target,
      format: ['original', 'jpg', 'png'].includes(format) ? format : 'jpg',
      signal: controller.signal,
      onProgress: (p) => {
        if (p.dir) openableDirs.add(p.dir)
        win?.webContents.send('download:progress', p)
      },
    })
    openableDirs.add(summary.workDir)
    return summary
  } finally {
    currentDownload = null
  }
})

handle('download:cancel', async () => {
  currentDownload?.abort()
  return true
})

// ---------- Importar de web ----------

let currentImport = null

handle('import:identify', async (url) => importer.identify(url))

handle('import:open', async (url, websiteId) => importer.open(url, websiteId))

handle('import:download', async ({ key, workTitle, chapters } = {}) => {
  if (currentImport) throw new Error('Ya hay una importación en curso.')
  if (!key || !Array.isArray(chapters) || !chapters.length) throw new Error('Elige los capítulos a importar.')
  const controller = new AbortController()
  currentImport = controller
  try {
    return await importer.download({
      key: String(key),
      workTitle: String(workTitle || ''),
      chapters: chapters.map((c) => ({
        index: Number(c.index), number: c.number, volumeNumber: c.volumeNumber ?? null, title: String(c.title || '').slice(0, 256),
      })).filter((c) => Number.isInteger(c.index) && c.number != null),
      signal: controller.signal,
      onProgress: (p) => win?.webContents.send('import:progress', p),
    })
  } finally {
    currentImport = null
  }
})

handle('import:cancel', async () => {
  currentImport?.abort()
  return true
})

handle('import:release', async (key) => importer.release(String(key)))

handle('download:open', async (dir) => {
  if (!openableDirs.has(dir)) throw new Error('Carpeta no disponible.')
  const err = await shell.openPath(dir)
  if (err) throw new Error(err)
  return true
})

// ---------- Ciclo de vida ----------

// Una sola instancia: abrir el acceso directo otra vez enfoca la ventana existente.
if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.focus()
})

app.whenReady().then(() => {
  store.init(app.getPath('userData'))
  psd.init(app.getPath('userData')).catch(() => {})
  importer.init(app.getPath('userData')).catch(() => {})
  migrateLegacy()
  createWindow()
  scrape.init(win)
  updater.init((s) => win?.webContents.send('update:state', s))
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => scrape.shutdown())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
