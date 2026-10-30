/**
 * MangaTV (tema MangaStream). Su lector actual cifra la lista de páginas y mete páginas señuelo que
 * no existen; el anterior la daba en `ts_reader.run({...})`.
 */
const crypto = require('node:crypto')
const h = require('../html')
const { getText } = require('../http')

const HEADERS = { Referer: 'https://mangatv.net/' }

function match(u, host, parts) {
  if (!h.hostIs(host, 'mangatv.net')) return null
  if (parts[0] === 'leer') return { error: 'Esa es la URL de un capítulo; pega la de la obra (https://mangatv.net/manga/…).' }
  if (parts[0] !== 'manga' || parts.length < 2) return { error: 'La URL de MangaTV debe ser la de la obra (https://mangatv.net/manga/…).' }
  return {}
}

/**
 * Lista cifrada: ReaderBlob.start({ k, iv, c }) dentro de un script empaquetado; k es una clave
 * AES-256, iv el nonce y c el texto cifrado con GCM (etiqueta al final). Dentro:
 * { p: [URLs], s: [posiciones de páginas señuelo] }.
 */
function decryptPages(html) {
  const code = h.unpackJs(html) || String(html || '')
  const m = /ReaderBlob\.start\(\s*(\{[\s\S]*?\})\s*\)/.exec(code)
  if (!m) return null
  try {
    const { k, iv, c } = JSON.parse(m[1])
    const data = Buffer.from(c, 'base64')
    const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(k, 'base64'), Buffer.from(iv, 'base64'))
    d.setAuthTag(data.subarray(data.length - 16))
    const out = JSON.parse(Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]).toString('utf8'))
    const list = Array.isArray(out) ? out : out?.p || out?.images
    const decoys = new Set(Array.isArray(out?.s) ? out.s.map(Number) : [])
    return Array.isArray(list) ? list.filter((u, i) => typeof u === 'string' && !decoys.has(i)) : null
  } catch {
    return null
  }
}

/** Lector anterior: `ts_reader.run({ sources: [{ images }] })` o un `"images": [...]` suelto. */
function legacyPages(html) {
  const m = /ts_reader\.run\(\s*\{/.exec(html)
  if (m) {
    try {
      const data = JSON.parse(h.balancedJson(html, m.index + m[0].length - 1))
      const src = data.sources?.[0]?.images ?? data.images
      if (Array.isArray(src)) return src
    } catch { /* se prueba el respaldo */ }
  }
  const f = /"images"\s*:\s*(\[[^\]]*\])/.exec(html)
  if (f) { try { return JSON.parse(f[1]) } catch { /* nada */ } }
  return null
}

/** URLs de las páginas de un capítulo. */
function parsePages(html) {
  const images = decryptPages(html) || legacyPages(String(html || '')) || []
  return images.map((u) => (String(u).startsWith('//') ? 'https:' : '') + u)
}

/**
 * Capítulos de la página de la obra. Cada fila es un <li data-num="12.00"> con «Capítulo 12»,
 * «Título    Espejo | Scan», la fecha y el enlace /leer/<id>.
 */
function parseChapters(html, base = 'https://mangatv.net') {
  const rows = chapterRows(html, base)
  return rows.length ? rows : chapterLinks(html, base)
}

function chapterRows(html, base) {
  const out = []
  const seen = new Set()
  for (const li of String(html || '').split(/(?=<li\b[^>]*\bdata-num=)/).filter((p) => /^<li\b/i.test(p))) {
    const block = li.slice(0, li.indexOf('</li>') + 1 || undefined)
    const href = /href=["']([^"']*\/leer\/[0-9a-zA-Z]+)["']/.exec(block)?.[1]
    if (!href) continue
    const url = h.absolute(href, base)
    if (seen.has(url)) continue
    seen.add(url)
    const spans = [...block.matchAll(/<span\b[^>]*class=["']chapternum["'][^>]*>([\s\S]*?)<\/span>/gi)].map((m) => h.unent(m[1].replace(/<[^>]*>/g, ' ')))
    const n = Number(/data-num=["']([\d.]+)["']/.exec(block)?.[1])
    const number = Number.isFinite(n) ? n : h.chapterNumber(spans[0])
    // «El contenedor mundial de sangre      ZonaTMO | Karneval -Fansub-»: título, espejo y scan.
    const [left = '', ...right] = (spans[1] || '').split('|')
    const [name = '', mirror = ''] = left.split(/\s{3,}/).map((s) => s.trim())
    const scan = right.join('|').replace(/\s+/g, ' ').trim()
    out.push({
      number,
      label: `Capítulo ${number ?? '?'}${name ? ` - ${name.replace(/\s+/g, ' ')}` : ''}`,
      group: [scan, mirror && `vía ${mirror}`].filter(Boolean).join(' · '),
      date: h.dateIn(/class=["']chapterdate["'][^>]*>([^<]*)/.exec(block)?.[1]),
      url,
    })
  }
  return out
}

/** Respaldo: enlaces /leer/<id> dentro de un <li> con «Capítulo N … grupo … fecha». */
function chapterLinks(html, base) {
  const out = []
  const seen = new Set()
  const re = /<a\b[^>]*href=["']([^"']*\/leer\/[0-9a-zA-Z]+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let m
  while ((m = re.exec(html))) {
    const url = new URL(m[1], base).href
    if (seen.has(url)) continue
    seen.add(url)
    const start = html.lastIndexOf('<li', m.index)
    const end = html.indexOf('</li>', m.index)
    const block = start >= 0 && end > start && end - start < 2000 ? html.slice(start, end) : m[0]
    const text = h.stripTags(block)
    const own = h.stripTags(m[2])
    const num = h.NUM_RE.exec(own) || h.NUM_RE.exec(text)
    const date = h.dateIn(text)
    const clean = (g) => g.replace(date, '').replace(/^[\s\-–:·|]+|[\s\-–:·|]+$/g, '').trim()
    // El grupo es lo que acompaña al enlace; si el enlace envuelve toda la fila, lo que sigue al «Capítulo N».
    let group = own && text.includes(own) ? clean(text.replace(own, ' ')) : ''
    if (!group) group = clean(num ? text.slice(text.indexOf(num[0]) + num[0].length) : text)
    out.push({ number: num ? Number(num[1].replace(',', '.')) : null, label: own || text, group, date, url })
  }
  return out
}

async function list(src, o) {
  const html = await getText(src.url, o)
  return { title: h.pageTitle(html, 'MangaTV'), chapters: parseChapters(html, new URL(src.url).origin) }
}

async function pages(chapter, o) {
  return { urls: parsePages(await getText(chapter.url, o)) }
}

module.exports = { id: 'mangatv', name: 'MangaTV', headers: () => HEADERS, match, list, pages, parsePages, parseChapters }
