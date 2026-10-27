/**
 * «Descargar de Capibara»: baja las páginas de capítulos de las obras del scan activo.
 *
 * Cada capítulo queda en `destino/Obra/Vol 3 Cap 12 - Título/001.jpg…`, el mismo formato que
 * lee «Varios capítulos», así que la carpeta se puede volver a subir tal cual. Si se repite la
 * descarga, se saltan los capítulos que ya tienen todas sus páginas en el formato elegido. No se
 * deja ningún archivo aparte de las páginas, para poder subir las carpetas tal cual (p. ej. a un Drive).
 *
 * Capibara guarda las páginas en WEBP; se pueden convertir a JPG (calidad 92) o PNG, o dejar
 * el original.
 */
const path = require('node:path')
const fs = require('node:fs/promises')
const api = require('./api')
const { fetchImage, pool, safeName, chapterFolderName, writePage, cancelled } = require('./images')

const PAGE_CONCURRENCY = 4
const LEGACY_MARKER = '.capiuploader.json'
const JPG_QUALITY = 0.92
const FORMATS = { original: null, jpg: '.jpg', png: '.png' }

/** Conversión con el decodificador de Chromium (ventana del motor de importación). */
async function convertWithEngine(buffer, format) {
  const bytes = await require('./scrape').call('convert', [buffer, format, JPG_QUALITY], { timeout: 120e3 })
  return Buffer.from(bytes)
}

const PAGE_RE = /^\d+\.(jpg|png|gif|webp|avif)$/i

/**
 * ¿Ya está completo en este formato? Están las `total` páginas (001, 002…) con la extensión del
 * formato, ninguna vacía y ninguna de más. Las páginas se escriben a un `.part` y se renombran al
 * terminar, así que una descarga cortada deja páginas de menos (o un `.part`) y se repite.
 */
async function isComplete(dir, total, format) {
  if (!Number.isInteger(total) || total < 1) return false
  const names = await fs.readdir(dir).catch(() => null)
  if (!names || names.some((n) => /\.part$/i.test(n))) return false
  const pages = names.filter((n) => PAGE_RE.test(n))
  if (pages.length !== total) return false
  const ext = FORMATS[format]
  const width = Math.max(3, String(total).length)
  for (let i = 1; i <= total; i++) {
    const num = String(i).padStart(width, '0')
    const name = pages.find((n) => path.parse(n).name === num && (!ext || path.extname(n).toLowerCase() === ext))
    if (!name) return false
    const st = await fs.stat(path.join(dir, name)).catch(() => null)
    if (!st?.size) return false
  }
  return true
}

/** Las versiones 1.3.0 y 1.3.1 dejaban este archivo en cada capítulo; se borra al pasar por ahí. */
const removeLegacyMarker = (dir) => fs.rm(path.join(dir, LEGACY_MARKER), { force: true }).catch(() => {})

/**
 * @param {object} o
 * @param {string} o.key        API key del scan activo
 * @param {{ id, title }} o.work
 * @param {Array<{ id, number, volumeNumber, title, pages }>} o.chapters  pages: cuántas tiene según la lista de la obra
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

    if (await isComplete(dir, ch.pages, format)) {
      await removeLegacyMarker(dir)
      summary.skipped++
      onProgress({ ...base, status: 'skipped', dir })
      continue
    }

    onProgress({ ...base, status: 'start', done: 0, total: 0 })
    try {
      const res = await api.request(key, 'GET', `/chapters/${Number(ch.id)}/pages`, null, signal)
      const pages = [...(res.data?.pages || [])].sort((a, b) => a.number - b.number)
      if (!pages.length) throw new Error('El capítulo no tiene páginas.')
      if (pages.every((p) => !p.imageUrl)) {
        // Capibara solo da las imágenes a claves con chapters:write.
        const err = new Error('Esta API key no puede ver las imágenes: para descargar necesita el permiso chapters:write.')
        err.code = 'api.scope_missing'
        throw err
      }
      if (pages.some((p) => !p.imageUrl)) throw new Error('La API no devolvió la dirección de alguna página.')
      await removeLegacyMarker(dir)
      // La lista de la obra no traía el número de páginas (o no coincidía): se revisa con el real.
      if (ch.pages !== pages.length && await isComplete(dir, pages.length, format)) {
        summary.skipped++
        onProgress({ ...base, status: 'skipped', dir })
        continue
      }
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
      const keep = new Set(files)
      for (const name of await fs.readdir(dir)) {
        if (!keep.has(name) && /^\d+\.(jpg|png|gif|webp|avif)(\.part)?$/i.test(name)) await fs.rm(path.join(dir, name), { force: true })
      }
      summary.done++
      summary.pages += pages.length
      onProgress({ ...base, status: 'done', dir, total: pages.length })
    } catch (err) {
      if (signal.aborted || err.code === 'cancelled') throw cancelled()
      if (['api.key_invalid', 'api.key_missing', 'api.scope_missing', 'api.rate_limited'].includes(err.code)) throw err
      await fs.rmdir(dir).catch(() => {}) // solo si quedó vacía
      summary.failed.push({ chapterId: ch.id, number: ch.number, error: err.message })
      onProgress({ ...base, status: 'error', error: err.message })
    }
  }
  return summary
}

module.exports = { downloadChapters }
