/**
 * Capibara Traductor como web de origen (para pasar una obra de tu scan a Crimson o Mangation).
 * La web no entrega las imágenes reales (las protege), así que se leen con la API oficial y la
 * API key del scan dueño de la obra, igual que «Descargar». Solo funciona con obras de los scans
 * agregados en la app, y la key necesita el permiso chapters:write para ver las imágenes.
 * La key nunca sale del proceso principal: las filas que llegan a la ventana no la llevan.
 */
const h = require('../html')
// Perezosos: el resto de lectores (y sus pruebas) no necesitan la API ni las keys.
const api = () => require('../../api')
const store = () => require('../../store')

const HOST = 'capibaratraductor.com'

const finalError = (message, code) => Object.assign(new Error(message), { code, final: true })

function match(u, host, parts) {
  if (!h.hostIs(host, HOST)) return null
  const at = parts.indexOf('manga')
  if (at !== 1 || !parts[2]) return { error: 'La URL de Capibara debe ser la de la obra (https://capibaratraductor.com/<scan>/manga/<obra>).' }
  if (parts.length > 3) return { error: 'Esa es la URL de un capítulo; pega la de la obra (https://capibaratraductor.com/<scan>/manga/<obra>).' }
  return { org: parts[0].toLowerCase(), slug: parts[2].toLowerCase() }
}

/** Scan de la app dueño de la URL (por su slug o por la dirección de su página). */
function profileFor(org) {
  const orgOf = (p) => {
    if (p.slug) return String(p.slug).toLowerCase()
    try { return new URL(p.url).pathname.split('/').filter(Boolean)[0]?.toLowerCase() || '' } catch { return '' }
  }
  return store().listProfiles().find((p) => orgOf(p) === org) || null
}

function keyFor(org) {
  const profile = profileFor(org)
  const key = profile && store().getProfileKey(profile.id)
  if (!key) {
    throw finalError(`Esta obra es del scan «${org}». Capibara solo deja leer las páginas con la API key del scan dueño: agrega la key de ese scan en CapiUploader (con el permiso chapters:write) y vuelve a buscarla.`, 'import.capibara_not_mine')
  }
  return { key, profile }
}

const label = (c) => {
  const base = c.extra ? `Extra ${c.extraNumber ?? ''}`.trim() : `Capítulo ${c.displayNumber ?? c.number}`
  return c.title ? `${base} - ${c.title}` : base
}

async function list(src, { signal } = {}) {
  const { key, profile } = keyFor(src.org)
  const works = await api().requestAll(key, '/works?limit=50', signal)
  const path = `/${src.org}/manga/${src.slug}`
  const work = works.find((w) => { try { return new URL(w.url).pathname.toLowerCase() === path } catch { return false } }) ||
    works.find((w) => String(w.slug).toLowerCase() === src.slug)
  if (!work) throw finalError(`No encontré «${src.slug}» entre las obras de ${profile.name}. Revisa el enlace.`, 'import.capibara_no_work')
  const chapters = await api().requestAll(key, `/works/${Number(work.id)}/chapters?limit=100&order=desc`, signal)
  return {
    title: work.title,
    chapters: chapters.map((c) => ({
      // Los extras no tienen número de capítulo: se les escribe uno antes de importar.
      number: c.extra ? null : Number(c.number),
      volume: c.volumeNumber ?? null,
      label: label(c),
      group: '',
      date: String(c.releasedAt || c.publishAt || c.createdAt || '').slice(0, 10),
      url: c.url || `${src.url}#capitulo-${c.id}`,
      chapterId: c.id,
      org: src.org,
    })),
  }
}

async function pages(chapter, { signal } = {}) {
  const { key } = keyFor(chapter.org)
  const res = await api().request(key, 'GET', `/chapters/${Number(chapter.chapterId)}/pages`, null, signal)
  const list = [...(res.data?.pages || [])].sort((a, b) => a.number - b.number)
  if (list.length && list.every((p) => !p.imageUrl)) {
    throw finalError('La API key de este scan no puede ver las imágenes: necesita el permiso chapters:write.', 'api.scope_missing')
  }
  if (list.some((p) => !p.imageUrl)) throw new Error('La API no devolvió la dirección de alguna página.')
  return { urls: list.map((p) => p.imageUrl) }
}

module.exports = { id: 'capibara', name: 'Capibara Traductor', headers: () => ({}), match, list, pages }
