/**
 * Descarga de imágenes, compartida por «Descargar de Capibara» e «Importar de web».
 * El formato se decide por los primeros bytes del archivo, no por la URL ni por el
 * Content-Type: muchas webs sirven WEBP con extensión .jpg o páginas de error como imagen.
 */
const path = require('node:path')
const fs = require('node:fs/promises')

const MAX_RETRIES = 3
const MAX_BYTES = 40 * 1024 * 1024

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(cancelled()) }, { once: true })
})

function cancelled() {
  const err = new Error('Descarga cancelada.')
  err.code = 'cancelled'
  return err
}

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

/**
 * Descarga una imagen con reintentos ante 429, 5xx y errores de red.
 * `fetcher` permite usar la sesión del navegador oculto (cookies de Cloudflare).
 */
async function fetchImage(url, { fetcher = fetch, headers = {}, signal } = {}) {
  let lastErr
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw cancelled()
    try {
      const res = await fetcher(url, { headers, signal, redirect: 'follow' })
      if (res.ok) {
        const buffer = Buffer.from(await res.arrayBuffer())
        const ext = sniff(buffer)
        if (!ext) throw Object.assign(new Error('El archivo descargado no es una imagen.'), { fatal: true })
        if (buffer.length > MAX_BYTES) throw Object.assign(new Error('La imagen supera los 40 MB.'), { fatal: true })
        return { buffer, ext }
      }
      lastErr = new Error(`HTTP ${res.status}`)
      if (res.status === 429) {
        const wait = Number(res.headers.get('retry-after')) || 5
        if (attempt < MAX_RETRIES) { await sleep(Math.min(wait, 60) * 1000, signal); continue }
      }
      if (res.status < 500 && res.status !== 429) break
    } catch (err) {
      if (signal?.aborted) throw cancelled()
      if (err.fatal) throw err
      lastErr = err
    }
    if (attempt < MAX_RETRIES) await sleep(1000 * 2 ** attempt, signal)
  }
  throw lastErr
}

/** Ejecuta `worker` sobre cada elemento con `limit` en paralelo. */
async function pool(items, limit, worker, signal) {
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      if (signal?.aborted) throw cancelled()
      const i = next++
      await worker(items[i], i)
    }
  })
  await Promise.all(runners)
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

module.exports = { fetchImage, pool, sniff, safeName, chapterFolderName, writePage, cancelled }
