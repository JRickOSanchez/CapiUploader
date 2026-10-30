/**
 * Subida de un capítulo con la API:
 *   1. vuelve a leer cada archivo (tamaño exacto);
 *   2. pide URLs firmadas en lotes de 100 (POST /uploads);
 *   3. sube cada imagen con PUT directo al almacenamiento (4 en paralelo);
 *   4. crea el capítulo (POST /works/:id/chapters) con las claves en orden de lectura;
 *   5. revisa las páginas simples y corrige las que no hayan quedado marcadas.
 * Las claves ya subidas se recuerdan 45 min: si falla la creación (p. ej. número repetido), al
 * reintentar no se vuelven a subir las imágenes. Pasado ese plazo se borran solas, y al terminar una
 * tanda de «Varios capítulos» se quedan solo las de los capítulos que fallaron (keepOnly).
 */
const path = require('node:path')
const fs = require('node:fs/promises')
const api = require('./api')
const { describeFile, MAX_IMAGE_BYTES } = require('./files')
const { pool, cancelled: cancelledError } = require('./util')
const diagnostics = require('./diagnostics')

const UPLOAD_CONCURRENCY = 4
const SIGN_BATCH = 100
const MAX_PAGES = 500
const CACHE_TTL = 45 * 60 * 1000
const PRUNE_EVERY = 5 * 60 * 1000

const uploadedKeys = new Map() // `${path}|${size}|${mtime}` -> { key, at }
const cacheId = (f) => `${f.path}|${f.size}|${f.mtime}`

/** Borra las claves que ya vencieron (Capibara deja de aceptarlas). */
function pruneKeys(now = Date.now()) {
  for (const [id, c] of uploadedKeys) if (now - c.at >= CACHE_TTL) uploadedKeys.delete(id)
}
setInterval(pruneKeys, PRUNE_EVERY).unref?.()

/** Se queda solo con las claves de estas rutas (los capítulos que fallaron); sin rutas, vacía todo. */
function keepOnly(paths = []) {
  const keep = new Set(paths.map(String))
  for (const id of uploadedKeys.keys()) if (!keep.has(id.slice(0, id.indexOf('|')))) uploadedKeys.delete(id)
  return uploadedKeys.size
}
const cancelled = () => cancelledError('Subida cancelada.')

/** Cada archivo llega como ruta o como { path, single } (página simple en doble página). */
const normalizeEntries = (files) => files.map((f) => (typeof f === 'string' ? { path: f, single: false } : { path: f.path, single: Boolean(f.single) }))

async function readFiles(paths) {
  const files = []
  for (const p of paths) {
    const f = await describeFile(p)
    if (!f) throw new Error(`Archivo no válido o inexistente: ${path.basename(p)}`)
    if (f.size > MAX_IMAGE_BYTES) throw new Error(`${f.name} supera los 40 MB.`)
    if (f.size === 0) throw new Error(`${f.name} está vacío.`)
    files.push(f)
  }
  if (files.length < 1 || files.length > MAX_PAGES) throw new Error(`El capítulo debe tener entre 1 y ${MAX_PAGES} páginas.`)
  return files
}

/** Cuerpo de POST /works/:id/chapters a partir de lo que manda la interfaz. */
function chapterBody(chapter, keys, singles) {
  const body = { number: chapter.number, pages: keys.map((k, i) => (singles[i] ? { key: k, single: true } : k)) }
  if (chapter.title) body.title = chapter.title
  if (chapter.volumeNumber != null) body.volumeNumber = chapter.volumeNumber
  // announcePage: número de página (1 = la primera), null = portada; sin el campo, el default del scan.
  if (chapter.announcePage !== undefined) body.announcePage = chapter.announcePage
  if (chapter.publishAt) body.publishAt = chapter.publishAt
  if (chapter.notify === false) body.notify = false
  // Extra: number es el N de «Extra N» (numeración aparte de los capítulos).
  if (chapter.extra === true) body.extra = true
  return body
}

/**
 * Sube el capítulo. payload: { workId, chapter, files }. onProgress recibe las fases
 * (prepare, upload, sign, file, create, verify, done). Devuelve el capítulo creado con singleCheck.
 */
async function uploadChapter(key, payload, { signal, onProgress = () => {} }) {
  try {
    const { workId, chapter } = payload
    const entries = normalizeEntries(payload.files)
    const singles = entries.map((e) => e.single)

    onProgress({ phase: 'prepare' })
    const started = Date.now()
    const label = `${chapter.extra ? 'Extra' : 'Cap'} ${chapter.number} → obra ${Number(workId)}`
    const files = await readFiles(entries.map((e) => e.path))
    diagnostics.info('subida', `${label}: ${files.length} páginas`)
    pruneKeys()

    const keys = new Array(files.length)
    const pending = []
    const now = Date.now()
    files.forEach((f, i) => {
      const c = uploadedKeys.get(cacheId(f))
      if (c && now - c.at < CACHE_TTL) {
        keys[i] = c.key
        onProgress({ phase: 'file', index: i, status: 'done', reused: true })
      } else {
        pending.push(i)
      }
    })

    const totalBytes = files.reduce((s, f) => s + f.size, 0)
    let doneBytes = files.reduce((s, f, i) => s + (keys[i] ? f.size : 0), 0)
    onProgress({ phase: 'upload', doneBytes, totalBytes, done: files.length - pending.length, total: files.length })

    for (let b = 0; b < pending.length; b += SIGN_BATCH) {
      if (signal.aborted) throw cancelled()
      const batch = pending.slice(b, b + SIGN_BATCH)
      onProgress({ phase: 'sign', done: b, total: pending.length })
      const res = await api.request(key, 'POST', '/uploads', {
        files: batch.map((i) => ({ contentType: files[i].type, size: files[i].size })),
      }, signal)
      const uploads = res.data.uploads

      await pool(batch, UPLOAD_CONCURRENCY, async (fileIndex, j) => {
        const f = files[fileIndex]
        const u = uploads[j]
        onProgress({ phase: 'file', index: fileIndex, status: 'uploading' })
        try {
          await api.putFile(u.uploadUrl, u.contentType, await fs.readFile(f.path), signal)
        } catch (err) {
          onProgress({ phase: 'file', index: fileIndex, status: 'error' })
          if (signal.aborted) throw cancelled()
          throw new Error(`No se pudo subir la página ${fileIndex + 1} (${f.name}): ${err.message}`)
        }
        keys[fileIndex] = u.key
        uploadedKeys.set(cacheId(f), { key: u.key, at: Date.now() })
        doneBytes += f.size
        onProgress({ phase: 'file', index: fileIndex, status: 'done' })
        onProgress({ phase: 'upload', doneBytes, totalBytes, done: keys.filter(Boolean).length, total: files.length })
      }, signal)
    }
    if (signal.aborted) throw cancelled()

    onProgress({ phase: 'create' })
    const created = await createChapter(key, workId, chapterBody(chapter, keys, singles), signal)
    // Tras crearse, las claves ya pertenecen al capítulo: no deben reutilizarse.
    files.forEach((f) => uploadedKeys.delete(cacheId(f)))

    let singleCheck = null
    if (singles.some(Boolean) && created.data?.id) {
      onProgress({ phase: 'verify' })
      singleCheck = await ensureSingles(key, created.data.id, singles)
    }
    onProgress({ phase: 'done' })
    diagnostics.info('subida', `${label}: creado (id ${created.data?.id}) en ${Math.round((Date.now() - started) / 1000)} s`)
    return { ...created.data, singleCheck }
  } catch (err) {
    if (signal.aborted && err.code !== 'cancelled') throw cancelled()
    throw err
  }
}

/**
 * POST del capítulo. Si un intento se cortó (red o 5xx) y el reintento responde que el capítulo ya
 * existe, es que el primero sí llegó: se busca y se devuelve como creado en vez de dar un error falso.
 */
async function createChapter(key, workId, body, signal) {
  const path = `/works/${Number(workId)}/chapters`
  try {
    return await api.request(key, 'POST', path, body, signal)
  } catch (err) {
    if (err.code !== 'api.chapter_exists' || !err.retried) throw err
    const list = await api.requestAll(key, `${path}?limit=100&order=desc`, signal).catch(() => [])
    const same = (c) => (body.extra
      ? (c.extra || Number(c.number) >= 100000) && Number(c.extraNumber ?? Number(c.number) - 100000) === Number(body.number)
      : Number(c.number) === Number(body.number))
    const found = list.find(same)
    if (!found) throw err
    diagnostics.warn('subida', `El capítulo ${body.number} ya existía tras un reintento: se da por creado (id ${found.id}).`)
    return { data: found }
  }
}

/**
 * Lee las páginas del capítulo y marca/desmarca las que no coincidan con lo pedido.
 * Nunca hace fallar la subida: el capítulo ya está creado.
 */
async function ensureSingles(key, chapterId, wanted) {
  const pagesPath = `/chapters/${Number(chapterId)}/pages`
  try {
    const read = async () => (await api.request(key, 'GET', pagesPath)).data.pages
    let pages = await read()
    const diff = (want) => pages.filter((pg, i) => Boolean(wanted[i]) === want && Boolean(pg.single) !== want).map((pg) => pg.id)
    const toSet = diff(true)
    const toUnset = diff(false)
    if (toSet.length) await api.request(key, 'PATCH', pagesPath, { pageIds: toSet, single: true })
    if (toUnset.length) await api.request(key, 'PATCH', pagesPath, { pageIds: toUnset, single: false })
    if (toSet.length || toUnset.length) pages = await read()
    const marked = pages.filter((pg) => pg.single).length
    const expected = wanted.filter(Boolean).length
    return { ok: marked === expected && pages.every((pg, i) => Boolean(pg.single) === Boolean(wanted[i])), marked, expected, fixed: toSet.length + toUnset.length }
  } catch (err) {
    return { ok: false, error: err.message, expected: wanted.filter(Boolean).length }
  }
}

module.exports = { uploadChapter, chapterBody, keepOnly, readFiles, cachedKeys: () => uploadedKeys.size }
