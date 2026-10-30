/**
 * MangaDex, con su API pública. Pide que los programas se identifiquen: con el User-Agent de un
 * navegador, sus servidores de imágenes responden 404.
 */
const h = require('../html')
const { getJson } = require('../http')

const API = 'https://api.mangadex.org'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HONEST_UA = 'CapiUploader (importar capítulos de tu scan)'
const FEED_PAGE = 500
const FEED_MAX = 10000
// Idioma de MangaDex → el de los filtros de «Importar de web» (los mismos que usa el motor de HaruNeko).
const LANG = { es: 'spanish', 'es-la': 'spanish', en: 'english', 'pt-br': 'portuguese', pt: 'portuguese', fr: 'french', it: 'italian', de: 'german', ru: 'russian', ja: 'japanese', ko: 'korean', zh: 'chinese', 'zh-hk': 'chinese', id: 'indonesian', vi: 'vietnamese', th: 'thai', tr: 'turkish', ar: 'arabic', pl: 'polish' }

/** ¿La imagen está en MangaDex? (otras webs, como ONF, también sirven imágenes de ahí). */
const isOwnHost = (url) => { try { return /(^|\.)mangadex\.(org|network)$/.test(new URL(url).hostname) } catch { return false } }

function match(u, host, parts) {
  if (!h.hostIs(host, 'mangadex.org')) return null
  if (parts[0] === 'chapter') return { error: 'Esa es la URL de un capítulo; pega la de la obra (https://mangadex.org/title/<id>).' }
  if (parts[0] !== 'title' || !UUID.test(parts[1] || '')) return { error: 'La URL de MangaDex debe ser la de la obra (https://mangadex.org/title/<id>/<nombre>).' }
  return { id: parts[1] }
}

/** Páginas (calidad original) de la respuesta de /at-home/server/<id>. */
function parsePages(body) {
  if (!body || body.result !== 'ok' || !body.chapter) return []
  const files = body.chapter.data
  if (!body.baseUrl || !body.chapter.hash || !Array.isArray(files)) return []
  return files.map((f) => `${String(body.baseUrl).replace(/\/$/, '')}/data/${body.chapter.hash}/${f}`)
}

/** Capítulos de una página del feed de la obra (sin los alojados en otra web ni los vacíos). */
function parseChapters(body) {
  const out = []
  for (const c of body?.data || []) {
    const a = c.attributes || {}
    if (a.externalUrl || a.pages === 0) continue
    const groups = (c.relationships || []).filter((r) => r.type === 'scanlation_group').map((r) => r.attributes?.name).filter(Boolean)
    const n = Number(String(a.chapter ?? '').replace(',', '.'))
    const lang = String(a.translatedLanguage || '').toLowerCase()
    out.push({
      number: a.chapter != null && Number.isFinite(n) ? n : null,
      volume: a.volume != null && Number.isFinite(Number(a.volume)) ? Number(a.volume) : null,
      label: [a.chapter != null ? `Capítulo ${a.chapter}` : 'Oneshot', a.title].filter(Boolean).join(' - '),
      group: groups.join(' + '),
      date: String(a.publishAt || a.readableAt || '').slice(0, 10),
      languages: lang ? [LANG[lang] || lang] : [],
      url: `https://mangadex.org/chapter/${c.id}`,
    })
  }
  return out
}

/** Dirección de una página del feed de la obra. */
function feedUrl(id, offset) {
  const q = [`limit=${FEED_PAGE}`, `offset=${offset}`, 'order[chapter]=asc', 'includes[]=scanlation_group', 'contentRating[]=safe', 'contentRating[]=suggestive', 'contentRating[]=erotica', 'contentRating[]=pornographic']
  return `${API}/manga/${id}/feed?${q.join('&')}`
}

/** Título de la obra (/manga/<id>): el español si lo hay, si no el principal. */
function parseTitle(body) {
  const a = body?.data?.attributes || {}
  const es = (a.altTitles || []).map((t) => t['es-la'] || t.es).find(Boolean)
  return es || a.title?.en || Object.values(a.title || {})[0] || ''
}

async function list(src, o) {
  const title = parseTitle(await getJson(`${API}/manga/${src.id}`, o))
  const chapters = []
  for (let offset = 0; offset < FEED_MAX; offset += FEED_PAGE) {
    const body = await getJson(feedUrl(src.id, offset), o)
    chapters.push(...parseChapters(body))
    if (!body?.data || body.data.length < FEED_PAGE) break
  }
  return { title, chapters }
}

async function pages(chapter, o) {
  const id = new URL(chapter.url).pathname.split('/').filter(Boolean)[1]
  return { urls: parsePages(await getJson(`${API}/at-home/server/${id}`, o)) }
}

module.exports = {
  id: 'mangadex', name: 'MangaDex', headers: () => ({ 'User-Agent': HONEST_UA }), match, list, pages,
  HONEST_UA, isOwnHost, parsePages, parseChapters, parseTitle,
}
