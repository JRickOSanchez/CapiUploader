/**
 * Crimson Scan (el panel admin.scancrimson.com habla con este Worker). Lo que usa la app:
 *   POST /api/auth/login {username,password} → {token,user}   GET /api/auth/me
 *   GET  /api/mangas?admin=1 → {mangas}      GET /api/mangas/:id?admin=1 → {manga, capitulos}
 *   POST /api/mangas {titulo,tipo,estado,descripcion,generos,scan_id,joint_scan_id,es_adulto} → {mangaId}
 *   POST /api/upload/cover · /api/upload/banner (multipart: manga_id, cover|banner WebP, converted)
 *   POST /api/chapters {manga_id,numero,titulo,fecha_publicacion,notify_discord} → {capituloId}
 *   POST /api/upload/page (multipart: capitulo_id, numero, image WebP, converted)
 *   GET  /api/admin/chapters/:id/pages/list   PUT /api/chapters/:id {numero}   DELETE /api/chapters/:id
 * Sesión: `Authorization: Bearer <JWT>` (dura ~7 días); se guarda cifrado, nunca la contraseña.
 * Crimson solo acepta páginas WebP y limita los capítulos por cuenta («máximo N capítulos cada M
 * minutos»): ese aviso se convierte en una pausa de la tanda (api.rate_limited con retryAfter).
 */
const { PlatformError, createClient, createPacer, multipart, filePart } = require('./http')
const { pool, cancelled } = require('../util')
const diagnostics = require('../diagnostics')

const ID = 'crimson'
const LABEL = 'Crimson Scan'
const DEFAULT_BASE = 'https://crimson-api.leandro-reyes1025.workers.dev'
const ORIGIN = 'https://admin.scancrimson.com'
const SECRET = 'crimsonToken'
const USER = 'crimsonUser'
const SKEW = 60e3
const PAGE_CONCURRENCY = 3
const PENDING_TTL = 3 * 60 * 60e3

const TYPES = [
  { value: 'manga', label: 'Manga' }, { value: 'manhwa', label: 'Manhwa' }, { value: 'manhua', label: 'Manhua' },
]
const STATUSES = [
  { value: 'en_curso', label: 'En curso' }, { value: 'completado', label: 'Completado' }, { value: 'pausado', label: 'Pausado' },
]
// Lista del panel de Crimson (los géneros se guardan por nombre).
const GENRES = ['Acción', 'Aventura', 'Comedia', 'Drama', 'Fantasía', 'Romance', 'Horror', 'Misterio', 'Psicológico', 'Ciencia Ficción', 'Sobrenatural', 'Thriller', 'Deportes', 'Histórico', 'Isekai', 'Mecha', 'Magia', 'Artes Marciales', 'Superpoderes', 'Reencarnación', 'Supervivencia', 'Escolar', 'Vida Escolar', 'Recuentos de la Vida (Slice of Life)', 'Tragedia', 'Adulto', 'Maduro', 'Ecchi', 'Harem', 'Harem Inverso', 'Seinen', 'Shounen', 'Shoujo', 'Josei', 'Género Bender', 'Crossdressing', 'Apocalipsis', 'Postapocalíptico', 'Sistema', 'Videojuegos', 'VRMMO', 'Cultivación', 'Wuxia', 'Xianxia', 'Xuanhuan', 'Murim', 'Regresión', 'Regresor', 'Viaje en el Tiempo', 'Venganza', 'Villana', 'Realeza', 'Nobleza', 'Política', 'Militar', 'Médico', 'Cocina', 'Música', 'Idol', 'Oficina', 'Crimen', 'Detectives', 'Mafia', 'Monstruos', 'Demonios', 'Ángeles', 'Vampiros', 'Zombies', 'Mazmorras', 'Cazadores', 'Invocación', 'Magia Oscura', 'Alquimia', 'Bestias Mágicas', 'Omegaverse', 'BL (Boys Love)', 'GL (Girls Love)', 'Yuri', 'Yaoi', 'Shounen Ai', 'Josei Ai', 'Harén Masculino', 'Harén Femenino', 'Sadomasoquismo']

// En desarrollo (electron .) se puede apuntar a un servidor de pruebas; la app instalada no lo lee.
let base = (process.defaultApp && process.env.CAPI_CRIMSON_BASE) || DEFAULT_BASE
const LIMIT_RE = /m[aá]ximo\s+(\d+)\s+cap[ií]tulos?\s+cada\s+(\d+)\s+minutos?/i

/** El límite de subidas de Crimson llega como 429/403 con un texto: esperar segundos no sirve. */
function classify(res, body) {
  if (res.status !== 429 && res.status !== 403) return null
  const text = String(body?.error || body?.message || '')
  const m = LIMIT_RE.exec(text)
  if (!m && !/l[ií]mite de (carga|subida)/i.test(text)) return null
  const minutes = m ? Number(m[2]) : 10
  return new PlatformError(
    `Crimson limita las subidas${m ? ` a ${m[1]} capítulos cada ${m[2]} minutos` : ''} por cuenta. Lo ya subido no se pierde: la tanda sigue sola cuando pase la espera.`,
    'api.rate_limited', 429, { retryAfter: minutes * 60, limit: m ? { chapters: Number(m[1]), minutes } : null, platform: ID })
}

const client = createClient({
  id: ID,
  label: LABEL,
  base: () => base,
  origin: ORIGIN,
  pacer: createPacer({ concurrency: 4, minGapMs: 120 }),
  auth: (token) => ({ Authorization: `Bearer ${token}` }),
  classify,
})
const request = client.request

/* ---------- Datos ---------- */

/** Caducidad (ms) del JWT, o null si no se puede leer. No verifica la firma. */
function jwtExpiry(token) {
  try {
    const p = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'))
    return typeof p.exp === 'number' ? (p.exp < 1e12 ? p.exp * 1000 : p.exp) : null
  } catch {
    return null
  }
}

const normUser = (u = {}, fallback = '') => ({
  id: u.id ?? null,
  username: u.username || fallback,
  displayName: u.display_name || null,
  role: u.rol || null,
  scanId: u.scan_id ?? null,
  scanName: u.scan_nombre || null,
})

const coverUrl = (id) => `${base}/api/cover/${encodeURIComponent(id)}`

const normWork = (m) => ({
  id: String(m.id),
  title: m.titulo || '',
  slug: m.slug || null,
  type: m.tipo || null,
  status: m.estado || null,
  adult: Boolean(m.es_adulto),
  hidden: Boolean(m.oculto),
  coverUrl: m.id != null ? coverUrl(m.id) : null,
  lastChapter: m.ultimo_capitulo != null ? Number(m.ultimo_capitulo) : null,
  updatedAt: m.ultimo_cap_fecha || m.fecha_creacion || null,
})

const STATE = { publicado: 'published', programado: 'scheduled', borrador: 'draft' }
const normChapter = (c) => ({
  id: String(c.id),
  number: Number(c.numero),
  title: c.titulo || '',
  state: STATE[c.estado] || c.estado || 'published',
  publishAt: c.fecha_publicacion || null,
  createdAt: c.fecha_subida || null,
  views: c.views ?? null,
})

async function login(username, password) {
  username = String(username || '').trim()
  password = String(password || '')
  if (!username || !password) throw new PlatformError('Escribe tu usuario y contraseña.', 'crimson.bad_credentials')
  let body
  try {
    body = await request({ method: 'POST', path: '/api/auth/login', json: { username, password } })
  } catch (err) {
    if ([400, 401, 403].includes(err.status) && err.code !== 'api.rate_limited') {
      throw new PlatformError(err.status === 401 || /contrase|usuario|credencial/i.test(err.message) ? 'Usuario o contraseña incorrectos.' : err.message, 'crimson.bad_credentials', err.status)
    }
    throw err
  }
  if (typeof body?.token !== 'string' || !body.token) throw new PlatformError('Crimson respondió algo inesperado al iniciar sesión.', 'crimson.bad_response')
  return { token: body.token, user: normUser(body.user, username) }
}

async function listWorks(token, _user, signal) {
  const body = await request({ session: token, path: '/api/mangas?admin=1', signal })
  return (Array.isArray(body?.mangas) ? body.mangas : []).filter((m) => m?.id != null).map(normWork)
}

/** La obra con sus capítulos (los del panel, incluidos los programados). */
async function getWork(token, id, signal) {
  const body = await request({ session: token, path: `/api/mangas/${encodeURIComponent(id)}?admin=1`, signal })
  return {
    work: body?.manga ? normWork(body.manga) : null,
    chapters: (Array.isArray(body?.capitulos) ? body.capitulos : []).map(normChapter).sort((a, b) => b.number - a.number),
  }
}

const listChapters = async (token, id, signal) => (await getWork(token, id, signal)).chapters

/** El id del capítulo recién creado (se aceptan varias formas por si la respuesta cambia). */
function findId(body, ...keys) {
  for (const k of keys) {
    const v = k.split('.').reduce((o, p) => o?.[p], body)
    if ((typeof v === 'string' && v) || typeof v === 'number') return String(v)
  }
  return null
}

/**
 * Crea la ficha y sube la portada (y el banner, si hay). fields: { title, type, status, description,
 * genres[], adult }; images: { cover: {path,name,type,converted}, banner? }.
 */
async function createWork(token, user, fields, images = {}, signal) {
  const body = await request({
    session: token, method: 'POST', path: '/api/mangas', signal,
    json: {
      titulo: String(fields.title || '').trim(),
      tipo: fields.type || 'manga',
      estado: fields.status || 'en_curso',
      descripcion: String(fields.description || ''),
      generos: Array.isArray(fields.genres) ? fields.genres : [],
      scan_id: user?.scanId ?? null,
      joint_scan_id: null,
      es_adulto: Boolean(fields.adult),
    },
  })
  const id = findId(body, 'mangaId', 'manga_id', 'id', 'manga.id')
  if (!id) throw new PlatformError('Crimson respondió sin el id de la obra creada.', 'crimson.bad_response')
  const warnings = []
  for (const kind of ['cover', 'banner']) {
    const img = images[kind]
    if (!img) continue
    try {
      await request({
        session: token, method: 'POST', path: `/api/upload/${kind}`, signal, retry: true,
        form: multipart([
          { name: 'manga_id', value: id },
          await filePart(kind, img, img.name, img.type),
          ...(img.converted ? [{ name: 'converted', value: '1' }] : []),
        ]),
      })
    } catch (err) {
      if (err.code === 'cancelled') throw err
      warnings.push(`No se pudo subir ${kind === 'cover' ? 'la portada' : 'el banner'}: ${err.message}`)
    }
  }
  return { id, warnings }
}

/* ---------- Subida de capítulos ----------
   Crimson crea el capítulo y luego recibe cada página aparte. Si algo falla a mitad, el capítulo
   queda creado: se recuerda (id y páginas ya subidas) y al reintentar se completan solo las que
   faltan, sin crear otro ni repetir páginas. */

const pending = new Map() // `${workId}|${number}` -> { chapterId, done: Set, total, at }

function prunePending(now = Date.now()) {
  for (const [k, p] of pending) if (now - p.at > PENDING_TTL) pending.delete(k)
}

/**
 * files: [{ path, name, type, size, converted }] ya en WebP. chapter: { number, title, publishAt, notify }.
 * onProgress recibe las mismas fases que la subida a Capibara.
 */
async function uploadChapter(token, { workId, chapter, files, signal, onProgress = () => {} }) {
  prunePending()
  const key = `${workId}|${Number(chapter.number)}`
  let state = pending.get(key)
  if (state && state.total !== files.length) { pending.delete(key); state = null }

  if (!state) {
    onProgress({ phase: 'create' })
    const body = await request({
      session: token, method: 'POST', path: '/api/chapters', signal,
      json: {
        manga_id: String(workId),
        numero: Number(chapter.number),
        titulo: chapter.title || null,
        fecha_publicacion: chapter.publishAt || null,
        notify_discord: chapter.notify !== false,
      },
    }).catch((err) => {
      if (err.status === 409 || /ya existe/i.test(err.message)) {
        throw new PlatformError(`El capítulo ${chapter.number} ya existe en Crimson.`, 'api.chapter_exists', 409, { platform: ID })
      }
      throw err
    })
    const chapterId = findId(body, 'capituloId', 'capitulo_id', 'chapterId', 'id', 'capitulo.id', 'chapter.id')
    if (!chapterId) throw new PlatformError('Crimson respondió sin el id del capítulo.', 'crimson.bad_response')
    state = { chapterId, done: new Set(), total: files.length, at: Date.now() }
    pending.set(key, state)
  } else {
    diagnostics.info(ID, `Cap ${chapter.number}: se retoma el capítulo ${state.chapterId} (${state.done.size}/${files.length} páginas ya subidas).`)
  }

  const totalBytes = files.reduce((s, f) => s + f.size, 0)
  let doneBytes = files.reduce((s, f, i) => s + (state.done.has(i) ? f.size : 0), 0)
  files.forEach((_, i) => state.done.has(i) && onProgress({ phase: 'file', index: i, status: 'done', reused: true }))
  const report = () => onProgress({ phase: 'upload', doneBytes, totalBytes, done: state.done.size, total: files.length })
  report()

  const todo = files.map((_, i) => i).filter((i) => !state.done.has(i))
  try {
    await pool(todo, PAGE_CONCURRENCY, async (i) => {
      const f = files[i]
      onProgress({ phase: 'file', index: i, status: 'uploading' })
      try {
        await request({
          session: token, method: 'POST', path: '/api/upload/page', signal, retry: true,
          form: multipart([
            { name: 'capitulo_id', value: state.chapterId },
            { name: 'numero', value: String(i + 1) },
            { name: 'image', path: f.path, size: f.size, filename: f.name, type: f.type },
            ...(f.converted ? [{ name: 'converted', value: '1' }] : []),
          ]),
          onBytes: (n) => { doneBytes += n; report() },
        })
      } catch (err) {
        onProgress({ phase: 'file', index: i, status: 'error' })
        if (signal?.aborted) throw cancelled('Subida cancelada.')
        if (err.code === 'api.rate_limited' || /session_expired/.test(err.code)) throw err
        throw new PlatformError(`No se pudo subir la página ${i + 1} (${f.name}): ${err.message}`, 'crimson.page_failed', err.status)
      }
      state.done.add(i)
      state.at = Date.now()
      onProgress({ phase: 'file', index: i, status: 'done' })
      report()
    }, signal)
  } catch (err) {
    if (err.code !== 'cancelled') err.message += ' El capítulo quedó a medias en Crimson: al reintentar se suben solo las páginas que faltan.'
    err.partialChapterId = state.chapterId
    throw err
  }
  pending.delete(key)
  onProgress({ phase: 'done' })
  return { id: state.chapterId, number: Number(chapter.number), pages: files.length }
}

async function deleteChapter(token, chapterId) {
  await request({ session: token, method: 'DELETE', path: `/api/chapters/${encodeURIComponent(chapterId)}` })
  for (const [k, p] of pending) if (p.chapterId === String(chapterId)) pending.delete(k)
  return true
}

const renumberChapter = (token, chapterId, number) =>
  request({ session: token, method: 'PUT', path: `/api/chapters/${encodeURIComponent(chapterId)}`, json: { numero: Number(number) } }).then(() => true)

/* ---------- Sesión (guardada cifrada) ---------- */

const store = () => require('../store')

function currentToken() {
  const token = store().getSecret(SECRET)
  if (!token) return null
  const exp = jwtExpiry(token)
  return exp && exp - SKEW < Date.now() ? null : token
}

function status() {
  const token = currentToken()
  return { loggedIn: Boolean(token), user: token ? store().get(USER) || null : null, expiresAt: token ? jwtExpiry(token) : null }
}

async function signIn({ username, password } = {}) {
  const { token, user } = await login(username, password)
  store().setSecret(SECRET, token)
  store().set(USER, user)
  diagnostics.info(ID, `Sesión iniciada como ${user.username}${user.scanName ? ` (${user.scanName})` : ''}.`)
  return status()
}

function signOut() {
  store().deleteSecret(SECRET)
  store().set(USER, null)
  pending.clear()
  return true
}

/** Ejecuta fn(token, user); si el servidor rechaza la sesión, se borra. */
async function withSession(fn) {
  const token = currentToken()
  if (!token) throw new PlatformError('Inicia sesión en Crimson Scan para continuar.', 'crimson.session_expired', 401)
  try {
    return await fn(token, store().get(USER) || {})
  } catch (err) {
    if (err.code === 'crimson.session_expired') store().deleteSecret(SECRET)
    throw err
  }
}

module.exports = {
  ID, LABEL, TYPES, STATUSES, GENRES,
  setBase: (url) => { base = url || DEFAULT_BASE },
  jwtExpiry, classify, login, listWorks, getWork, listChapters, createWork, uploadChapter, deleteChapter, renumberChapter,
  status, signIn, signOut, withSession,
  _pending: pending,
}
