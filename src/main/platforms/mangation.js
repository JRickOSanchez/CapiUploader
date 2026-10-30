/**
 * Mangation (panel creator.mangation.com → api.mangation.com). Lo que usa la app:
 *   POST /api/auth/login {email,password} → {user} + cookie __Host-manga_session   GET /api/auth/me
 *   GET  /api/mangas/mine?ownerId → {mangas}     GET /api/genres → {genres:[{id,name,slug}]} (pública)
 *   POST /api/mangas (multipart: ownerId, title, description, type, adult, demografy, status,
 *        genres = JSON con los ids, cover) → {manga}
 *   GET  /api/mangas/:slug/chapters → {chapters}
 *   POST /api/mangas/:slug/chapters (multipart: number, title, pages repetido en orden) → {chapter}
 *   DELETE /api/mangas/:slug/chapters/:id
 * Sesión: la cookie, guardada cifrada (nunca la contraseña). Si el servidor la renueva, se guarda la
 * nueva. Un capítulo se sube en una sola petición: no se repite a ciegas; si se corta, se revisa la
 * lista de capítulos para saber si llegó.
 */
const { PlatformError, createClient, createPacer, multipart, filePart } = require('./http')
const { cancelled } = require('../util')
const diagnostics = require('../diagnostics')

const ID = 'mangation'
const LABEL = 'Mangation'
const DEFAULT_BASE = 'https://api.mangation.com'
const ORIGIN = 'https://creator.mangation.com'
const COOKIE_NAME = '__Host-manga_session'
const SECRET = 'mangationCookie'
const USER = 'mangationUser'
const MAX_CHAPTER_BYTES = 200 * 1024 * 1024
const MAX_COVER_BYTES = 5 * 1024 * 1024
const MAX_GENRES = 15
const MAX_TITLE = 180
const MAX_DESCRIPTION = 10000
const GENRES_TTL = 60 * 60e3

const TYPES = [
  { value: 'manga', label: 'Manga' }, { value: 'manhwa', label: 'Manhwa' }, { value: 'manhua', label: 'Manhua' },
]
const STATUSES = [
  { value: 'ongoing', label: 'En curso' }, { value: 'completed', label: 'Completado' }, { value: 'hiatus', label: 'En pausa' },
]
const DEMOGRAPHIES = [
  { value: 'shonen', label: 'Shonen' }, { value: 'shojo', label: 'Shojo' }, { value: 'seinen', label: 'Seinen' },
  { value: 'josei', label: 'Josei' }, { value: 'kodomo', label: 'Kodomo' }, { value: 'yaoi', label: 'Yaoi' },
  { value: 'yuri', label: 'Yuri' }, { value: 'bl', label: 'BL' }, { value: 'gl', label: 'GL' },
]

// En desarrollo (electron .) se puede apuntar a un servidor de pruebas; la app instalada no lo lee.
let base = (process.defaultApp && process.env.CAPI_MANGATION_BASE) || DEFAULT_BASE

/** Extrae «__Host-manga_session=valor» de las cabeceras Set-Cookie. */
function sessionCookieFrom(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean)
  for (const line of list) {
    const m = new RegExp(`${COOKIE_NAME}=([^;]*)`).exec(line)
    if (m) return m[1] ? `${COOKIE_NAME}=${m[1]}` : ''
  }
  return null
}

const store = () => require('../store')

const client = createClient({
  id: ID,
  label: LABEL,
  base: () => base,
  origin: ORIGIN,
  pacer: createPacer({ concurrency: 3, minGapMs: 150 }),
  auth: (cookie) => ({ Cookie: cookie }),
  // Si el servidor renueva la cookie en una respuesta, se guarda la nueva.
  onResponse: (res) => {
    const c = sessionCookieFrom(res)
    if (c && sessionHolder.save) sessionHolder.save(c)
  },
})
const sessionHolder = { save: null }
const request = client.request

/* ---------- Datos ---------- */

const coverUrlOf = (v) => {
  const x = typeof v === 'string' ? v : (v?.url || v?.src || '')
  if (!x) return null
  if (/^https:\/\//.test(x)) return x
  if (x.startsWith('//')) return `https:${x}`
  return x.startsWith('/') ? `${base}${x}` : null
}

const normWork = (m) => ({
  id: m.slug,
  mangaId: m.id ?? null,
  title: m.title || '',
  slug: m.slug,
  type: m.type || null,
  status: m.status || null,
  adult: Boolean(m.adult),
  coverUrl: coverUrlOf(m.cover ?? m.coverUrl ?? m.image),
  lastChapter: m.lastChapter?.number != null ? Number(m.lastChapter.number) : null,
  updatedAt: m.updatedAt || m.createdAt || null,
})

const normChapter = (c) => ({
  id: String(c.id),
  number: Number(c.number),
  title: c.title || '',
  state: 'published',
  createdAt: c.createdAt || c.publishedAt || null,
  pages: Array.isArray(c.pages) ? c.pages.length : (c.pageCount ?? c.pagesCount ?? null),
})

const normUser = (u = {}, email = '') => ({ id: u.id ?? null, name: u.name || u.username || u.displayName || null, email: u.email || email })

async function login(email, password) {
  email = String(email || '').trim()
  password = String(password || '')
  if (!email || !password) throw new PlatformError('Escribe tu correo y contraseña.', 'mangation.bad_credentials')
  let out
  try {
    out = await request({ method: 'POST', path: '/api/auth/login', json: { email, password }, raw: true })
  } catch (err) {
    if (err.status === 400 || err.status === 401 || err.code === 'mangation.session_expired') {
      throw new PlatformError('Correo o contraseña incorrectos.', 'mangation.bad_credentials', err.status)
    }
    throw err
  }
  const cookie = sessionCookieFrom(out.res)
  if (!cookie) throw new PlatformError('Mangation no devolvió la sesión al iniciar sesión.', 'mangation.bad_response')
  return { cookie, user: normUser(out.body?.user, email) }
}

async function listWorks(cookie, user, signal) {
  const q = user?.id != null ? `?ownerId=${encodeURIComponent(user.id)}` : ''
  const body = await request({ session: cookie, path: `/api/mangas/mine${q}`, signal })
  const list = Array.isArray(body?.mangas) ? body.mangas : Array.isArray(body) ? body : null
  if (!list) throw new PlatformError('Mangation respondió algo inesperado al listar tus obras.', 'mangation.bad_response')
  return list.filter((m) => m?.slug).map(normWork)
}

let genresCache = null // { at, list }
async function listGenres(signal) {
  if (genresCache && Date.now() - genresCache.at < GENRES_TTL) return genresCache.list
  const body = await request({ path: '/api/genres', signal })
  const list = (Array.isArray(body?.genres) ? body.genres : []).filter((g) => g?.id && g.name).map((g) => ({ id: String(g.id), name: g.name }))
  if (!list.length) throw new PlatformError('Mangation no devolvió la lista de géneros.', 'mangation.bad_response')
  genresCache = { at: Date.now(), list }
  return list
}

async function listChapters(cookie, slug, signal) {
  const body = await request({ session: cookie, path: `/api/mangas/${encodeURIComponent(slug)}/chapters`, signal })
  return (Array.isArray(body?.chapters) ? body.chapters : []).filter((c) => c?.number != null).map(normChapter).sort((a, b) => b.number - a.number)
}

/** fields: { title, description, type, adult, demography, status, genres: [ids] }; cover: { path, name, type }. */
async function createWork(cookie, user, fields, images = {}, signal) {
  if (user?.id == null) throw new PlatformError('Falta tu usuario de Mangation: inicia sesión de nuevo.', 'mangation.session_expired', 401)
  const title = String(fields.title || '').trim().slice(0, MAX_TITLE)
  const genres = (Array.isArray(fields.genres) ? fields.genres : []).map(String).slice(0, MAX_GENRES)
  if (!title) throw new PlatformError('La obra necesita un título.', 'mangation.invalid')
  if (!genres.length) throw new PlatformError('Mangation pide al menos un género.', 'mangation.invalid')
  if (!images.cover) throw new PlatformError('Mangation pide una portada.', 'mangation.invalid')
  const cover = await filePart('cover', images.cover)
  if (cover.size > MAX_COVER_BYTES) throw new PlatformError('La portada supera los 5 MB que acepta Mangation.', 'mangation.invalid')
  const body = await request({
    session: cookie, method: 'POST', path: '/api/mangas', signal,
    form: multipart([
      { name: 'ownerId', value: String(user.id) },
      { name: 'title', value: title },
      { name: 'description', value: String(fields.description || '').slice(0, MAX_DESCRIPTION) },
      { name: 'type', value: fields.type || 'manga' },
      { name: 'adult', value: fields.adult ? 'true' : 'false' },
      { name: 'demografy', value: fields.demography || '' },
      { name: 'status', value: fields.status || 'ongoing' },
      { name: 'genres', value: JSON.stringify(genres) },
      cover,
    ]),
  })
  if (!body?.manga?.slug) throw new PlatformError('Mangation respondió sin los datos de la obra creada.', 'mangation.bad_response')
  return { id: body.manga.slug, work: normWork(body.manga), warnings: [] }
}

/**
 * Sube el capítulo en una sola petición (las páginas van en orden, leídas del disco mientras se
 * envían). files: [{ path, name, type, size }]. Si la conexión se corta o el servidor falla (5xx),
 * se mira si el capítulo quedó creado antes de dar un error.
 */
async function uploadChapter(cookie, { workId, chapter, files, signal, onProgress = () => {} }) {
  const totalBytes = files.reduce((s, f) => s + f.size, 0)
  if (totalBytes > MAX_CHAPTER_BYTES) {
    throw new PlatformError(`El capítulo pesa ${Math.round(totalBytes / 1048576)} MB y Mangation acepta hasta 200 MB por capítulo.`, 'mangation.too_large', 413)
  }
  const form = multipart([
    { name: 'number', value: String(chapter.number) },
    ...(chapter.title ? [{ name: 'title', value: String(chapter.title).trim() }] : []),
    ...files.map((f) => ({ name: 'pages', path: f.path, size: f.size, filename: f.name, type: f.type })),
  ])
  let doneBytes = 0
  let fileIdx = 0
  let fileLeft = files[0]?.size ?? 0
  onProgress({ phase: 'upload', doneBytes, totalBytes, done: 0, total: files.length })
  onProgress({ phase: 'file', index: 0, status: 'uploading' })
  const onBytes = (n) => {
    doneBytes += n
    if (n < 0) { // se reinició el envío
      doneBytes = Math.max(0, doneBytes); fileIdx = 0; fileLeft = files[0]?.size ?? 0
    } else {
      fileLeft -= n
      while (fileLeft <= 0 && fileIdx < files.length) {
        onProgress({ phase: 'file', index: fileIdx, status: 'sent' })
        fileIdx++
        fileLeft += files[fileIdx]?.size ?? 0
        if (fileIdx < files.length) onProgress({ phase: 'file', index: fileIdx, status: 'uploading' })
      }
    }
    onProgress({ phase: 'upload', doneBytes, totalBytes, done: fileIdx, total: files.length })
  }

  let body
  try {
    body = await request({ session: cookie, method: 'POST', path: `/api/mangas/${encodeURIComponent(workId)}/chapters`, form, onBytes, signal, timeoutMs: 15 * 60e3 })
  } catch (err) {
    if (signal?.aborted) throw cancelled('Subida cancelada.')
    if (err.status === 409) throw new PlatformError(`El capítulo ${chapter.number} ya existe en Mangation.`, 'api.chapter_exists', 409, { platform: ID })
    // ¿Llegó aunque se cortó la respuesta?
    if (['network', 'timeout'].includes(err.code) || err.status >= 500) {
      const found = await listChapters(cookie, workId).then((l) => l.find((c) => c.number === Number(chapter.number))).catch(() => null)
      if (found) {
        diagnostics.warn(ID, `Cap ${chapter.number}: la respuesta se cortó pero el capítulo sí se creó (id ${found.id}).`)
        files.forEach((_, i) => onProgress({ phase: 'file', index: i, status: 'done' }))
        onProgress({ phase: 'done' })
        return { id: found.id, number: found.number, pages: files.length }
      }
    }
    files.forEach((_, i) => i >= fileIdx && onProgress({ phase: 'file', index: i, status: 'error' }))
    throw err
  }
  const id = body?.chapter?.id
  if (id == null) throw new PlatformError('Mangation respondió sin el id del capítulo.', 'mangation.bad_response')
  files.forEach((_, i) => onProgress({ phase: 'file', index: i, status: 'done' }))
  onProgress({ phase: 'done' })
  return { id: String(id), number: Number(chapter.number), pages: body.chapter.pages?.length ?? files.length }
}

const deleteChapter = (cookie, slug, chapterId) =>
  request({ session: cookie, method: 'DELETE', path: `/api/mangas/${encodeURIComponent(slug)}/chapters/${encodeURIComponent(chapterId)}` }).then(() => true)

/* ---------- Sesión (guardada cifrada) ---------- */

const currentCookie = () => store().getSecret(SECRET) || null
sessionHolder.save = (c) => { if (c === '') store().deleteSecret(SECRET); else if (c !== currentCookie()) store().setSecret(SECRET, c) }

function status() {
  const cookie = currentCookie()
  return { loggedIn: Boolean(cookie), user: cookie ? store().get(USER) || null : null, expiresAt: null }
}

async function signIn({ username, password } = {}) {
  const { cookie, user } = await login(username, password)
  store().setSecret(SECRET, cookie)
  store().set(USER, user)
  diagnostics.info(ID, `Sesión iniciada como ${user.name || user.email}.`)
  return status()
}

function signOut() {
  store().deleteSecret(SECRET)
  store().set(USER, null)
  return true
}

async function withSession(fn) {
  const cookie = currentCookie()
  if (!cookie) throw new PlatformError('Inicia sesión en Mangation para continuar.', 'mangation.session_expired', 401)
  try {
    return await fn(cookie, store().get(USER) || {})
  } catch (err) {
    if (err.code === 'mangation.session_expired') store().deleteSecret(SECRET)
    throw err
  }
}

module.exports = {
  ID, LABEL, TYPES, STATUSES, DEMOGRAPHIES, MAX_GENRES, MAX_TITLE, MAX_DESCRIPTION, MAX_COVER_BYTES, MAX_CHAPTER_BYTES,
  setBase: (url) => { base = url || DEFAULT_BASE; genresCache = null },
  sessionCookieFrom, login, listWorks, listGenres, listChapters, createWork, uploadChapter, deleteChapter,
  status, signIn, signOut, withSession,
  // Para pruebas sin Electron: dónde guardar la cookie renovada.
  _setSessionSaver: (fn) => { sessionHolder.save = fn },
}
