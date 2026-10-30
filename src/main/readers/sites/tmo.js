/**
 * ZonaTMO (cambia de dominio: zonatmo.net, zonatmo.org…). Se prueba en este orden:
 *   1. su API JSON (zonatmo.net, obras en …/manga/<obra>): rápida y con número, scan e idioma;
 *   2. el HTML ya armado (diseño actual de zonatmo.org, obras en …/library/<tipo>/<id>/<obra>);
 *   3. una ventana oculta para el diseño anterior, que se arma con JavaScript.
 */
const h = require('../html')
const { getText, getJson, quiet, renderPage } = require('../http')

const isHost = (host) => /^zonatmo\.[a-z]{2,}$/.test(host)
// Primer intento rápido: si no responde enseguida, se pasa a la ventana oculta.
const QUICK = { timeout: 12e3, tries: 1 }
// Las imágenes de la API están en este CDN, en /manga/<jit>/<imagen> (la API no dice el dominio).
const CDN = 'https://cdn.zonatmo.to'
const API_PAGES_MAX = 200
const LANG = { es: 'spanish', 'es-419': 'spanish', en: 'english', pt: 'portuguese', 'pt-br': 'portuguese' }

/** Referer y Origin con el dominio que se esté usando. */
function headers(url) {
  try {
    const origin = new URL(url).origin
    return { Referer: `${origin}/`, Origin: origin }
  } catch {
    return { Referer: 'https://zonatmo.net/', Origin: 'https://zonatmo.net' }
  }
}

function match(u, host, parts) {
  if (!isHost(host)) return null
  // …/library/<tipo>/<id>/<obra> (sitio actual) o …/manga/<obra> (el anterior)
  if (parts[0] === 'library' && parts.length >= 3) return {}
  const example = `https://${host}/library/<tipo>/<id>/<obra>`
  if (['view_uploads', 'viewer'].includes(parts[0]) || (parts[0] === 'manga' && parts.length > 2)) return { error: `Esa es la URL de un capítulo; pega la de la obra (${example}).` }
  if (parts[0] !== 'manga' || !parts[1]) return { error: `La URL de ZonaTMO debe ser la de la obra (${example}).` }
  return {}
}

/** Un <li class="upload-link" data-chapter-number="N"> por capítulo, con un enlace …/view_uploads/<id> por grupo. */
function parseChapters(html, base = 'https://zonatmo.org/') {
  const out = []
  const seen = new Set()
  for (const li of String(html || '').split(/(?=<li\b[^>]*\bupload-link\b)/).filter((p) => /^<li\b/i.test(p))) {
    const numAttr = /data-chapter-number="([^"]*)"/.exec(li)?.[1]
    const number = numAttr != null && numAttr !== '' && Number.isFinite(Number(numAttr)) ? Number(numAttr) : h.chapterNumber(/class="chapter-number[^>]*>([\s\S]*?)<\/span>/.exec(li)?.[1])
    const links = [...li.matchAll(/<a\b[^>]*href="([^"]*\/view_uploads\/\d+[^"]*)"/g)]
    links.forEach((m, i) => {
      const url = h.absolute(m[1], base)
      if (!url || seen.has(url)) return
      seen.add(url)
      const seg = li.slice(m.index, i + 1 < links.length ? links[i + 1].index : li.length)
      const group = h.stripTags(/<a\b[^>]*href="[^"]*\/groups\/[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/a>/.exec(seg)?.[1] || '')
      const d = /(\d{2})\/(\d{2})\/(\d{4})/.exec(seg)
      out.push({ number, label: number != null ? `Capítulo ${number}` : 'Capítulo', group, date: d ? `${d[3]}-${d[2]}-${d[1]}` : '', url })
    })
  }
  return out
}

/** Páginas del lector actual (…/view_uploads/<id>), en orden. */
function parsePages(html) {
  const text = String(html || '')
  const urls = []
  const add = (u) => { if (u && /^https:\/\//i.test(u) && !urls.includes(u)) urls.push(u) }
  const start = text.indexOf('id="reader-wrap"')
  for (const m of text.slice(start < 0 ? 0 : start).matchAll(/<img\b[^>]*\bclass="[^"]*reader-image[^"]*"[^>]*>|<img\b[^>]*\bsrc="https:\/\/[^"]*\/chapters\/\d+\/\d+\.(?:webp|jpe?g|png|avif)[^"]*"[^>]*>/gi)) {
    add(/\bsrc="([^"]+)"/.exec(m[0])?.[1] || /data-src="([^"]+)"/.exec(m[0])?.[1])
  }
  if (!urls.length) for (const m of text.matchAll(/<link\b[^>]*rel="preload"[^>]*as="image"[^>]*href="([^"]+)"/g)) add(m[1])
  return urls
}

/* ---------- API JSON (zonatmo.net) ---------- */

/** «…/manga/<obra>/…» → <obra>, o null (las obras de zonatmo.org no tienen API). */
function apiSlug(url) {
  const parts = new URL(url).pathname.split('/').filter(Boolean)
  return parts[0] === 'manga' && parts[1] ? parts[1] : null
}

/** GET a /wp-api/api de ZonaTMO: el `data` de la respuesta, o null si el sitio no la tiene. */
async function api(origin, path, o) {
  const headers = { ...o.headers, Accept: 'application/json', 'X-App': 'manga-reader' }
  const body = await getJson(`${origin}/wp-api/api${path}`, { ...o, headers, tries: 2 }).catch(() => null)
  return body && !body.error ? body.data ?? null : null
}

/** Capítulos de una página de la API (data.items). */
function parseApiChapters(items, origin, slug) {
  const out = []
  for (const c of Array.isArray(items) ? items : []) {
    if (!c?.slug) continue
    const n = Number(String(c.chapter_number ?? '').replace(',', '.'))
    const number = Number.isFinite(n) ? n : h.chapterNumber(c.title, c.slug)
    const lang = String(c.language || '').toLowerCase()
    out.push({
      number,
      label: number != null ? `Capítulo ${number}` : String(c.title || 'Capítulo'),
      group: c.group?.name || '',
      date: String(c.release_date || '').slice(0, 10),
      languages: lang ? [LANG[lang] || lang] : [],
      url: `${origin}/manga/${slug}/${c.slug}/`,
      api: { slug, chapter: c.slug },
    })
  }
  return out
}

/** Páginas de un capítulo (data.chapter.images, con su jit) en orden. */
function parseApiPages(data) {
  const ch = data?.chapter || data
  const jit = ch?.jit || ''
  return [...(Array.isArray(ch?.images) ? ch.images : [])]
    .sort((a, b) => (Number(a?.page_number) || 0) - (Number(b?.page_number) || 0))
    .map((im) => (typeof im === 'string' ? im : im?.image_url))
    .filter(Boolean)
    .map((u) => (/^https?:\/\//i.test(u) ? u : jit ? `${CDN}/manga/${jit}/${String(u).replace(/^\//, '')}` : null))
    .filter(Boolean)
}

/** Obra completa por la API (pagina hasta el final). null si el sitio no la tiene. */
async function listApi(src, o) {
  const slug = apiSlug(src.url)
  if (!slug) return null
  const origin = new URL(src.url).origin
  const path = `/single/manga/${encodeURIComponent(slug)}`
  const first = await api(origin, `${path}/chapters?page=1&postsPerPage=50&order=desc`, o)
  if (!first?.items?.length) return null
  const chapters = parseApiChapters(first.items, origin, slug)
  const last = Math.min(Number(first.pagination?.total_pages) || 1, API_PAGES_MAX)
  for (let page = 2; page <= last; page++) {
    const data = await api(origin, `${path}/chapters?page=${page}&postsPerPage=50&order=desc`, o)
    if (!data?.items?.length) break
    chapters.push(...parseApiChapters(data.items, origin, slug))
  }
  const info = await api(origin, path, o)
  return { title: typeof info?.title === 'string' ? info.title : '', chapters }
}

/* ---------- Diseño anterior, en la ventana oculta ---------- */

/**
 * Despliega cada capítulo y devuelve JSON con una fila por capítulo y una versión por grupo; `done`
 * indica que ya se leyó todo. Corre dentro de la página: no puede usar nada de este archivo.
 */
const LIST_SCRIPT = '(' + (() => {
  const q = (sel, root = document) => [...root.querySelectorAll(sel)]
  const title = ((document.querySelector('h1') || {}).textContent || document.title || '').replace(/\s+/g, ' ').trim()
  const lis = q('li.upload-link')
  if (lis.length) {
    const rows = lis.map((li) => ({
      title: `Capítulo ${li.getAttribute('data-chapter-number') || ''}`.trim(),
      versions: q('a[href*="/view_uploads/"]', li).map((a) => ({
        href: a.href,
        group: ((li.querySelector('a[href*="/groups/"]') || {}).textContent || '').replace(/\s+/g, ' ').trim(),
        date: (/(\d{2})\/(\d{2})\/(\d{4})/.exec(li.textContent) || []).slice(1).reverse().join('-'),
        lang: '',
      })),
    }))
    return JSON.stringify({ done: true, title, rows })
  }
  const more = q('button').filter((b) => !b.disabled && /^(cargar|ver|mostrar)\s+m[aá]s/i.test(b.textContent.trim()))
  more.forEach((b) => b.click())
  const btns = q('button[aria-controls^="collapsible-"]')
  let pending = 0
  for (const b of btns) if (b.getAttribute('aria-expanded') !== 'true') { b.click(); pending++ }
  let versionsTotal = 0
  let allHave = true
  const rows = btns.map((b) => {
    const panel = document.getElementById(b.getAttribute('aria-controls'))
    const rowTitle = (b.querySelector('span.truncate') || b).textContent.replace(/\s+/g, ' ').trim()
    const versions = panel ? q('li', panel).map((li) => {
      const read = li.querySelector('a[title="Leer capítulo"], a[aria-label="Leer capítulo"]')
      const g = li.querySelector('a[href*="/groups/"]')
      return {
        href: read ? read.href : '',
        group: g ? (g.getAttribute('title') || g.textContent).trim() : '',
        date: (/\d{4}-\d{2}-\d{2}/.exec(li.textContent) || [''])[0],
        lang: (li.querySelector('svg[aria-label]') || { getAttribute: () => '' }).getAttribute('aria-label') || '',
      }
    }).filter((v) => v.href) : []
    versionsTotal += versions.length
    if (!versions.length) allHave = false
    return { title: rowTitle, versions }
  })
  const stable = !pending && versionsTotal === window.__tmoV ? (window.__tmoStable = (window.__tmoStable || 0) + 1) : (window.__tmoStable = 0)
  window.__tmoV = versionsTotal
  const done = btns.length > 0 && !pending && !more.length && (allHave || stable >= 3)
  return JSON.stringify({ done, title, rows })
}).toString() + ')()'

/** Capítulos a partir del JSON de LIST_SCRIPT → { title, chapters }. */
function parseListScript(text, base = 'https://zonatmo.net/') {
  let data
  try { data = JSON.parse(text) } catch { return { title: '', chapters: [] } }
  const out = []
  const seen = new Set()
  for (const row of Array.isArray(data?.rows) ? data.rows : []) {
    const number = h.chapterNumber(row.title)
    for (const v of row.versions || []) {
      const url = h.absolute(v.href, base)
      if (!url || seen.has(`${url}|${v.group}`)) continue
      seen.add(`${url}|${v.group}`)
      const foreign = v.lang && !/^espa[nñ]ol/i.test(v.lang)
      out.push({
        number,
        label: number != null ? `Capítulo ${number}` : String(row.title || '').slice(0, 80),
        group: (v.group || '') + (foreign ? ` (${v.lang})` : ''),
        date: v.date || '',
        url,
      })
    }
  }
  return { title: String(data?.title || ''), chapters: out }
}

/** Junta las páginas del lector anterior (<img …/page_0001.webp>). Corre dentro de la página. */
const PAGES_SCRIPT = '(' + (() => {
  window.scrollTo(0, document.body.scrollHeight)
  const urls = []
  for (const img of document.querySelectorAll('img')) {
    const s = img.currentSrc || img.src || (img.dataset && img.dataset.src) || ''
    const reader = img.classList.contains('reader-image') && /^https:/i.test(s)
    if ((reader || /\/page_\d+\.(?:webp|jpe?g|png|avif|gif)(?:\?|$)/i.test(s)) && !urls.includes(s)) urls.push(s)
  }
  const stable = urls.length && urls.length === window.__tmoN ? (window.__tmoS = (window.__tmoS || 0) + 1) : (window.__tmoS = 0)
  window.__tmoN = urls.length
  return JSON.stringify({ done: urls.length > 0 && stable >= 2, urls })
}).toString() + ')()'

function parsePagesScript(text) {
  let data
  try { data = JSON.parse(text) } catch { return [] }
  return (Array.isArray(data?.urls) ? data.urls : []).filter((u) => typeof u === 'string' && /^https:\/\//i.test(u))
}

async function list(src, o) {
  const viaApi = await listApi(src, o)
  if (viaApi) return viaApi
  const base = `${new URL(src.url).origin}/`
  const html = await quiet(getText(src.url, { ...o, ...QUICK }))
  let chapters = parseChapters(html, base)
  let title = h.pageTitle(html, 'ZonaTMO')
  if (!chapters.length) {
    const res = parseListScript(await quiet(renderPage(src.url, { script: LIST_SCRIPT, waitFor: '"done":true', timeout: 90e3 })), base)
    chapters = res.chapters
    title = title || h.pageTitle(`<title>${res.title}</title>`, 'ZonaTMO')
  }
  return { title, chapters }
}

async function pages(chapter, o) {
  if (chapter.api) {
    const origin = new URL(chapter.url).origin
    const urls = parseApiPages(await api(origin, `/single/manga/${encodeURIComponent(chapter.api.slug)}/${encodeURIComponent(chapter.api.chapter)}`, o))
    if (urls.length) return { urls }
  }
  let urls = parsePages(await quiet(getText(chapter.url, { ...o, ...QUICK })))
  if (!urls.length) urls = parsePagesScript(await quiet(renderPage(chapter.url, { script: PAGES_SCRIPT, waitFor: '"done":true', timeout: 60e3 })))
  return { urls }
}

module.exports = {
  id: 'tmo', name: 'ZonaTMO', headers, match, list, pages,
  parseChapters, parsePages, parseListScript, parsePagesScript, parseApiChapters, parseApiPages,
}
