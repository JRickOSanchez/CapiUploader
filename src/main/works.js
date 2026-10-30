/**
 * Crear obras nuevas en el scan con la API (permiso works:write): catálogo de tipos, demografías y
 * géneros, búsqueda de obras base y autores, portada y banner, y la ficha. La obra nace privada;
 * si se pide, se publica al final. Sin dependencias de Electron, para poder probarlo.
 */
const api = require('./api')
const { sniff } = require('./images')

const LANGS = ['es', 'en', 'pt']
const STATUSES = ['ongoing', 'completed', 'hiatus', 'cancelled']
// Medidas exactas que acepta Capibara (la interfaz recorta y escala la imagen a la primera).
const IMAGE_RULES = {
  cover: { sizes: [[1200, 1800], [2400, 3600]], maxBytes: 3 * 1024 * 1024 },
  banner: { sizes: [[2300, 650], [4600, 1300]], maxBytes: 4 * 1024 * 1024 },
}

const fail = (message) => Object.assign(new Error(message), { code: 'invalid' })
const text = (v, max) => {
  const s = typeof v === 'string' ? v.trim() : ''
  return s ? s.slice(0, max) : ''
}
const ids = (list, max) => [...new Set((Array.isArray(list) ? list : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, max)

async function catalog(key) {
  return (await api.request(key, 'GET', '/catalog')).data
}

async function searchBase(key, q) {
  const s = String(q || '').trim()
  if (s.length < 2) return []
  return (await api.request(key, 'GET', `/catalog/works?q=${encodeURIComponent(s.slice(0, 120))}`)).data || []
}

async function searchAuthors(key, q) {
  const s = String(q || '').trim()
  if (s.length < 2) return []
  return (await api.request(key, 'GET', `/catalog/authors?q=${encodeURIComponent(s.slice(0, 120))}`)).data || []
}

/** Ancho y alto de un JPEG, PNG o WEBP (sin decodificarlo), o null. */
function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return [buf.readUInt32BE(16), buf.readUInt32BE(20)]
  if (buf.length > 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const kind = buf.toString('latin1', 12, 16)
    if (kind === 'VP8X') return [1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3)]
    if (kind === 'VP8 ') return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff]
    if (kind === 'VP8L') { const b = buf.readUInt32LE(21); return [1 + (b & 0x3fff), 1 + ((b >> 14) & 0x3fff)] }
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue }
      const marker = buf[i + 1]
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)]
      i += 2 + buf.readUInt16BE(i + 2)
    }
  }
  return null
}

// Formatos que el recorte de la interfaz puede entregar (JPG) o que se suben tal cual.
const UPLOAD_TYPES = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }

/** Revisa una portada o banner ya recortado por la interfaz. */
function checkImage(kind, bytes) {
  const rule = IMAGE_RULES[kind]
  const buf = Buffer.from(bytes)
  const type = UPLOAD_TYPES[sniff(buf)]
  const label = kind === 'cover' ? 'La portada' : 'El banner'
  if (!type) throw fail(`${label} no es una imagen JPG, PNG o WEBP.`)
  const size = imageSize(buf)
  if (!size || !rule.sizes.some(([w, h]) => w === size[0] && h === size[1])) {
    throw fail(`${label} debe medir ${rule.sizes.map(([w, h]) => `${w}×${h}`).join(' o ')} (mide ${size ? size.join('×') : '¿?'}).`)
  }
  if (buf.length > rule.maxBytes) throw fail(`${label} pesa más de ${rule.maxBytes / 1024 / 1024} MB.`)
  return { buf, type }
}

/** Valida y arma el cuerpo de POST /works (lanza un error claro si falta algo). */
function workBody(input, imageKeys = {}) {
  const title = text(input.title, 256)
  if (!title) throw fail('Escribe el título de la obra.')
  const language = LANGS.includes(input.language) ? input.language : null
  if (!language) throw fail('Elige el idioma de la obra.')
  const body = { title, language }
  const baseId = Number(input.baseId)
  if (Number.isInteger(baseId) && baseId > 0) {
    body.baseId = baseId
  } else {
    const type = text(input.type, 40)
    if (!type) throw fail('Elige el tipo de obra.')
    const demographyId = Number(input.demographyId)
    if (!Number.isInteger(demographyId) || demographyId < 1) throw fail('Elige la demografía.')
    const authorIds = ids(input.authorIds, 10)
    if (!authorIds.length) throw fail('Agrega al menos un autor.')
    body.base = { type, demographyId, authorIds }
  }
  if (STATUSES.includes(input.status)) body.status = input.status
  const genreIds = ids(input.genreIds, 30)
  if (genreIds.length) body.genreIds = genreIds
  const alt = text(input.alternativeTitle, 256)
  if (alt) body.alternativeTitle = alt
  const short = text(input.shortDescription, 300)
  if (short) body.shortDescription = short
  const description = text(input.description, 20000)
  if (description) body.description = description
  if (input.isNSFW) body.isNSFW = true
  if (imageKeys.cover) body.cover = imageKeys.cover
  if (imageKeys.banner) body.banner = imageKeys.banner
  return body
}

async function uploadImage(key, kind, { buf, type }) {
  const form = new FormData()
  form.append('kind', kind)
  form.append('file', new Blob([buf], { type }), `${kind}.${type.split('/')[1]}`)
  return (await api.request(key, 'POST', '/works/images', form)).data.key
}

/**
 * Crea la obra. input: los campos de la ficha, cover/banner (bytes ya recortados) y publish/notify.
 * Devuelve { work, published, warning }: si la obra se creó pero no se pudo publicar, warning lo dice.
 */
async function create(key, input) {
  workBody(input) // valida antes de subir imágenes
  const images = {}
  for (const kind of ['cover', 'banner']) if (input[kind]) images[kind] = checkImage(kind, input[kind])
  const keys = {}
  for (const [kind, img] of Object.entries(images)) keys[kind] = await uploadImage(key, kind, img)
  const work = (await api.request(key, 'POST', '/works', workBody(input, keys))).data
  if (!input.publish) return { work, published: false, warning: null }
  try {
    const res = await api.request(key, 'POST', `/works/${work.id}/publish`, { notify: input.notify !== false })
    return { work: res.data && typeof res.data === 'object' && res.data.id ? res.data : { ...work, isPublic: true }, published: true, warning: null }
  } catch (err) {
    return { work, published: false, warning: `La obra se creó privada, pero no se pudo publicar: ${err.message}` }
  }
}

module.exports = { catalog, searchBase, searchAuthors, create, workBody, checkImage, imageSize, IMAGE_RULES }
