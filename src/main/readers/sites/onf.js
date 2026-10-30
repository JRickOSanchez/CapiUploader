/**
 * ONF Mangas. La obra incrusta todos sus capítulos (y las versiones de otros scans) como JSON en
 * hexadecimal; cada capítulo, sus páginas igual (a veces alojadas en MangaDex, con copia de respaldo).
 * Si la web cambia, se leen los enlaces del HTML y, por último, la página armada en una ventana oculta.
 */
const h = require('../html')
const { getText, quiet, renderPage } = require('../http')

const BASE = 'https://onfmangas.com'
const HEADERS = { Referer: `${BASE}/` }

function match(u, host, parts) {
  if (host !== 'onfmangas.com') return null
  if (parts[0] === 'lector') return { error: 'Esa es la URL de un capítulo; pega la de la obra (https://onfmangas.com/manga/<id>/<nombre>).' }
  if (parts[0] !== 'manga' || !/^\d+$/.test(parts[1] || '')) return { error: 'La URL de ONF Mangas debe ser la de la obra (https://onfmangas.com/manga/<id>/<nombre>).' }
  return {}
}

/** Páginas de un capítulo: [{ url, alt }] (alt: copia de respaldo, si la web la da). */
function parsePages(html, base = BASE) {
  const data = h.hexJson(/const\s+_hexP\s*=\s*["']([0-9a-fA-F]+)["']/.exec(String(html))?.[1])
  const list = (Array.isArray(data) ? data : [])
    .map((p) => (typeof p === 'string' ? { url: p, alt: null } : { url: p?.src || p?.fallback, alt: p?.src && p?.fallback ? p.fallback : null }))
    .filter((p) => /^https?:\/\//i.test(p.url || ''))
  return list.length ? list : pagesFromHtml(html, base).map((url) => ({ url, alt: null }))
}

/** Respaldo: <img> servidos por su proxy «thumb.php?…&u=<URL real>» (la URL real, a resolución completa) o los <script> en línea. */
function pagesFromHtml(html, base) {
  const out = []
  const seen = new Set()
  const push = (u) => { if (u && /\/mangas\/\d+\//i.test(u) && !seen.has(u)) { seen.add(u); out.push(u) } }
  const fromThumb = (raw) => {
    if (!raw || !raw.includes('thumb.php')) return null
    try { const u = new URL(h.unent(raw), base).searchParams.get('u'); return u && u.startsWith('http') ? u : null } catch { return null }
  }
  for (const tag of String(html).match(/<img\b[^>]*>/gi) || []) {
    for (const a of ['src', 'data-src', 'data-lazy-src', 'data-lazy', 'data-original', 'data-url']) {
      const real = fromThumb(h.attr(tag, a))
      if (real) { push(real); break }
    }
  }
  if (!out.length) {
    for (const s of String(html).match(/<script\b(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/gi) || []) {
      if (!s.includes('thumb.php') && !s.includes('cloudfront.net')) continue
      for (const m of s.matchAll(/thumb\.php\/[^"'\s\\]*?[?&]u=([^"'&\s\\]+)/g)) { try { push(decodeURIComponent(m[1])) } catch { /* se ignora */ } }
      for (const m of s.matchAll(/https?:\/\/[^"'\s\\]*cloudfront\.net\/mangas\/\d+\/[^"'\s\\]+\.(?:webp|jpe?g|png)/g)) push(m[0])
    }
  }
  return out
}

/** Capítulos de la obra: el JSON incrustado (const _hex = "5b7b…") o, si no está, los enlaces /lector/<id>/<nombre>. */
function parseChapters(html, base = BASE) {
  const fromData = chaptersFromData(html, base)
  return fromData.length ? fromData : chaptersFromLinks(html, base)
}

function chaptersFromData(html, base) {
  const data = h.hexJson(/const\s+_hex\s*=\s*["']([0-9a-fA-F]+)["']/.exec(String(html))?.[1])
  if (!Array.isArray(data)) return []
  const out = []
  const seen = new Set()
  const push = (c) => {
    if (!c || typeof c.url !== 'string') return
    const url = h.absolute(c.url, base)
    if (!/\/lector\/\d+\//.test(url) || seen.has(url)) return
    seen.add(url)
    const n = Number(String(c.numero ?? '').replace(',', '.'))
    const names = Array.isArray(c.grupos_list) && c.grupos_list.length ? c.grupos_list.map((g) => g.nombre).filter(Boolean).join(' + ') : String(c.grupo_cap_nombres || '')
    out.push({
      number: Number.isFinite(n) ? n : null,
      label: String(c.titulo_str || c.titulo || (Number.isFinite(n) ? `Capítulo ${n}` : '')).slice(0, 120),
      group: names,
      date: String(c.fecha_subida || '').slice(0, 10),
      url,
    })
  }
  for (const c of data) { push(c); for (const v of Array.isArray(c?.otras_versiones) ? c.otras_versiones : []) push({ numero: c.numero, titulo_str: c.titulo_str, ...v }) }
  return out
}

function chaptersFromLinks(html, base) {
  const out = []
  const seen = new Set()
  const re = /<a\b([^>]*?)href=["']([^"']*\/lector\/\d+\/[^"'#?]+)[^"']*["']([^>]*)>([\s\S]*?)<\/a>/gi
  let m
  let prevEnd = 0
  while ((m = re.exec(html))) {
    const start = m.index
    const ctxStart = Math.max(prevEnd, start - 400)
    prevEnd = re.lastIndex
    const url = h.absolute(m[2], base)
    if (seen.has(url)) continue
    seen.add(url)
    const text = h.stripTags(m[4])
    const slug = decodeURIComponent(url.split('/').filter(Boolean).pop() || '')
    const titleAttr = /\b(?:title|aria-label)=["']([^"']*)["']/i.exec(m[1] + m[3])?.[1] || ''
    // Si el enlace solo dice «Leer», el número suele estar en la fila, justo antes del enlace.
    const before = h.stripTags(html.slice(ctxStart, start))
    const ctx = [...before.matchAll(new RegExp(h.NUM_RE.source, 'gi'))].pop()
    const num = h.NUM_RE.exec(text) || h.NUM_RE.exec(slug.replace(/-/g, ' ')) || h.NUM_RE.exec(titleAttr) || ctx || /(\d+(?:\.\d+)?)/.exec(text)
    out.push({ number: num ? Number((num[1] || num[0]).replace(',', '.')) : null, label: text || slug, group: '', date: h.dateIn(text) || h.dateIn(before), url })
  }
  return out
}

async function list(src, o) {
  let html = await getText(src.url, o)
  let chapters = parseChapters(html)
  if (!chapters.length) {
    html = await quiet(renderPage(src.url, { waitFor: '/lector/\\d+/', timeout: 40e3 }))
    chapters = parseChapters(html)
  }
  return { title: h.pageTitle(html, 'ONF Mangas'), chapters }
}

async function pages(chapter, o) {
  let list = parsePages(await getText(chapter.url, o))
  if (!list.length) list = parsePages(await quiet(renderPage(chapter.url, { waitFor: '/mangas/\\d+/', timeout: 40e3 })))
  return { urls: list.map((p) => p.url), alts: list.map((p) => p.alt) }
}

module.exports = { id: 'onf', name: 'ONF Mangas', headers: () => HEADERS, match, list, pages, parsePages, parseChapters }
