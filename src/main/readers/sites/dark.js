/** Dark Gathering (WordPress con «wp-manga»): la portada del sitio es la página de la obra. */
const h = require('../html')
const { getText } = require('../http')

const HEADERS = { Referer: 'https://readdarkgathering.com/' }
const LAZY_ATTRS = ['data-src', 'data-lazy-src', 'data-lazy', 'data-original', 'data-url', 'src']

function match(u, host, parts) {
  if (!h.hostIs(host, 'readdarkgathering.com')) return null
  if (/-chapter-\d/i.test(parts[1] || '')) return { error: 'Esa es la URL de un capítulo; pega la de la página principal de la obra.' }
  return {}
}

function parsePages(html, base) {
  const out = []
  const seen = new Set()
  const take = (tag) => LAZY_ATTRS.map((a) => h.attr(tag, a)).find((v) => v && !v.startsWith('data:')) || ''
  const add = (u) => { if (u && !seen.has(u)) { seen.add(u); out.push(u) } }
  const tags = String(html).match(/<img\b[^>]*>/gi) || []
  for (const t of tags.filter((x) => /wp-manga-chapter-img/.test(h.attr(x, 'class') || ''))) add(h.absolute(take(t), base))
  if (out.length) return h.naturalSortUrls(out)
  // Respaldo: cualquier imagen que parezca una página.
  for (const t of tags) {
    const u = h.absolute(take(t), base)
    if (h.isPageImage(u) && !u.toLowerCase().includes('arrow.png')) add(u)
  }
  return out
}

function parseChapters(html, base) {
  const out = []
  const seen = new Set()
  const re = /<a\b[^>]*href=["']([^"']*\/manga\/[a-z0-9-]+-chapter-\d+(?:\.\d+)?)\/?["'][^>]*>([\s\S]*?)<\/a>/gi
  let m
  while ((m = re.exec(html))) {
    const url = h.absolute(m[1] + '/', base)
    if (!url || seen.has(url)) continue
    seen.add(url)
    const text = h.stripTags(m[2])
    const n = /-chapter-(\d+(?:\.\d+)?)\/?$/i.exec(url)
    out.push({ number: n ? Number(n[1]) : null, label: text || `Chapter ${n?.[1] ?? ''}`, group: '', date: h.dateIn(text), url })
  }
  return out
}

async function list(src, o) {
  const html = await getText(src.url, o)
  return { title: h.pageTitle(html, 'Dark Gathering'), chapters: parseChapters(html, src.url) }
}

async function pages(chapter, o) {
  return { urls: parsePages(await getText(chapter.url, o), chapter.url) }
}

module.exports = { id: 'dark', name: 'Dark Gathering', headers: () => HEADERS, match, list, pages, parsePages, parseChapters }
