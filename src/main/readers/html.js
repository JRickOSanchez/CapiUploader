/** Utilidades puras para leer HTML y scripts de las webs (sin red ni Electron). */

const BLACKLIST = ['cover', 'thumb', 'avatar', 'logo', 'banner', 'placeholder', 'loading', 'spinner', 'noimage', 'no-image', 'icon', 'button', 'gravatar', 'google', 'facebook', 'twitter', 'wp-includes', 'emoji', 'advertisement', 'ad-', '/ads/']
const IMG_EXT = /\.(webp|jpe?g|png|gif|avif)(?:\?|$)/i
const DATE = /\d{4}-\d{2}-\d{2}/
const NUM_RE = /(?:cap[ií]tulo|cap\.?|chapter|ch\.?)\s*(\d+(?:[.,]\d+)?)/i

/** ¿Parece la imagen de una página (y no un logo, un avatar o un anuncio)? */
const isPageImage = (u) => typeof u === 'string' && /^https?:\/\//i.test(u) && IMG_EXT.test(u) && !BLACKLIST.some((w) => u.toLowerCase().includes(w))
const unent = (s) => String(s).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#x27;/gi, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
const stripTags = (s) => unent(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
const absolute = (u, base) => { try { return new URL(unent(u).trim(), base).href } catch { return '' } }
const hostIs = (host, name) => host === name || host.endsWith(`.${name}`)
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url } }
/** Primera fecha AAAA-MM-DD del texto, o ''. */
const dateIn = (text) => DATE.exec(String(text || ''))?.[0] || ''

/** Valor de un atributo dentro de una etiqueta suelta. */
function attr(tag, name) {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag)
  return m ? (m[1] ?? m[2]) : null
}

/** Número de capítulo a partir de texto («Capítulo 12.5», «chapter-12»). */
function chapterNumber(...texts) {
  for (const t of texts) {
    const m = /(?:cap[ií]tulo|capitulo|cap\.?|chapter|ch\.?)[\s_-]*(\d+(?:[.,]\d+)?)/i.exec(String(t || '').replace(/-/g, ' ').replace(/\s+/g, ' '))
    if (m) return Number(m[1].replace(',', '.'))
  }
  return null
}

/** Título de la obra según su página: og:title, el primer <h1> o <title>, sin el nombre del sitio. */
function pageTitle(html, siteName = '') {
  const text = String(html || '')
  const og = /<meta\b[^>]*property=["']og:title["'][^>]*>/i.exec(text)
  const raw = (og && attr(og[0], 'content'))
    || /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(text)?.[1]
    || /<title>([\s\S]*?)<\/title>/i.exec(text)?.[1]
    || ''
  let t = stripTags(raw)
  // «Obra – MangaTV», «Obra - Leer Online en Español», «Obra - Dark Gathering»…
  const parts = t.split(/\s+[|–—-]\s+/)
  if (parts.length > 1) {
    const squash = (p) => p.toLowerCase().replace(/\s+/g, '')
    const site = squash(siteName)
    const kept = parts.filter((p) => !(site && (site.includes(squash(p)) || squash(p).includes(site))) && !/^(leer|ver|read)\s+online\b/i.test(p))
    if (kept.length) t = kept.join(' - ')
  }
  return t
    .replace(/^(leer|ver|read)\s+/i, '')
    .replace(/\s+(?:(?:manga|manhwa|manhua)\s+)?(?:online\s+)?(?:gratis|en\s+espa[ñn]ol|online)(?:\s+(?:gratis|en\s+espa[ñn]ol|online))*$/i, '')
    .trim()
}

/** «https://web.com/manga/mi-obra-genial/» → «Mi obra genial» (último recurso para el título). */
function slugTitle(url) {
  let seg = ''
  try {
    seg = new URL(url).pathname.split('/').filter((p) => p && !/^(manga|serie|obras|library|title|inicio|enchiladaweb|local|\d+)$/i.test(p)).pop() || ''
  } catch { /* URL no válida */ }
  const t = decodeURIComponent(seg).replace(/[-_]+/g, ' ').trim()
  return t ? t[0].toUpperCase() + t.slice(1) : ''
}

/**
 * Desempaqueta un script «eval(function(p,a,c,k,e,d){…}('…',a,c,'…'.split('|'),0,{}))» sin ejecutar
 * nada: solo reemplaza las palabras de la tabla. Devuelve null si no hay ninguno.
 */
function unpackJs(src) {
  const text = String(src || '')
  const at = text.indexOf('eval(function(p,a,c,k,e,')
  if (at < 0) return null
  const m = /\}\s*\(\s*'((?:[^'\\]|\\.)*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'((?:[^'\\]|\\.)*)'\.split\('\|'\)/.exec(text.slice(at))
  if (!m) return null
  const p = m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\')
  const a = Number(m[2])
  let c = Number(m[3])
  const k = m[4].split('|')
  const enc = (n) => (n < a ? '' : enc(Math.floor(n / a))) + ((n = n % a) > 35 ? String.fromCharCode(n + 29) : n.toString(36))
  const dict = Object.create(null)
  while (c--) dict[enc(c)] = k[c] || enc(c)
  return p.replace(/\b\w+\b/g, (w) => (w in dict ? dict[w] : w))
}

/** Cuerpo del objeto JSON que empieza en `start` (llaves balanceadas, respetando cadenas). */
function balancedJson(text, start) {
  let depth = 0
  let inStr = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (c === '\\') i++
      else if (c === '"') inStr = false
    } else if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1)
  }
  return null
}

/** Ordena URLs de páginas por nombre de archivo (001, 002…) si la mayoría lleva número. */
function naturalSortUrls(urls) {
  const name = (u) => u.split('/').pop().split('?')[0]
  if (urls.filter((u) => /\d/.test(name(u))).length < urls.length * 0.5) return urls
  return [...urls].sort((a, b) => name(a).localeCompare(name(b), undefined, { numeric: true, sensitivity: 'base' }))
}

/** JSON incrustado como texto hexadecimal («5b7b…»), o null. */
function hexJson(hex) {
  if (!hex || hex.length % 2) return null
  try { return JSON.parse(Buffer.from(hex, 'hex').toString('utf8')) } catch { return null }
}

module.exports = {
  DATE, NUM_RE, isPageImage, unent, stripTags, absolute, hostIs, hostOf, dateIn, attr, chapterNumber,
  pageTitle, slugTitle, unpackJs, balancedJson, naturalSortUrls, hexJson,
}
