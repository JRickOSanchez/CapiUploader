/**
 * Lectores propios de «Importar de web» para webs de scans en español que el motor de HaruNeko no
 * lee (o lee peor). Cada sitio (sites/*.js) tiene la misma forma:
 *   match(url, host, partes)  → null (no es del sitio) | { error } (no es una obra) | datos de la obra
 *   headers(url)              → Referer y demás cabeceras que pide el sitio
 *   list(obra, opciones)      → { title, chapters: [{ number, label, group, date, url, … }] }
 *   pages(capítulo, opciones) → { urls, alts? } (alts[i]: copia de respaldo de la página i)
 */
const { fetchImage } = require('../images')
const { hostOf, slugTitle } = require('./html')
const { UA, politeFetch } = require('./http')
const mangadex = require('./sites/mangadex')

const SITES = [
  require('./sites/mangatv'),
  require('./sites/onf'),
  mangadex,
  require('./sites/shade'),
  require('./sites/dark'),
  require('./sites/enchilada'),
  require('./sites/tmo'),
]
const byId = new Map(SITES.map((s) => [s.id, s]))
// Los reintentos de las imágenes de los lectores propios se hacen solo aquí (importer.js no los repite).
const IMAGE_RETRIES = 2

const decode = (p) => { try { return decodeURIComponent(p) } catch { return p } }

function siteOf(id) {
  const site = byId.get(id)
  if (!site) throw new Error(`Lector desconocido: ${id}`)
  return site
}

/** La obra de una URL: { site, title, url, … }, { error } si es del sitio pero no es una obra, o null. */
function identify(raw) {
  let u
  try { u = new URL(String(raw).trim()) } catch { return null }
  const host = u.hostname.replace(/^www\./, '')
  const parts = u.pathname.split('/').filter(Boolean).map(decode)
  for (const site of SITES) {
    const found = site.match(u, host, parts)
    if (!found) continue
    return found.error ? found : { ...found, site: site.id, title: site.name, url: u.href }
  }
  return null
}

/** Capítulos de una obra (de identify), ordenados por número. */
async function list(src, { signal } = {}) {
  const site = siteOf(src.site)
  const { title, chapters } = await site.list(src, { headers: site.headers(src.url), signal })
  if (!chapters.length) throw new Error(`No encontré capítulos en esa página de ${hostOf(src.url)}. Puede que la web haya cambiado o que los cargue de otra forma.`)
  chapters.sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity))
  return { title: title || slugTitle(src.url) || site.name, chapters }
}

/** Páginas de un capítulo (una fila de list()): { urls, alts, headers }. */
async function pages(siteId, chapter, { signal } = {}) {
  const site = siteOf(siteId)
  const headers = site.headers(chapter.url)
  const { urls, alts = [] } = await site.pages(chapter, { headers, signal })
  return { urls, alts, headers }
}

function download(url, headers, signal) {
  const h = { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/*,*/*;q=0.8', ...headers }
  if (mangadex.isOwnHost(url)) h['User-Agent'] = mangadex.HONEST_UA
  return fetchImage(url, { headers: h, signal, retries: IMAGE_RETRIES, fetcher: politeFetch }).then((img) => img.buffer)
}

/** Baja una imagen y, si falla y hay copia de respaldo, la copia. */
async function image(url, headers, signal, alt = null) {
  try {
    return await download(url, headers, signal)
  } catch (err) {
    if (!alt || signal?.aborted) throw err
    return download(alt, headers, signal)
  }
}

module.exports = { SITES, identify, list, pages, image }
