/**
 * «Importar de web»: con el motor de HaruNeko (scrape.js) lee una obra de otra web, baja las
 * páginas de los capítulos elegidos y los deja en carpetas «Obra/Cap 12 - Título» dentro de
 * userData/import-cache, listas para «Varios capítulos».
 */
const path = require('node:path')
const fs = require('node:fs/promises')
const scrape = require('./scrape')
const { pool, sniff, safeName, chapterFolderName, writePage, cancelled } = require('./images')

const PAGE_CONCURRENCY = 4
const IMAGE_RETRIES = 2
const PLACEHOLDER_BYTES = 1024
const CACHE_MAX_AGE = 3 * 24 * 60 * 60 * 1000
const MAX_BYTES = 40 * 1024 * 1024

let cacheDir = null

async function init(userData) {
  cacheDir = path.join(userData, 'import-cache')
  await fs.mkdir(cacheDir, { recursive: true })
  const now = Date.now()
  for (const name of await fs.readdir(cacheDir).catch(() => [])) {
    const p = path.join(cacheDir, name)
    const st = await fs.stat(p).catch(() => null)
    if (st && now - st.mtimeMs > CACHE_MAX_AGE) await fs.rm(p, { recursive: true, force: true }).catch(() => {})
  }
}

function checkUrl(url) {
  let u
  try { u = new URL(String(url).trim()) } catch { throw new Error('El enlace no es válido.') }
  if (!/^https?:$/.test(u.protocol)) throw new Error('El enlace debe empezar con http:// o https://')
  return u.href
}

async function identify(url) {
  const href = checkUrl(url)
  const info = await scrape.start()
  const res = await scrape.call('identify', [href])
  return { ...res, url: href, websites: info.websites }
}

async function open(url, websiteId) {
  const href = checkUrl(url)
  return scrape.call('manga', [href, websiteId || null], { timeout: 300e3 })
}

/**
 * @param {object} o
 * @param {string} o.key        obra abierta en el motor
 * @param {string} o.workTitle  título de la obra en Capibara (nombre de la carpeta)
 * @param {Array<{ index, number, volumeNumber, title }>} o.chapters
 */
async function download({ key, workTitle, chapters, signal, onProgress }) {
  const job = path.join(cacheDir, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`)
  const workDir = path.join(job, safeName(workTitle, 'Obra'))
  await fs.mkdir(workDir, { recursive: true })
  const result = { dirs: [], failed: [], pages: 0 }

  for (let c = 0; c < chapters.length; c++) {
    if (signal.aborted) throw cancelled()
    const ch = chapters[c]
    const base = { index: ch.index, position: c, count: chapters.length }
    onProgress({ ...base, status: 'start', done: 0, total: 0 })
    const dir = path.join(workDir, chapterFolderName(ch))
    try {
      const { count } = await scrape.call('pages', [key, ch.index], { signal, timeout: 300e3 })
      if (!count) throw new Error('El sitio no devolvió páginas para este capítulo.')
      await fs.mkdir(dir, { recursive: true })
      let done = 0
      let tiny = 0
      onProgress({ ...base, status: 'page', done, total: count })
      await pool(Array.from({ length: count }, (_, i) => i), PAGE_CONCURRENCY, async (i) => {
        let bytes
        for (let attempt = 0; ; attempt++) {
          try {
            // Una conexión colgada no da error: con el tiempo límite se cancela y se reintenta.
            bytes = await scrape.call('image', [key, ch.index, i], { signal, timeout: 75e3 })
            break
          } catch (err) {
            if (err.code === 'cancelled') throw err
            if (attempt >= IMAGE_RETRIES) throw new Error(`Página ${i + 1}: ${err.message}`)
          }
        }
        const buffer = Buffer.from(bytes)
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
    }
  }
  return result
}

function release(key) {
  return scrape.call('release', [key]).catch(() => false)
}

module.exports = { init, identify, open, download, release }
