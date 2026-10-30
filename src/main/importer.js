/**
 * «Importar de web»: lee una obra de otra web, baja las páginas de los capítulos elegidos y los deja
 * en carpetas «Obra/Cap 12 - Título» dentro de userData/import-cache, listas para «Varios capítulos».
 * Las webs con lector propio (readers/) se leen directamente; el resto, con el motor de HaruNeko
 * (scrape.js). Si un lector propio falla y HaruNeko conoce la web, se reintenta con HaruNeko.
 */
const path = require('node:path')
const fs = require('node:fs/promises')
const scrape = require('./scrape')
const readers = require('./readers')
const { sniff, safeName, chapterFolderName, writePage, cancelled } = require('./images')
const { pool, prepareCache, sleep } = require('./util')
const diagnostics = require('./diagnostics')

const PAGE_CONCURRENCY = 4
const PLACEHOLDER_BYTES = 1024
const MAX_BYTES = 40 * 1024 * 1024
const OWN = 'own:'

let cacheDir = null
// Obras abiertas con un lector propio: key -> { site, chapters, pages: Map(índice -> { urls, alts, headers }) }
const own = new Map()
let ownSeq = 0
// Obras abiertas en el motor: clave propia («e1», que no se repite) -> { key (la del motor ahora), url,
// websiteId, gen, ids }. El motor se cierra solo tras un rato sin uso (y al volver a arrancar repite sus
// claves); si pasó, la obra se vuelve a abrir al pedir sus páginas.
const engineOpen = new Map()
let engineSeq = 0
// Volver a buscar la misma obra al rato es habitual (p. ej. tras crear su ficha): durante REUSE_MS se
// reutiliza lo ya leído en vez de pedirle de nuevo toda la lista a la web.
const REUSE_MS = 5 * 60e3
const LIST_CACHE_MAX = 5
const listCache = new Map() // URL de la obra (lector propio) -> { at, title, chapters }

function cachedList(href) {
  const hit = listCache.get(href)
  if (hit && Date.now() - hit.at < REUSE_MS) return hit
  listCache.delete(href)
  return null
}

function rememberList(href, data) {
  listCache.delete(href)
  listCache.set(href, { at: Date.now(), ...data })
  while (listCache.size > LIST_CACHE_MAX) listCache.delete(listCache.keys().next().value)
}

async function init(userData) {
  cacheDir = await prepareCache(path.join(userData, 'import-cache'))
}

function checkUrl(url) {
  let u
  try { u = new URL(String(url).trim()) } catch { throw new Error('El enlace no es válido.') }
  if (!/^https?:$/.test(u.protocol)) throw new Error('El enlace debe empezar con http:// o https://')
  return u.href
}

const describeOwn = (src) => ({ id: OWN + src.site, title: src.title, url: new URL(src.url).origin, icon: null, languages: [], own: true })

async function identify(url) {
  const href = checkUrl(url)
  const mine = readers.identify(href)
  if (mine?.error) throw new Error(mine.error)
  if (mine) return { matches: [describeOwn(mine)], sameHost: [], generic: null, url: href }
  const info = await scrape.start()
  const res = await scrape.call('identify', [href])
  return { ...res, url: href, websites: info.websites }
}

async function openOwn(href) {
  const src = readers.identify(href)
  let list = cachedList(href)
  if (!list) {
    list = await readers.list(src)
    rememberList(href, list)
  }
  const { title, chapters } = list
  const key = `o${++ownSeq}`
  own.set(key, { site: src.site, chapters, pages: new Map() })
  return {
    key,
    title,
    website: describeOwn(src),
    chapters: chapters.map((c, index) => ({
      index, id: c.url, title: c.label || (c.number != null ? `Capítulo ${c.number}` : `Capítulo ${index + 1}`),
      languages: c.languages || [], group: c.group || '', number: c.number, volume: c.volume ?? null,
    })),
  }
}

/**
 * Abre la obra en el motor de HaruNeko y recuerda cómo volver a abrirla. Si se soltó hace poco
 * (release) y el motor sigue siendo el mismo, se reutiliza tal cual.
 */
async function openInEngine(href, websiteId, signal) {
  websiteId = websiteId || null
  for (const [key, e] of engineOpen) {
    if (e.url !== href || e.websiteId !== websiteId || !e.releasedAt || e.gen !== scrape.generation()) continue
    clearTimeout(e.releaseTimer)
    e.releasedAt = null
    return { ...e.result, key }
  }
  const res = await scrape.call('manga', [href, websiteId], { signal, timeout: 300e3 })
  const key = `e${++engineSeq}`
  const { key: _engineKey, ...result } = res
  engineOpen.set(key, { key: res.key, url: href, websiteId, gen: scrape.generation(), ids: res.chapters.map((c) => c.id), result, releasedAt: null })
  return { ...result, key }
}

async function open(url, websiteId) {
  const href = checkUrl(url)
  if (!String(websiteId || '').startsWith(OWN)) return openInEngine(href, websiteId)
  try {
    return await openOwn(href)
  } catch (err) {
    // Respaldo: si HaruNeko conoce la web, que la lea él.
    diagnostics.warn('importar', `El lector propio falló (${err.message}); se prueba con HaruNeko.`)
    const res = await scrape.start().then(() => scrape.call('identify', [href])).catch(() => null)
    const site = res?.matches?.[0] || res?.generic
    if (!site) throw err
    return openInEngine(href, site.id)
  }
}

/**
 * La obra abierta en el motor actual: si el motor se cerró por inactividad (o se reinició), se
 * vuelve a abrir y cada capítulo se busca por su id, no por su posición.
 */
async function engineEntry(key, signal) {
  const entry = engineOpen.get(key)
  if (!entry) throw new Error('La obra ya no está abierta. Vuelve a buscarla.')
  if (entry.gen !== scrape.generation()) {
    const res = await scrape.call('manga', [entry.url, entry.websiteId], { signal, timeout: 300e3 })
    entry.key = res.key
    entry.gen = scrape.generation()
    entry.positions = new Map(res.chapters.map((c) => [c.id, c.index]))
  }
  return {
    key: entry.key,
    index(i) {
      if (!entry.positions) return i // sigue abierta tal cual
      const now = entry.positions.get(entry.ids[i])
      if (now == null) throw new Error('El capítulo ya no está en la web. Vuelve a buscar la obra.')
      return now
    },
  }
}

/**
 * Cómo pedir las páginas de una obra abierta: con su lector propio o con el motor de HaruNeko.
 * `retries`: cuántas veces se repite aquí una imagen que falló. Los lectores propios ya reintentan
 * dentro de readers (con espera y respetando Retry-After); el motor no, así que se reintenta aquí.
 */
function sourceFor(key, signal) {
  const entry = own.get(key)
  if (!entry) {
    let live = null
    return {
      retries: 2,
      async count(index) {
        live = await engineEntry(key, signal)
        return (await scrape.call('pages', [live.key, live.index(index)], { signal, timeout: 300e3 })).count
      },
      // Una conexión colgada no da error: con el tiempo límite se cancela y se reintenta.
      image: async (index, i) => Buffer.from(await scrape.call('image', [live.key, live.index(index), i], { signal, timeout: 75e3 })),
    }
  }
  return {
    retries: 0,
    async count(index) {
      const chapter = entry.chapters[index]
      if (!chapter) throw new Error('El capítulo ya no está disponible. Vuelve a buscar la obra.')
      const res = await readers.pages(entry.site, chapter, { signal })
      entry.pages.set(index, res)
      return res.urls.length
    },
    image(index, i) {
      const p = entry.pages.get(index)
      if (!p?.urls[i]) throw new Error('La página ya no está disponible.')
      return readers.image(p.urls[i], p.headers, signal, p.alts?.[i])
    },
  }
}

/**
 * @param {object} o
 * @param {string} o.key        obra abierta (en un lector propio o en el motor)
 * @param {string} o.workTitle  título de la obra en Capibara (nombre de la carpeta)
 * @param {Array<{ index, number, volumeNumber, title }>} o.chapters
 */
async function download({ key, workTitle, chapters, signal, onProgress }) {
  const job = path.join(cacheDir, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`)
  const workDir = path.join(job, safeName(workTitle, 'Obra'))
  await fs.mkdir(workDir, { recursive: true })
  const result = { dirs: [], failed: [], pages: 0 }
  const source = sourceFor(key, signal)

  for (let c = 0; c < chapters.length; c++) {
    if (signal.aborted) throw cancelled()
    const ch = chapters[c]
    const base = { index: ch.index, position: c, count: chapters.length }
    onProgress({ ...base, status: 'start', done: 0, total: 0 })
    const dir = path.join(workDir, chapterFolderName(ch))
    try {
      const count = await source.count(ch.index)
      if (!count) throw new Error('El sitio no devolvió páginas para este capítulo.')
      await fs.mkdir(dir, { recursive: true })
      let done = 0
      let tiny = 0
      onProgress({ ...base, status: 'page', done, total: count })
      await pool(Array.from({ length: count }, (_, i) => i), PAGE_CONCURRENCY, async (i) => {
        let buffer
        for (let attempt = 0; ; attempt++) {
          try {
            buffer = await source.image(ch.index, i)
            break
          } catch (err) {
            if (err.code === 'cancelled' || signal.aborted) throw err
            // fatal: no existe, no es una imagen o pesa demasiado; reintentar no sirve.
            if (err.fatal || attempt >= source.retries) throw new Error(`Página ${i + 1}: ${err.message}`)
            await sleep(1000 * (attempt + 1), signal) // sin martillar al sitio
          }
        }
        const ext = sniff(buffer)
        if (!ext) throw new Error(`Página ${i + 1}: el sitio no devolvió una imagen válida.`)
        if (buffer.length > MAX_BYTES) throw new Error(`Página ${i + 1}: supera los 40 MB.`)
        if (buffer.length < PLACEHOLDER_BYTES) tiny++
        await writePage(dir, i, count, { buffer, ext })
        done++
        onProgress({ ...base, status: 'page', done, total: count })
      }, signal)
      // Algunas webs esconden las páginas tras imágenes de relleno (1×1) si no se leen con su lector.
      if (tiny >= Math.ceil(count / 2)) {
        throw new Error('El sitio entregó imágenes de relleno en lugar de las páginas. Puede que haya cambiado su lector: este sitio no se puede importar por ahora.')
      }
      result.dirs.push({ index: ch.index, dir })
      result.pages += count
      onProgress({ ...base, status: 'done', total: count })
    } catch (err) {
      if (signal.aborted || err.code === 'cancelled') throw cancelled()
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
      result.failed.push({ index: ch.index, number: ch.number, error: err.message })
      onProgress({ ...base, status: 'error', error: err.message })
      diagnostics.warn('importar', `Capítulo ${ch.number}: ${err.message}`)
    }
  }
  return result
}

/**
 * Suelta una obra. Las del motor se liberan de verdad pasados REUSE_MS, por si se vuelve a buscar;
 * si el motor ya se cerró, no queda nada que liberar (y no se vuelve a arrancar para eso).
 */
function release(key) {
  if (own.delete(key)) return Promise.resolve(true)
  const entry = engineOpen.get(key)
  if (!entry) return Promise.resolve(true)
  if (entry.gen !== scrape.generation()) { engineOpen.delete(key); return Promise.resolve(true) }
  entry.releasedAt = Date.now()
  clearTimeout(entry.releaseTimer)
  entry.releaseTimer = setTimeout(() => {
    engineOpen.delete(key)
    if (entry.gen === scrape.generation()) scrape.forget(entry.key)
  }, REUSE_MS)
  entry.releaseTimer.unref?.()
  return Promise.resolve(true)
}

module.exports = { init, identify, open, download, release }
