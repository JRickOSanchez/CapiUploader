/** Enchilada Scan (GitHub Pages): cada capítulo lista sus páginas en un images.json, a menudo en Google Drive. */
const h = require('../html')
const { getText, getJson, quiet } = require('../http')

const BASE = 'https://enchiladascan.github.io'
const HEADERS = { Referer: `${BASE}/` }
const UI_PARTS = ['assets/img/icons', 'assets/img/header', 'assets/img/rs', 'foco', 'patreon', 'ko-fi', 'facebook', 'discord', 'whatsapp', 'tmoh', 'cover.jpg', 'cover.png', 'cover.webp', '-cover', 'welcome', 'header_home']

const isUi = (u) => UI_PARTS.some((w) => u.toLowerCase().includes(w))
const isDrive = (u) => /^https:\/\/(?:drive\.google\.com\/(?:thumbnail|uc)|drive\.usercontent\.google\.com\/(?:uc|download)|lh\d+\.googleusercontent\.com)/.test(u)

function match(u, host, parts) {
  if (!h.hostIs(host, 'enchiladascan.github.io')) return null
  const i = parts.indexOf('enchiladaweb')
  if (i < 0 || !parts[i + 1]) return { error: 'La URL de Enchilada debe ser la de la obra (…/enchiladaweb/<obra>/inicio).' }
  if (/^cap\d/i.test(parts[i + 2] || '')) return { error: 'Esa es la URL de un capítulo; pega la de la obra (…/enchiladaweb/<obra>/inicio).' }
  return { manga: parts[i + 1] }
}

/** Dirección del images.json de un capítulo: la que dice su página (const RAW = '…') o la habitual. */
function jsonUrl(html, manga, cap) {
  const raw = /const\s+RAW\s*=\s*\(?['"`]([^'"`]+\.json)['"`]/.exec(html || '')?.[1]?.trim()
  if (raw) return /^https?:\/\//i.test(raw) ? raw : `${BASE}/enchiladaweb/${raw.replace(/^\//, '')}`
  return `${BASE}/enchiladaweb/assets/mangas/${manga}/${cap}/images.json`
}

function normalize(u) {
  if (!u || typeof u !== 'string') return ''
  u = u.trim()
  if (u.startsWith('http')) return u
  if (u.startsWith('//')) return `https:${u}`
  if (u.startsWith('/')) return BASE + u
  return `${BASE}/enchiladaweb/${u}`
}

/** URLs de páginas del images.json (lista de textos u objetos con src/url/image). */
function parsePages(body) {
  const arr = Array.isArray(body) ? body : body?.pages || body?.images || body?.imgs || body?.paginas
  if (!Array.isArray(arr)) return []
  return arr
    .map((i) => normalize(typeof i === 'string' ? i : i?.src || i?.url || i?.image || ''))
    .filter((u) => u && (isDrive(u) || h.isPageImage(u)) && !isUi(u))
}

function parseChapters(html, base, manga) {
  const out = []
  const seen = new Set()
  const re = /<a\b[^>]*href=["']([^"']*\/enchiladaweb\/[^"'/]+\/cap\d+(?:-\d+)?)\/?["'][^>]*>([\s\S]*?)<\/a>/gi
  let m
  while ((m = re.exec(html))) {
    const url = h.absolute(m[1], base)
    if (!url || seen.has(url) || (manga && !url.includes(`/enchiladaweb/${manga}/`))) continue
    seen.add(url)
    const c = /\/cap(\d+)(?:-(\d+))?$/i.exec(url)
    const number = c ? Number(c[2] ? `${c[1]}.${c[2]}` : c[1]) : null
    const text = h.stripTags(m[2])
    out.push({ number, label: text && !/^cap/i.test(text) ? text : `Capítulo ${number ?? ''}`, group: '', date: h.dateIn(text), url, manga, cap: url.split('/').pop() })
  }
  return out
}

async function list(src, o) {
  const html = await getText(src.url, o)
  return { title: h.pageTitle(html, 'Enchilada Scan'), chapters: parseChapters(html, src.url, src.manga) }
}

async function pages(chapter, o) {
  const html = await quiet(getText(chapter.url, o))
  return { urls: parsePages(await getJson(jsonUrl(html, chapter.manga, chapter.cap), o).catch(() => null)) }
}

module.exports = { id: 'enchilada', name: 'Enchilada Scan', headers: () => HEADERS, match, list, pages, jsonUrl, parsePages, parseChapters }
