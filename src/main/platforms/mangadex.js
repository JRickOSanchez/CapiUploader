/**
 * MangaDex (api.mangadex.org, API v5). Solo se sube a obras que ya existen en MangaDex: crear una
 * obra allí es un borrador que revisa su staff, así que la app no lo ofrece.
 *
 * Sesión (OAuth 2, «personal API client» de la cuenta):
 *   POST auth.mangadex.org/realms/mangadex/protocol/openid-connect/token (formulario)
 *     grant_type=password + username, password, client_id, client_secret → access_token (15 min) + refresh_token
 *     grant_type=refresh_token + refresh_token, client_id, client_secret → access_token nuevo
 *   Se guarda cifrado solo el refresh_token con el client_id y el client_secret (nunca la contraseña).
 *   El access_token vive en memoria y se renueva solo.
 *
 * Lo que usa la app:
 *   GET /user/me                         usuario de la sesión
 *   GET /group?name= · GET /group/:id    elegir los grupos de scanlation (o «Sin grupo», solo autor o traductor autorizado)
 *   GET /manga?group= · GET /manga?ids[]= · GET /manga?title=   obras de los grupos, las agregadas a mano y la búsqueda
 *   GET /chapter?manga=&groups[]=  (o &uploader= sin grupo)   capítulos ya subidos, de todos los idiomas
 *     (cada capítulo puede ir en otro idioma: el 12 en español y el 12 en inglés son capítulos distintos)
 *   POST /upload/check-approval-required  ¿lo revisa el staff? (el primero de cada idioma)
 *   GET /upload → DELETE /upload/:id      una sola sesión de subida por cuenta (solo se abandona una nuestra)
 *   POST /upload/begin {manga, groups}
 *   POST /upload/:id                     multipart, hasta 10 archivos por petición (campos file1…file10)
 *   POST /upload/:id/commit {chapterDraft, pageOrder, termsAccepted: true}
 *   DELETE /chapter/:id
 *
 * Límites de MangaDex (sus reglas de subida): JPG, PNG o GIF; hasta 20 MB y 10 000 × 10 000 px cada
 * página; hasta 500 imágenes y 300 MB por capítulo. Unas 5 peticiones por segundo por IP, 10 commits y 20 begin por
 * minuto; un 429 trae X-RateLimit-Retry-After (hora UNIX de fin del periodo) y seguir insistiendo
 * bloquea la IP, así que el ritmo es conservador y un 429 pausa todas las peticiones.
 * Las cabeceras de autenticación solo van a api.mangadex.org y auth.mangadex.org.
 */
const path = require('node:path')
const fs = require('node:fs/promises')
const { PlatformError, createClient, createPacer, multipart } = require('./http')
const { UA } = require('./http')
const { cancelled } = require('../util')
const diagnostics = require('../diagnostics')

const ID = 'mangadex'
const LABEL = 'MangaDex'
const DEFAULT_BASE = 'https://api.mangadex.org'
const DEFAULT_AUTH = 'https://auth.mangadex.org'
const TOKEN_PATH = '/realms/mangadex/protocol/openid-connect/token'
const SECRET = 'mangadexAuth'
const USER = 'mangadexUser'
const SETTINGS = 'mangadexSettings'
const WORKS = 'mangadexWorks'
const OWN_SESSION = 'mangadexUploadSession'

const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_SIDE = 10000 // «menos de 10 000 px» por lado
const MAX_PAGES = 500
const MAX_SESSION_BYTES = 300 * 1024 * 1024
const FILES_PER_REQUEST = 10
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/gif']
const CONTENT_RATINGS = ['safe', 'suggestive', 'erotica', 'pornographic']
const RULES_URL = 'https://mangadex.org/rules'
const TERMS_URL = 'https://mangadex.org/compliance'

// Idiomas de las traducciones (códigos de MangaDex).
const LANGUAGES = [
  { value: 'es-la', label: 'Español (Latinoamérica)' },
  { value: 'es', label: 'Español (España)' },
  { value: 'en', label: 'Inglés' },
  { value: 'pt-br', label: 'Portugués (Brasil)' },
]
const DEFAULT_LANG = 'es-la'
const isLang = (v) => LANGUAGES.some((l) => l.value === v)

// En desarrollo (electron .) se puede apuntar a un servidor falso; la app instalada no lo lee.
let base = (process.defaultApp && process.env.CAPI_MANGADEX_BASE) || DEFAULT_BASE
let authBase = (process.defaultApp && process.env.CAPI_MANGADEX_AUTH) || DEFAULT_AUTH

const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''))

/** El error de MangaDex ({ result: 'error', errors: [{ status, title, detail }] }) en un mensaje legible. */
function errorDetail(body) {
  const e = Array.isArray(body?.errors) ? body.errors[0] : null
  return e ? (e.detail || e.title || null) : null
}

const client = createClient({
  id: ID,
  label: LABEL,
  base: () => base,
  // Por debajo del límite global (~5 por segundo por IP): de a 2 y separadas.
  pacer: createPacer({ concurrency: 2, minGapMs: 260 }),
  auth: (token) => ({ Authorization: `Bearer ${token}` }),
  retryAfterMs: (res) => {
    const at = Number(res.headers.get('x-ratelimit-retry-after'))
    return at > 0 ? Math.max(1000, at * 1000 - Date.now() + 500) : 0
  },
  classify: (res, body) => {
    if (res.ok || res.status === 401 || res.status === 429 || res.status >= 500) return null
    const detail = errorDetail(body)
    if (!detail) return null
    const code = res.status === 403 ? 'mangadex.forbidden' : res.status === 404 ? 'mangadex.not_found' : res.status === 409 ? 'mangadex.conflict' : 'mangadex.bad_request'
    return new PlatformError(`MangaDex: ${detail}`, code, res.status)
  },
})
const request = client.request

/* ---------- Sesión OAuth ---------- */

const store = () => require('../store')
let access = null // { token, exp }

/** Pide un token al servidor de autenticación (formulario, no JSON). */
async function tokenRequest(fields, signal) {
  let res
  try {
    res = await fetch(authBase + TOKEN_PATH, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': UA },
      body: new URLSearchParams(fields).toString(),
    })
  } catch (err) {
    if (signal?.aborted) throw cancelled()
    throw new PlatformError('No se pudo conectar con MangaDex. Revisa tu conexión.', 'network', 0)
  }
  const body = await res.json().catch(() => null)
  if (res.ok && body?.access_token) return body
  if (res.status === 429) throw new PlatformError('MangaDex pide esperar antes de volver a intentar entrar.', 'api.rate_limited', 429, { retryAfter: 60 })
  const what = body?.error_description || body?.error || ''
  if (fields.grant_type === 'refresh_token') {
    throw new PlatformError('Tu sesión de MangaDex venció. Inicia sesión de nuevo.', 'mangadex.session_expired', 401)
  }
  if (/client/i.test(what) || body?.error === 'unauthorized_client' || body?.error === 'invalid_client') {
    throw new PlatformError('El Client ID o el Client Secret no son válidos, o el cliente aún no está aprobado por MangaDex.', 'mangadex.bad_client', res.status)
  }
  throw new PlatformError('Usuario o contraseña incorrectos.', 'mangadex.bad_credentials', res.status)
}

const remember = (t) => { access = { token: t.access_token, exp: Date.now() + (Number(t.expires_in) || 900) * 1000 } }

/** Inicia sesión y devuelve { auth (lo que se guarda cifrado), user }. */
async function login({ username, password, clientId, clientSecret } = {}) {
  username = String(username || '').trim()
  password = String(password || '')
  clientId = String(clientId || '').trim()
  clientSecret = String(clientSecret || '').trim()
  if (!username || !password) throw new PlatformError('Escribe tu usuario y tu contraseña de MangaDex.', 'mangadex.bad_credentials')
  if (!clientId || !clientSecret) throw new PlatformError('Escribe el Client ID y el Client Secret de tu cliente personal de la API.', 'mangadex.bad_client')
  const t = await tokenRequest({ grant_type: 'password', username, password, client_id: clientId, client_secret: clientSecret })
  remember(t)
  const me = await request({ session: access.token, path: '/user/me' })
  const user = { id: me?.data?.id ?? null, username: me?.data?.attributes?.username || username }
  return { auth: { refreshToken: t.refresh_token, clientId, clientSecret }, user }
}

const savedAuth = () => {
  const raw = store().getSecret(SECRET)
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

/** Un access_token vigente (se renueva si le queda menos de un minuto o si se pide). */
async function accessToken({ force = false } = {}) {
  if (!force && access && access.exp - Date.now() > 60e3) return access.token
  const a = savedAuth()
  if (!a?.refreshToken) throw new PlatformError('Inicia sesión en MangaDex para continuar.', 'mangadex.session_expired', 401)
  try {
    const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: a.refreshToken, client_id: a.clientId, client_secret: a.clientSecret })
    remember(t)
    // Keycloak puede rotar el refresh_token: se guarda el nuevo.
    if (t.refresh_token && t.refresh_token !== a.refreshToken) store().setSecret(SECRET, JSON.stringify({ ...a, refreshToken: t.refresh_token }))
    return access.token
  } catch (err) {
    if (err.code === 'mangadex.session_expired') { store().deleteSecret(SECRET); access = null }
    throw err
  }
}

function status() {
  const a = savedAuth()
  return { loggedIn: Boolean(a?.refreshToken), user: a ? store().get(USER) || null : null, expiresAt: null, settings: getSettings() }
}

async function signIn(creds = {}) {
  const { auth, user } = await login(creds)
  store().setSecret(SECRET, JSON.stringify(auth))
  store().set(USER, user)
  diagnostics.info(ID, `Sesión iniciada como ${user.username}.`)
  return status()
}

function signOut() {
  store().deleteSecret(SECRET)
  store().set(USER, null)
  access = null
  return true
}

/** fn(token, user, settings). Si MangaDex responde 401, se renueva el token una vez y se repite. */
async function withSession(fn) {
  let token = await accessToken()
  const user = store().get(USER) || {}
  try {
    return await fn(token, user, getSettings())
  } catch (err) {
    if (err.code !== 'mangadex.session_expired') throw err
    token = await accessToken({ force: true })
    return fn(token, user, getSettings())
  }
}

/* ---------- Ajustes de la cuenta: grupos, idioma, términos ----------
   Reglas de MangaDex: al subir se marcan TODOS los grupos que trabajaron el capítulo; quien no tiene
   grupo crea uno con su nombre de usuario; «Not affiliated with any group» solo pueden usarlo el autor
   y los traductores autorizados (noGroup, que hay que confirmar a propósito). */

const MAX_GROUPS = 10 // lo que acepta POST /upload/begin

const cleanGroups = (list) => {
  const seen = new Set()
  return (Array.isArray(list) ? list : [])
    .filter((g) => g && isUuid(g.id) && !seen.has(g.id) && seen.add(g.id))
    .slice(0, MAX_GROUPS)
    .map((g) => ({ id: g.id, name: String(g.name || 'Grupo').slice(0, 200) }))
}

function getSettings() {
  const s = store().get(SETTINGS) || {}
  // La primera beta guardaba un solo grupo en `group`.
  const groups = cleanGroups(s.groups || (s.group ? [s.group] : []))
  return {
    groups,
    noGroup: !groups.length && s.noGroup === true,
    lang: LANGUAGES.some((l) => l.value === s.lang) ? s.lang : DEFAULT_LANG,
    termsAcceptedAt: s.termsAcceptedAt || null,
  }
}

function setSettings({ groups, noGroup, lang, termsAccepted } = {}) {
  const cur = getSettings()
  const nextGroups = Array.isArray(groups) ? cleanGroups(groups) : cur.groups
  const next = {
    groups: nextGroups,
    noGroup: !nextGroups.length && (typeof noGroup === 'boolean' ? noGroup : cur.noGroup),
    lang: LANGUAGES.some((l) => l.value === lang) ? lang : cur.lang,
    termsAcceptedAt: termsAccepted === true ? (cur.termsAcceptedAt || new Date().toISOString()) : termsAccepted === false ? null : cur.termsAcceptedAt,
  }
  store().set(SETTINGS, next)
  return next
}

/**
 * Descriptores inventados en el título («[HQ]», «v2», «(LQ)»…), que las reglas no permiten; solo se
 * aceptan «Censored» y «Uncensored». Devuelve el que encontró, o null.
 */
function titleDescriptor(title) {
  const t = String(title || '')
  const allowed = (s) => /^[\s[\](){}-]*(un)?censored[\s[\](){}-]*$/i.test(s)
  for (const m of t.matchAll(/\[[^\]]*\]|\{[^}]*\}|\((?:hq|lq|hd|raw|mtl|v\s*\d+|ver(?:sión|sion)?\s*\d+)\)/gi)) {
    if (!allowed(m[0])) return m[0]
  }
  const loose = /(?:^|\s)(v\d+|hq|lq|hd)(?=\s|$)/i.exec(t)
  return loose ? loose[1] : null
}

/* ---------- Datos ---------- */

/** Título en el idioma de las traducciones si lo hay; si no, en inglés o el primero. */
function pickTitle(attrs = {}, lang = DEFAULT_LANG) {
  const all = [attrs.title || {}, ...(attrs.altTitles || [])]
  const langs = [lang, lang.split('-')[0], 'es-la', 'es', 'en']
  for (const l of langs) for (const t of all) if (t?.[l]) return t[l]
  const first = Object.values(attrs.title || {})[0]
  return first || 'Sin título'
}

function normWork(m, lang) {
  const a = m.attributes || {}
  const cover = (m.relationships || []).find((r) => r.type === 'cover_art')?.attributes?.fileName
  return {
    id: m.id,
    title: pickTitle(a, lang),
    alternativeTitle: (a.altTitles || []).map((t) => Object.values(t)[0]).filter(Boolean)[0] || null,
    slug: null,
    type: a.originalLanguage === 'ko' ? 'manhwa' : a.originalLanguage === 'zh' || a.originalLanguage === 'zh-hk' ? 'manhua' : 'manga',
    status: a.status || null,
    adult: ['erotica', 'pornographic'].includes(a.contentRating),
    coverUrl: cover ? `https://uploads.mangadex.org/covers/${m.id}/${cover}.256.jpg` : null,
    url: `https://mangadex.org/title/${m.id}`,
    lastChapter: null,
    lastChapterAt: a.updatedAt || null,
    createdAt: a.createdAt || null,
  }
}

function normChapter(c) {
  const a = c.attributes || {}
  const publishAt = a.publishAt || null
  return {
    id: c.id,
    // Un oneshot no tiene número (chapter: null): queda fuera de la numeración.
    number: a.chapter == null || a.chapter === '' ? NaN : Number(a.chapter),
    volumeNumber: a.volume != null && a.volume !== '' && Number.isFinite(Number(a.volume)) ? Number(a.volume) : null,
    title: a.title || '',
    state: publishAt && Date.parse(publishAt) > Date.now() ? 'scheduled' : 'published',
    publishAt,
    pages: a.pages ?? null,
    lang: a.translatedLanguage || null,
    url: `https://mangadex.org/chapter/${c.id}`,
    createdAt: a.createdAt || null,
  }
}

const ratings = CONTENT_RATINGS.map((r) => `contentRating[]=${r}`).join('&')

/** Lista paginada (limit/offset) hasta `max` elementos. */
async function listAll(token, pathWithQuery, { max = 1000, limit = 100, signal } = {}) {
  const out = []
  for (let offset = 0; offset < max; offset += limit) {
    const body = await request({ session: token, path: `${pathWithQuery}&limit=${limit}&offset=${offset}`, signal })
    const data = Array.isArray(body?.data) ? body.data : []
    out.push(...data)
    if (data.length < limit || offset + limit >= (body?.total ?? 0)) break
  }
  return out
}

/** Obras de los grupos elegidos más las agregadas a mano (sin repetir). */
async function listWorks(token, user, signal, settings = getSettings()) {
  const lang = settings.lang
  const added = (store().get(WORKS) || []).filter(isUuid)
  const lists = []
  for (const g of settings.groups) lists.push(listAll(token, `/manga?group=${g.id}&includes[]=cover_art&${ratings}&order[latestUploadedChapter]=desc`, { max: 500, signal }))
  for (let i = 0; i < added.length; i += 100) {
    const ids = added.slice(i, i + 100).map((id) => `ids[]=${id}`).join('&')
    lists.push(listAll(token, `/manga?${ids}&includes[]=cover_art&${ratings}`, { max: 100, signal }))
  }
  const seen = new Set()
  const works = []
  for (const m of (await Promise.all(lists)).flat()) {
    if (!m?.id || seen.has(m.id)) continue
    seen.add(m.id)
    works.push(normWork(m, lang))
  }
  return works
}

/** Capítulos de la obra de los grupos elegidos (o subidos por la cuenta si va sin grupo), en todos los idiomas, cada uno con su lang. */
async function listChapters(token, mangaId, signal, settings = getSettings(), user = store().get(USER) || {}) {
  if (!isUuid(mangaId)) throw new PlatformError('Obra de MangaDex no válida.', 'mangadex.invalid')
  const who = settings.groups.length ? settings.groups.map((g) => `groups[]=${g.id}`).join('&') : user.id ? `uploader=${user.id}` : ''
  const q = `/chapter?manga=${mangaId}${who ? `&${who}` : ''}&${ratings}`
    + '&includeFuturePublishAt=1&includeEmptyPages=1&includeExternalUrl=1&includeFutureUpdates=1&order[chapter]=desc'
  return (await listAll(token, q, { max: 5000, signal }))
    .map(normChapter)
    .filter((c) => Number.isFinite(c.number))
}

/** Búsqueda de obras por título, o una sola si es un enlace o id de MangaDex. */
async function searchManga(token, query, lang = getSettings().lang) {
  const q = String(query || '').trim()
  const id = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(q)?.[1]
  const path = id ? `/manga?ids[]=${id}` : q.length >= 2 ? `/manga?title=${encodeURIComponent(q.slice(0, 120))}&order[relevance]=desc` : null
  if (!path) return []
  const body = await request({ session: token, path: `${path}&includes[]=cover_art&${ratings}&limit=15` })
  return (body?.data || []).map((m) => normWork(m, lang))
}

/** Búsqueda de grupos por nombre, o uno si es un enlace o id. */
async function searchGroups(token, query) {
  const q = String(query || '').trim()
  const id = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(q)?.[1]
  const norm = (g) => ({ id: g.id, name: g.attributes?.name || 'Grupo' })
  if (id) {
    const body = await request({ session: token, path: `/group/${id}` })
    return body?.data ? [norm(body.data)] : []
  }
  if (q.length < 2) return []
  const body = await request({ session: token, path: `/group?name=${encodeURIComponent(q.slice(0, 100))}&limit=15` })
  return (body?.data || []).map(norm)
}

function addWork(id) {
  if (!isUuid(id)) throw new PlatformError('Obra de MangaDex no válida.', 'mangadex.invalid')
  const list = (store().get(WORKS) || []).filter((x) => isUuid(x) && x !== id)
  store().set(WORKS, [id, ...list].slice(0, 300))
  return true
}

function removeWork(id) {
  store().set(WORKS, (store().get(WORKS) || []).filter((x) => x !== id))
  return true
}

/* ---------- Páginas: lo que acepta MangaDex ---------- */

/** Ancho y alto de un JPG, PNG, GIF o WEBP leyendo la cabecera (sin decodificar), o null. */
function imageSize(buf) {
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'GIF') return [buf.readUInt16LE(6), buf.readUInt16LE(8)]
  return require('../works').imageSize(buf)
}

/**
 * ¿Hay que convertir la página para MangaDex? Sí si no es JPG, PNG o GIF, si pesa 20 MB o más, o si
 * mide 10 000 px o más por algún lado (las tiras largas se cortan al convertir).
 */
async function needsConversion(f) {
  if (!ACCEPTED_TYPES.includes(f.type) || f.size >= MAX_FILE_BYTES) return true
  const size = imageSize(await fs.readFile(f.path))
  return !size || size[0] >= MAX_SIDE || size[1] >= MAX_SIDE
}

/** Revisa las páginas ya listas: tipo, peso por página, cantidad y peso total. */
function checkPages(files) {
  if (!files.length) throw new PlatformError('El capítulo no tiene páginas.', 'mangadex.invalid')
  if (files.length > MAX_PAGES) throw new PlatformError(`MangaDex acepta hasta ${MAX_PAGES} imágenes por capítulo (este tiene ${files.length}).`, 'mangadex.too_large', 413)
  const bad = files.find((f) => !ACCEPTED_TYPES.includes(f.type))
  if (bad) throw new PlatformError(`${bad.name}: MangaDex solo acepta JPG, PNG o GIF.`, 'mangadex.invalid')
  const big = files.find((f) => f.size >= MAX_FILE_BYTES)
  if (big) throw new PlatformError(`${big.name} pesa ${Math.round(big.size / 1048576)} MB y MangaDex acepta hasta 20 MB por página.`, 'mangadex.too_large', 413)
  const total = files.reduce((s, f) => s + f.size, 0)
  if (total > MAX_SESSION_BYTES) {
    throw new PlatformError(`El capítulo pesa ${Math.round(total / 1048576)} MB y MangaDex acepta hasta 300 MB por capítulo.`, 'mangadex.too_large', 413)
  }
}

/**
 * Reglas de MangaDex que se revisan antes de subir: hace falta grupo (o «Sin grupo» confirmado por el
 * autor o un traductor autorizado) y el título no lleva descriptores inventados.
 */
function checkChapter(chapter, settings) {
  if (!settings.groups.length && !settings.noGroup) {
    throw new PlatformError('Elige en tu cuenta los grupos que trabajaron el capítulo. Si no tienes grupo, crea en MangaDex uno con tu nombre de usuario. «Sin grupo» es solo para el autor o traductores autorizados.', 'mangadex.no_group', 400)
  }
  const bad = titleDescriptor(chapter.title)
  if (bad) {
    throw new PlatformError(`Quita «${bad}» del título: MangaDex no permite descriptores inventados como «[HQ]» o «v2» (solo «Censored» o «Uncensored»).`, 'mangadex.title', 400)
  }
}

/* ---------- Subida ---------- */

const ownSessions = () => { try { return store().get(OWN_SESSION) || null } catch { return null } }
const setOwnSession = (id) => { try { store().set(OWN_SESSION, id) } catch { /* sin almacén (pruebas) */ } }

/** «2026-11-10T03:00:00» en UTC, como lo pide MangaDex (solo si es una fecha futura). */
function publishAtValue(iso) {
  const t = Date.parse(iso || '')
  if (!Number.isFinite(t) || t <= Date.now()) return null
  return new Date(t).toISOString().slice(0, 19)
}

const numberText = (n) => String(Number(n))

/** Libera la sesión única de subida: si hay una abierta y es nuestra, se abandona; si no, se avisa. */
async function freeUploadSlot(token, signal) {
  let current = null
  try {
    current = await request({ session: token, path: '/upload', signal, quiet: true })
  } catch (err) {
    if (err.status === 404 || err.code === 'mangadex.not_found') return
    throw err
  }
  const id = current?.data?.id
  if (!id) return
  if (id === ownSessions()) {
    await request({ session: token, method: 'DELETE', path: `/upload/${id}`, signal }).catch(() => {})
    setOwnSession(null)
    diagnostics.warn(ID, `Se abandonó una sesión de subida que había quedado abierta (${id}).`)
    return
  }
  throw new PlatformError('Tienes una subida abierta en MangaDex (por ejemplo, en la web). Termínala o cancélala allí y vuelve a intentarlo.', 'mangadex.session_busy', 409)
}

/**
 * Sube el capítulo. files: páginas ya listas para MangaDex [{ path, name, type, size, origin? }]
 * (origin: el índice de la página original, si una tira larga se cortó en varias).
 */
async function uploadChapter(token, { user = {}, settings = getSettings(), workId, chapter, files, signal, onProgress = () => {} }) {
  // token: el access_token o una función que lo da vigente (una subida larga dura más de sus 15 min).
  const tok = async () => (typeof token === 'function' ? token() : token)
  if (!isUuid(workId)) throw new PlatformError('Obra de MangaDex no válida.', 'mangadex.invalid')
  if (!settings.termsAcceptedAt) {
    throw new PlatformError('Antes de subir, acepta las reglas y los términos de MangaDex en tu cuenta (botón de la cuenta, arriba).', 'mangadex.terms', 400)
  }
  checkChapter(chapter, settings)
  checkPages(files)
  // Cada capítulo puede ir en su idioma (un grupo que traduce a varios); si no dice, el de la cuenta.
  const lang = isLang(chapter.lang) ? chapter.lang : settings.lang
  const groups = settings.groups.map((g) => g.id)
  const totalBytes = files.reduce((s, f) => s + f.size, 0)
  const originOf = (i) => files[i].origin ?? i
  onProgress({ phase: 'prepare' })

  // ¿Este capítulo pasará por la revisión del staff? (el primero de cada idioma).
  const review = await request({ session: await tok(), method: 'POST', path: '/upload/check-approval-required', json: { manga: workId, locale: lang }, signal, quiet: true })
    .then((b) => b?.requiresApproval === true, () => false)

  await freeUploadSlot(await tok(), signal)
  const begun = await request({ session: await tok(), method: 'POST', path: '/upload/begin', json: { manga: workId, groups }, signal })
  const sessionId = begun?.data?.id
  if (!sessionId) throw new PlatformError('MangaDex no devolvió la sesión de subida.', 'mangadex.bad_response')
  setOwnSession(sessionId)
  let committed = false

  try {
    const ids = new Array(files.length)
    let doneBytes = 0
    onProgress({ phase: 'upload', doneBytes, totalBytes, done: 0, total: files.length })
    for (let b = 0; b < files.length; b += FILES_PER_REQUEST) {
      if (signal?.aborted) throw cancelled('Subida cancelada.')
      const batch = files.slice(b, b + FILES_PER_REQUEST)
      // Nombres únicos por página para emparejar la respuesta (MangaDex devuelve originalFileName).
      const names = batch.map((f, k) => `${String(b + k + 1).padStart(3, '0')}${path.extname(f.name).toLowerCase() || '.jpg'}`)
      batch.forEach((_, k) => onProgress({ phase: 'file', index: originOf(b + k), status: 'uploading' }))
      const form = multipart(batch.map((f, k) => ({ name: `file${k + 1}`, path: f.path, size: f.size, filename: names[k], type: f.type })))
      let sentInBatch = 0
      const body = await request({
        session: await tok(), method: 'POST', path: `/upload/${sessionId}`, form, signal, retry: true, timeoutMs: 10 * 60e3,
        onBytes: (n) => {
          sentInBatch += n
          onProgress({ phase: 'upload', doneBytes: doneBytes + Math.max(0, sentInBatch), totalBytes, done: b, total: files.length })
        },
      })
      const byName = new Map((body?.data || []).map((d) => [d.attributes?.originalFileName, d.id]))
      const missing = names.findIndex((n) => !byName.has(n))
      if (missing >= 0 || (Array.isArray(body?.errors) && body.errors.length && byName.size < names.length)) {
        const why = errorDetail(body) || 'MangaDex no aceptó el archivo.'
        const at = missing >= 0 ? missing : 0
        onProgress({ phase: 'file', index: originOf(b + at), status: 'error' })
        throw new PlatformError(`Página ${b + at + 1} (${batch[at].name}): ${why}`, 'mangadex.file_rejected', 400)
      }
      names.forEach((n, k) => { ids[b + k] = byName.get(n) })
      doneBytes += batch.reduce((s, f) => s + f.size, 0)
      batch.forEach((_, k) => onProgress({ phase: 'file', index: originOf(b + k), status: 'done' }))
      onProgress({ phase: 'upload', doneBytes, totalBytes, done: Math.min(files.length, b + FILES_PER_REQUEST), total: files.length })
    }
    if (signal?.aborted) throw cancelled('Subida cancelada.')

    onProgress({ phase: 'create' })
    const draft = {
      volume: chapter.volumeNumber != null ? numberText(chapter.volumeNumber) : null,
      chapter: numberText(chapter.number),
      title: chapter.title ? String(chapter.title).trim().slice(0, 255) : null,
      translatedLanguage: lang,
    }
    const at = publishAtValue(chapter.publishAt)
    if (at) draft.publishAt = at
    let created
    try {
      created = await request({ session: await tok(), method: 'POST', path: `/upload/${sessionId}/commit`, json: { chapterDraft: draft, pageOrder: ids, termsAccepted: true }, signal })
      committed = true
    } catch (err) {
      // Si la respuesta se perdió, se mira si el capítulo quedó creado antes de dar un error.
      if (['network', 'timeout'].includes(err.code) || err.status >= 500) {
        const found = await listChapters(await tok(), workId, undefined, settings, user).then((l) => l.find((c) => c.number === Number(chapter.number) && (!c.lang || c.lang === lang))).catch(() => null)
        if (found) {
          committed = true
          diagnostics.warn(ID, `Cap ${chapter.number}: la respuesta se cortó pero el capítulo sí se creó (${found.id}).`)
          created = { data: { id: found.id } }
        }
      }
      if (!committed) throw err
    }
    setOwnSession(null)
    const id = created?.data?.id
    if (!id) throw new PlatformError('MangaDex respondió sin el id del capítulo.', 'mangadex.bad_response')
    onProgress({ phase: 'done' })
    diagnostics.info(ID, `Cap ${chapter.number} → ${workId}: subido (${id})${review ? ', pendiente de revisión' : ''}.`)
    return { id, number: Number(chapter.number), lang, pages: files.length, url: `https://mangadex.org/chapter/${id}`, review, state: at ? 'scheduled' : 'published', publishAt: at ? `${at}Z` : null }
  } catch (err) {
    // La sesión única no debe quedar ocupada: se abandona (los archivos subidos se descartan).
    if (!committed) {
      await tok().then((t) => request({ session: t, method: 'DELETE', path: `/upload/${sessionId}` })).then(() => setOwnSession(null), () => {})
    }
    if (signal?.aborted) throw cancelled('Subida cancelada.')
    throw err
  }
}

const deleteChapter = (token, chapterId) => {
  if (!isUuid(chapterId)) throw new PlatformError('Capítulo de MangaDex no válido.', 'mangadex.invalid')
  return request({ session: token, method: 'DELETE', path: `/chapter/${chapterId}` }).then(() => true)
}

module.exports = {
  ID, LABEL, LANGUAGES, DEFAULT_LANG, RULES_URL, TERMS_URL, MAX_SIDE, MAX_FILE_BYTES, MAX_SESSION_BYTES, MAX_PAGES, ACCEPTED_TYPES,
  setBase: (api, auth) => { base = api || DEFAULT_BASE; authBase = auth || api || DEFAULT_AUTH; access = null },
  isUuid, login, status, signIn, signOut, withSession, accessToken, getSettings, setSettings,
  listWorks, listChapters, searchManga, searchGroups, addWork, removeWork, uploadChapter, deleteChapter,
  isLang, needsConversion, checkPages, checkChapter, titleDescriptor, imageSize, pickTitle, normChapter, publishAtValue, MAX_GROUPS,
}
