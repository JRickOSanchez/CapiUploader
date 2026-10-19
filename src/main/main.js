const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')
const { pathToFileURL } = require('node:url')
const store = require('./store')
const api = require('./api')

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
      return { ok: false, error: { message: err.message, code: err.code || null, status: err.status || null } }
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

// ---------- Archivos ----------

async function describeFile(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  const type = IMAGE_TYPES[ext]
  if (!type) return null
  const st = await fs.stat(filePath)
  if (!st.isFile()) return null
  return {
    path: filePath,
    name: path.basename(filePath),
    size: st.size,
    mtime: st.mtimeMs,
    type,
    url: pathToFileURL(filePath).href,
  }
}

/** Expande carpetas (un nivel) y devuelve solo imágenes válidas, ordenadas por nombre dentro de cada carpeta. */
async function resolvePaths(paths) {
  const out = []
  const skipped = []
  for (const p of paths) {
    let st
    try { st = await fs.stat(p) } catch { skipped.push(path.basename(p)); continue }
    if (st.isDirectory()) {
      const entries = (await fs.readdir(p)).sort(naturalCompare)
      for (const name of entries) {
        const f = await describeFile(path.join(p, name)).catch(() => null)
        if (f) out.push(f)
      }
    } else {
      const f = await describeFile(p).catch(() => null)
      if (f) out.push(f)
      else skipped.push(path.basename(p))
    }
  }
  return { files: out, skipped }
}

handle('files:resolve', async (paths) => resolvePaths(Array.isArray(paths) ? paths : []))

async function listImages(dir) {
  const names = (await fs.readdir(dir)).sort(naturalCompare)
  const out = []
  for (const name of names) {
    const f = await describeFile(path.join(dir, name)).catch(() => null)
    if (f) out.push(f)
  }
  return out
}

async function listSubdirs(dir) {
  return (await fs.readdir(dir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort(naturalCompare)
}

/**
 * Modo de varios capítulos: cada carpeta con imágenes es un capítulo. Se aceptan hasta
 * dos niveles bajo lo que se suelta, p. ej. «Lote/Kirara/Cap 4». parent es el nombre de
 * la carpeta que contiene al capítulo y sirve para adivinar la obra.
 */
async function resolveChapters(paths) {
  const chapters = []
  const skipped = []
  let looseFiles = 0
  for (const p of paths) {
    let st
    try { st = await fs.stat(p) } catch { skipped.push(path.basename(p)); continue }
    if (!st.isDirectory()) { looseFiles++; continue }
    const files = await listImages(p)
    if (files.length) {
      chapters.push({ name: path.basename(p), dir: p, parent: path.basename(path.dirname(p)), files })
      continue
    }
    let found = 0
    for (const sub of await listSubdirs(p)) {
      const dir = path.join(p, sub)
      const subFiles = await listImages(dir).catch(() => [])
      if (subFiles.length) {
        chapters.push({ name: sub, dir, parent: path.basename(p), files: subFiles })
        found++
        continue
      }
      // Segundo nivel: «Lote/Obra/Capítulo».
      for (const sub2 of await listSubdirs(dir).catch(() => [])) {
        const dir2 = path.join(dir, sub2)
        const files2 = await listImages(dir2).catch(() => [])
        if (files2.length) {
          chapters.push({ name: sub2, dir: dir2, parent: sub, files: files2 })
          found++
        }
      }
    }
    if (!found) skipped.push(path.basename(p))
  }
  return { chapters, skipped, looseFiles }
}

handle('files:resolveChapters', async (paths) => resolveChapters(Array.isArray(paths) ? paths : []))

handle('files:pickChapters', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Selecciona las carpetas de los capítulos',
    properties: ['openDirectory', 'multiSelections'],
  })
  if (res.canceled) return { chapters: [], skipped: [], looseFiles: 0 }
  return resolveChapters(res.filePaths)
})

handle('files:pick', async (mode) => {
  const res = await dialog.showOpenDialog(win, mode === 'folder'
    ? { title: 'Selecciona la carpeta del capítulo', properties: ['openDirectory'] }
    : {
        title: 'Selecciona las páginas del capítulo',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Imágenes', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif'] }],
      })
  if (res.canceled) return { files: [], skipped: [] }
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
    if (chapter.earlyAccess) {
      body.earlyAccess = true
      if (chapter.releaseAt) body.releaseAt = chapter.releaseAt
    } else if (chapter.notify === false) {
      body.notify = false
    }
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
  migrateLegacy()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
