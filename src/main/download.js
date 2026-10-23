/**
 * «Descargar de Capibara»: baja las páginas de capítulos de las obras del scan activo.
 *
 * Cada capítulo queda en `destino/Obra/Vol 3 Cap 12 - Título/001.jpg…`, el mismo formato que
 * lee «Varios capítulos», así que la carpeta se puede volver a subir tal cual. Un archivo
 * `.capiuploader.json` marca los capítulos completos para saltarlos si se repite la descarga.
 *
 * Capibara guarda las páginas en WEBP; se pueden convertir a JPG (calidad 92) o PNG, o dejar
 * el original.
 */
const path = require('node:path')
const fs = require('node:fs/promises')
const api = require('./api')
const { fetchImage, pool, safeName, chapterFolderName, writePage, cancelled } = require('./images')

const PAGE_CONCURRENCY = 4
const MARKER = '.capiuploader.json'
const JPG_QUALITY = 0.92
const FORMATS = { original: null, jpg: '.jpg', png: '.png' }

/** Conversión con el decodificador de Chromium (ventana del motor de importación). */
async function convertWithEngine(buffer, format) {
  const bytes = await require('./scrape').call('convert', [buffer, format, JPG_QUALITY], { timeout: 120e3 })
  return Buffer.from(bytes)
}

async function readMarker(dir) {
  try { return JSON.parse(await fs.readFile(path.join(dir, MARKER), 'utf8')) } catch { return null }
}

/** ¿Ya está completo en este formato? El marcador coincide y siguen ahí todas las páginas. */
async function isComplete(dir, chapterId, format) {
  const m = await readMarker(dir)
  if (!m || m.chapterId !== chapterId || !Array.isArray(m.files) || (m.format || 'original') !== format) return false
  for (const f of m.files) {
    const st = await fs.stat(path.join(dir, f)).catch(() => null)
    if (!st?.size) return false
  }
  return true
}

/**
 * @param {object} o
 * @param {string} o.key        API key del scan activo
 * @param {{ id, title }} o.work
 * @param {Array<{ id, number, volumeNumber, title }>} o.chapters
 * @param {string} o.dest       carpeta elegida por el usuario
 * @param {'original' | 'jpg' | 'png'} o.format
 * @param {(p: object) => void} o.onProgress
 */
async function downloadChapters({ key, work, chapters, dest, format = 'jpg', signal, onProgress, convert = convertWithEngine }) {
  if (!(format in FORMATS)) format = 'jpg'
  const targetExt = FORMATS[format]
  const workDir = path.join(dest, safeName(work.title, `Obra ${work.id}`))
  await fs.mkdir(workDir, { recursive: true })
  const summary = { done: 0, skipped: 0, failed: [], pages: 0, workDir }

  for (let c = 0; c < chapters.length; c++) {
    if (signal.aborted) throw cancelled()
    const ch = chapters[c]
    const dir = path.join(workDir, chapterFolderName(ch))
    const base = { chapterId: ch.id, position: c, count: chapters.length }

    if (await isComplete(dir, ch.id, format)) {
      summary.skipped++
      onProgress({ ...base, status: 'skipped', dir })
      continue
    }

    onProgress({ ...base, status: 'start', done: 0, total: 0 })
    try {
      const res = await api.request(key, 'GET', `/chapters/${Number(ch.id)}/pages`, null, signal)
      const pages = [...(res.data?.pages || [])].sort((a, b) => a.number - b.number)
      if (!pages.length) throw new Error('El capítulo no tiene páginas.')
      if (pages.some((p) => !p.imageUrl)) throw new Error('La API no devolvió la dirección de alguna página.')
      await fs.mkdir(dir, { recursive: true })

      const files = new Array(pages.length)
      let done = 0
      onProgress({ ...base, status: 'page', done, total: pages.length })
      await pool(pages, PAGE_CONCURRENCY, async (pg, i) => {
        let img
        try {
          img = await fetchImage(pg.imageUrl, { signal })
          if (targetExt && img.ext !== targetExt) img = { buffer: await convert(img.buffer, format), ext: targetExt }
        } catch (err) {
          if (err.code === 'cancelled') throw err
          throw new Error(`Página ${i + 1}: ${err.message}`)
        }
        files[i] = path.basename(await writePage(dir, i, pages.length, img))
        done++
        onProgress({ ...base, status: 'page', done, total: pages.length })
      }, signal)

      // Restos de una descarga anterior con otro formato u otro número de páginas.
      const keep = new Set([...files, MARKER])
      for (const name of await fs.readdir(dir)) {
        if (!keep.has(name) && /^\d+\.(jpg|png|gif|webp|avif)(\.part)?$/i.test(name)) await fs.rm(path.join(dir, name), { force: true })
      }
      await fs.writeFile(path.join(dir, MARKER), JSON.stringify({ chapterId: ch.id, workId: work.id, number: ch.number, format, files }, null, 2))
      summary.done++
      summary.pages += pages.length
      onProgress({ ...base, status: 'done', dir, total: pages.length })
    } catch (err) {
      if (signal.aborted || err.code === 'cancelled') throw cancelled()
      if (err.code === 'api.key_invalid' || err.code === 'api.key_missing') throw err
      await fs.rmdir(dir).catch(() => {}) // solo si quedó vacía
      summary.failed.push({ chapterId: ch.id, number: ch.number, error: err.message })
      onProgress({ ...base, status: 'error', error: err.message })
    }
  }
  return summary
}

module.exports = { downloadChapters }
