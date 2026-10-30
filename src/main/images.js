/**
 * Descarga de imágenes, compartida por «Descargar de Capibara» e «Importar de web».
 * El formato se decide por los primeros bytes del archivo, no por la URL ni por el
 * Content-Type: muchas webs sirven WEBP con extensión .jpg o páginas de error como imagen.
 */
const path = require('node:path')
const fs = require('node:fs/promises')
const { sleep, pool, withTimeout, cancelled: cancelledError } = require('./util')

const MAX_RETRIES = 3
const MAX_BYTES = 40 * 1024 * 1024
// Una conexión colgada no da error: pasado este tiempo se corta y se reintenta.
const IMAGE_TIMEOUT = 75e3

const cancelled = () => cancelledError('Descarga cancelada.')

/** Extensión según la firma del archivo, o null si no es una imagen que Capibara acepte. */
function sniff(buf) {
  if (buf.length < 12) return null
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg'
  if (buf.readUInt32BE(0) === 0x89504e47) return '.png'
  if (buf.toString('latin1', 0, 4) === 'GIF8') return '.gif'
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return '.webp'
  if (buf.toString('latin1', 4, 8) === 'ftyp' && /^avi[fs]$/.test(buf.toString('latin1', 8, 12))) return '.avif'
  return null
}

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, '') } catch { return 'el sitio' } }

/**
 * Descarga una imagen con reintentos ante 429, 5xx, errores de red y conexiones colgadas.
 * Devuelve { buffer, ext }. Falla sin reintentar (error con `fatal`) si el sitio responde un 4xx
 * definitivo, si lo que llega no es una imagen o si pesa más de 40 MB; una imagen incompleta sí se
 * reintenta. `fetcher` permite pasar las peticiones por otro camino (la sesión del navegador oculto,
 * o el turno por sitio de los lectores propios); `retries` cuántas veces se reintenta.
 */
async function fetchImage(url, { fetcher = fetch, headers = {}, signal, retries = MAX_RETRIES, timeout = IMAGE_TIMEOUT } = {}) {
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw cancelled()
    try {
      const res = await fetcher(url, { headers, signal: withTimeout(signal, timeout), redirect: 'follow' })
      if (res.ok) {
        const buffer = Buffer.from(await res.arrayBuffer())
        const declared = Number(res.headers.get('content-length'))
        const fatal = (message) => Object.assign(new Error(message), { fatal: true })
        if (!res.headers.get('content-encoding') && declared > 0 && buffer.length !== declared) throw new Error('La imagen llegó incompleta.')
        const ext = sniff(buffer)
        if (!ext) throw fatal('El archivo descargado no es una imagen.')
        if (buffer.length > MAX_BYTES) throw fatal('La imagen supera los 40 MB.')
        return { buffer, ext }
      }
      lastErr = new Error(`${hostOf(url)} respondió ${res.status}.`)
      if (res.status === 429) {
        const wait = Number(res.headers.get('retry-after')) || 5
        if (attempt < retries) { await sleep(Math.min(wait, 60) * 1000, signal); continue }
      }
      // 404, 403, 410…: la página no existe o no la dan; reintentar solo gasta peticiones.
      if (res.status < 500 && res.status !== 429 && res.status !== 408) throw Object.assign(lastErr, { fatal: true })
    } catch (err) {
      if (signal?.aborted) throw cancelled()
      if (err.fatal) throw err
      lastErr = err.name === 'TimeoutError' ? new Error(`${hostOf(url)} tardó demasiado en responder.`) : err
    }
    if (attempt < retries) await sleep(1000 * 2 ** attempt, signal)
  }
  throw lastErr
}

/** Nombre válido en Windows: sin caracteres prohibidos, sin punto o espacio final y corto. */
function safeName(s, fallback = 'Sin título') {
  const clean = String(s || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
    .replace(/[. ]+$/, '')
  if (!clean || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(clean)) return fallback
  return clean
}

/**
 * «Vol 3 Cap 12 - Título» o «Extra 2 - Título»: el mismo formato que reconoce «Varios capítulos».
 * extraNumber: el N de un extra (la API lo guarda con number = 100000 + N).
 */
function chapterFolderName({ number, volumeNumber, title, extra = false, extraNumber = null }) {
  const vol = volumeNumber != null ? `Vol ${volumeNumber} ` : ''
  const t = title ? ` - ${title}` : ''
  const label = extra ? `Extra ${extraNumber ?? number}` : `Cap ${number}`
  return safeName(`${vol}${label}${t}`, label)
}

/** Guarda las páginas como 001.jpg, 002.webp… en `dir`, escribiendo primero a un temporal. */
async function writePage(dir, index, total, { buffer, ext }) {
  const name = String(index + 1).padStart(Math.max(3, String(total).length), '0') + ext
  const file = path.join(dir, name)
  const tmp = `${file}.part`
  await fs.writeFile(tmp, buffer)
  await fs.rename(tmp, file)
  return file
}

module.exports = { fetchImage, sniff, safeName, chapterFolderName, writePage, cancelled }
