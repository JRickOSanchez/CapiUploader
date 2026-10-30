/** ShadeManga: la web se arma con JavaScript, pero tiene una API JSON pública por serie. */
const h = require('../html')
const { getText, getJson, quiet } = require('../http')

const API = 'https://shademanga.com/api/series-locales'
const HEADERS = { Referer: 'https://shademanga.com/', Origin: 'https://shademanga.com' }

function match(u, host, parts) {
  if (!h.hostIs(host, 'shademanga.com')) return null
  if (parts[0] === 'reader') return { error: 'Esa es la URL de un capítulo; pega la de la obra (https://shademanga.com/serie/…).' }
  const i = parts[0] === 'serie' ? (parts[1] === 'local' ? 2 : 1) : -1
  if (i < 0 || !parts[i]) return { error: 'La URL de ShadeManga debe ser la de la obra (https://shademanga.com/serie/…).' }
  return { rawId: parts[i], groupId: u.searchParams.get('grupoScanId') || null }
}

/** Id numérico de la serie, a partir de la URL (si es numérico) o del HTML (variables serieId/mangaId). */
function serieId(rawIdOrNull, html = '') {
  if (rawIdOrNull && /^\d+$/.test(rawIdOrNull)) return rawIdOrNull
  return /["']?(?:serieId|mangaId)["']?\s*[=:]\s*["']?(\d+)/.exec(html)?.[1] || null
}

function parsePages(body) {
  const arr = Array.isArray(body) ? body : body?.paginas
  if (!Array.isArray(arr)) return []
  return arr.map((p) => (typeof p === 'string' ? p : p?.url || p?.src || p?.imageUrl || p?.imagen || '')).filter((u) => /^https?:\/\//i.test(u))
}

function parseChapters(body, id) {
  const arr = Array.isArray(body) ? body : body?.capitulos
  if (!Array.isArray(arr)) return []
  const out = []
  for (const c of arr) {
    if (!c?.publicId) continue
    const n = Number(String(c.numeroCapitulo ?? '').replace(',', '.'))
    const group = c.grupoScan?.nombre || c.grupoScan?.name || c.scan?.nombre || c.grupo || ''
    out.push({
      number: Number.isFinite(n) ? n : null,
      label: c.titulo || c.nombre || `Capítulo ${c.numeroCapitulo ?? ''}`.trim(),
      group: typeof group === 'string' ? group : '',
      date: String(c.fechaPublicacion || c.createdAt || c.fecha || '').slice(0, 10),
      url: `https://shademanga.com/reader/${c.publicId}?serie=${id}`,
      publicId: c.publicId,
      serieId: id,
    })
  }
  return out
}

async function list(src, o) {
  const id = serieId(src.rawId) || serieId(null, await quiet(getText(src.url, o)))
  if (!id) throw new Error('No pude saber el número de serie de esa obra de ShadeManga (la web lo carga con JavaScript).')
  const [info, body] = await Promise.all([
    getJson(`${API}/${id}`, o).catch(() => null),
    getJson(`${API}/${id}/capitulos${src.groupId ? `?grupoScanId=${encodeURIComponent(src.groupId)}` : ''}`, o),
  ])
  return { title: typeof info?.titulo === 'string' ? info.titulo : '', chapters: parseChapters(body, id) }
}

async function pages(chapter, o) {
  return { urls: parsePages(await getJson(`${API}/${chapter.serieId}/capitulos/${chapter.publicId}/paginas`, o)) }
}

module.exports = { id: 'shade', name: 'ShadeManga', headers: () => HEADERS, match, list, pages, serieId, parsePages, parseChapters }
