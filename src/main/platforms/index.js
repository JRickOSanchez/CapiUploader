/**
 * Plataformas a las que se puede subir: Capibara (API key por scan), ScanCrimson y Mangation (sesión
 * con usuario y contraseña) y MangaDex (OAuth con el cliente personal de la cuenta; solo obras que ya
 * existen allí). Aquí está lo que cada una permite (la interfaz oculta lo demás) y la
 * subida a varias a la vez:
 *   - las páginas se leen una vez; la conversión a WebP (solo Crimson y Mangation) se hace una vez y
 *     la comparten; MangaDex recibe JPG, PNG o GIF tal cual y el resto se convierte a JPG (las tiras
 *     de 10 000 px o más se cortan en partes);
 *   - Capibara empieza a subir mientras se convierten las páginas de las otras;
 *   - cada plataforma lleva su propio ritmo y sus reintentos; si una falla, las demás siguen, y al
 *     reintentar solo se vuelve a subir a la que falló;
 *   - antes de subir a una plataforma secundaria se mira (con caché corta) si el capítulo ya estaba.
 */
const api = require('../api')
const joints = require('../joints')
const capibaraUpload = require('../upload')
const crimson = require('./crimson')
const mangation = require('./mangation')
const mangadex = require('./mangadex')
// El convertidor usa Electron: se carga solo cuando hace falta (y las pruebas no lo necesitan).
const webp = () => require('../webp')
const { describeFile } = require('../files')
const diagnostics = require('../diagnostics')
const { pool } = require('../util')

const IDS = ['capibara', 'crimson', 'mangation', 'mangadex']
const LABELS = { capibara: 'Capibara', crimson: 'ScanCrimson', mangation: 'Mangation', mangadex: 'MangaDex' }
const remote = { crimson, mangation, mangadex }
const EXISTING_TTL = 2 * 60e3

const isId = (p) => IDS.includes(p)
const assertId = (p) => { if (!isId(p)) throw new Error('Plataforma no válida.'); return p }

/** Lo que la interfaz necesita saber de Crimson y Mangation (opciones de sus formularios). */
function info() {
  return {
    crimson: { types: crimson.TYPES, statuses: crimson.STATUSES, genres: crimson.GENRES },
    mangation: {
      types: mangation.TYPES, statuses: mangation.STATUSES, demographies: mangation.DEMOGRAPHIES,
      maxGenres: mangation.MAX_GENRES, maxTitle: mangation.MAX_TITLE, maxDescription: mangation.MAX_DESCRIPTION,
      maxCoverBytes: mangation.MAX_COVER_BYTES, maxChapterBytes: mangation.MAX_CHAPTER_BYTES,
    },
    mangadex: { languages: mangadex.LANGUAGES, rulesUrl: mangadex.RULES_URL, termsUrl: mangadex.TERMS_URL },
  }
}

const sessions = () => ({ crimson: crimson.status(), mangation: mangation.status(), mangadex: mangadex.status() })

/* ---------- Lecturas ---------- */

/** Capibara: las obras del scan y, después, los joints donde es miembro (si fallan, solo las obras). */
async function capibaraWorks(key) {
  const [own, shared] = await Promise.all([
    api.requestAll(key, '/works?limit=50'),
    joints.list(key).catch((err) => { diagnostics.warn('joints', `No se pudieron leer los joints: ${err.message}`); return [] }),
  ])
  return [...own, ...shared]
}

async function works(platform, key) {
  if (assertId(platform) === 'capibara') return capibaraWorks(key())
  return remote[platform].withSession((s, user) => remote[platform].listWorks(s, user))
}

async function chapters(platform, workId, key) {
  if (assertId(platform) === 'capibara') {
    if (joints.isJointId(workId)) return joints.chapters(key(), workId)
    return api.requestAll(key(), `/works/${Number(workId)}/chapters?limit=100&order=desc`)
  }
  const list = await remote[platform].withSession((s) => remote[platform].listChapters(s, String(workId)))
  rememberExisting(platform, workId, list)
  return list
}

/* ---------- ¿Ya existe el capítulo? (plataformas secundarias) ---------- */

const existing = new Map() // `${platform}|${workId}` -> { at, chapters: [{ number, lang }] }

function rememberExisting(platform, workId, list) {
  existing.set(`${platform}|${workId}`, { at: Date.now(), chapters: list.map((c) => ({ number: Number(c.number), lang: c.lang || null })) })
}

/** ¿Ya está ese número? lang: solo cuenta en ese idioma (MangaDex: el 12 en español y en inglés son distintos). */
async function alreadyThere(platform, workId, number, signal, lang = null) {
  const k = `${platform}|${workId}`
  let e = existing.get(k)
  if (!e || Date.now() - e.at > EXISTING_TTL) {
    const list = await remote[platform].withSession((s) => remote[platform].listChapters(s, String(workId), signal))
    rememberExisting(platform, workId, list)
    e = existing.get(k)
  }
  return e.chapters.some((c) => c.number === Number(number) && (!lang || !c.lang || c.lang === lang))
}

const markUploaded = (platform, workId, number, lang = null) => existing.get(`${platform}|${workId}`)?.chapters.push({ number: Number(number), lang })

/* ---------- Subida ---------- */

/** Lo que entiende cada plataforma del capítulo (lo que no tiene, se omite). */
function chapterFor(platform, chapter) {
  if (platform === 'capibara') return chapter
  const c = { number: Number(chapter.number), title: chapter.title || null }
  if (platform === 'mangadex') { c.volumeNumber = chapter.volumeNumber ?? null; c.publishAt = chapter.publishAt || null; c.lang = chapter.lang || null }
  if (platform === 'crimson') { c.publishAt = chapter.publishAt || null; c.notify = chapter.notify !== false }
  return c
}

/**
 * Agrega el avance de varias plataformas en eventos con la misma forma que los de una sola, más
 * { phase: 'platform', platform, status, percent } para la línea de cada una.
 */
function progressMixer(targets, count, totalBytes, emit) {
  const multi = targets.length > 1
  const pct = Object.fromEntries(targets.map((t) => [t.platform, 0]))
  const files = Object.fromEntries(targets.map((t) => [t.platform, new Array(count).fill('pending')]))
  const shown = new Array(count).fill(null)
  const stage = {} // plataforma → converting | uploading | done | skipped | error
  let last = 0

  const overall = (force) => {
    const now = Date.now()
    if (!force && now - last < 120) return
    last = now
    const values = Object.values(pct)
    const p = values.reduce((a, b) => a + b, 0) / values.length
    const done = shown.filter((s) => s === 'done').length
    emit({ phase: 'upload', doneBytes: Math.round(p * totalBytes), totalBytes, done, total: count })
  }
  const combine = (i) => {
    const all = targets.map((t) => files[t.platform][i])
    const s = all.includes('error') ? 'error' : all.every((x) => x === 'done') ? 'done' : all.some((x) => x === 'uploading' || x === 'sent') ? 'uploading' : null
    if (s && s !== shown[i]) { shown[i] = s; emit({ phase: 'file', index: i, status: s }) }
  }

  return {
    /** onProgress para una plataforma; convertShare: parte de su barra que corresponde a convertir. */
    for(platform, { convertShare = 0 } = {}) {
      if (!multi) return emit // con una sola plataforma, los eventos pasan tal cual
      return (p) => {
        if (p.phase === 'upload' && p.totalBytes) {
          pct[platform] = convertShare + (1 - convertShare) * Math.min(1, p.doneBytes / p.totalBytes)
          if (multi) emit({ phase: 'platform', platform, status: 'uploading', percent: pct[platform] })
          overall()
        } else if (p.phase === 'file') {
          files[platform][p.index] = p.status === 'sent' ? 'uploading' : p.status
          combine(p.index)
        } else if (p.phase === 'done') {
          pct[platform] = 1
          overall(true)
        } else if (!multi || ['create', 'sign', 'verify', 'prepare'].includes(p.phase)) {
          emit({ ...p, platform })
        }
      }
    },
    converted(platform, done) {
      if (!multi) return emit({ phase: 'convert', done, total: count })
      if (stage[platform] !== 'converting') return // ya terminó, se omitió o aún no le toca
      pct[platform] = Math.max(pct[platform], convertShareOf(platform) * (done / count))
      emit({ phase: 'platform', platform, status: 'converting', percent: pct[platform] })
      overall()
    },
    status(platform, status, extra = {}) {
      if (!multi) return
      stage[platform] = status
      if (status === 'done' || status === 'skipped') {
        pct[platform] = 1
        files[platform].fill('done')
        for (let i = 0; i < count; i++) combine(i)
      }
      emit({ phase: 'platform', platform, status, percent: pct[platform], ...extra })
      overall(true)
    },
  }
}
const CONVERT_SHARE = 0.3

/**
 * Las páginas como las acepta MangaDex: las JPG, PNG o GIF que ya cumplen van tal cual; las demás
 * se convierten a JPG (una tira larga sale en varias partes). origin: índice de la página original.
 */
async function mangadexPages(pages, signal, onFile) {
  const out = new Array(pages.length)
  let done = 0
  await pool(pages.map((_, i) => i), 3, async (i) => {
    const f = pages[i]
    let list
    try {
      list = (await mangadex.needsConversion(f))
        ? await webp().toMangadexParts(f, signal)
        : [{ path: f.path, name: f.name, type: f.type, size: f.size }]
    } catch (err) {
      if (err.code === 'cancelled') throw err
      throw Object.assign(new Error(`No se pudo preparar la página ${i + 1} (${f.name}) para MangaDex: ${err.message}`), { code: 'mangadex.convert_failed' })
    }
    out[i] = list.map((p) => ({ ...p, origin: i }))
    onFile(++done)
  }, signal)
  return out.flat()
}
const convertShareOf = (p) => (p === 'capibara' ? 0 : CONVERT_SHARE)

/**
 * Sube un capítulo a una o varias plataformas.
 * payload: { chapter, files: [{path, single}], targets: [{ platform, workId }] }
 * Con una sola plataforma devuelve su resultado (o lanza su error, igual que antes). Con varias,
 * devuelve { ...resultado de la primera, results: { [plataforma]: { ok, data | error } } } o lanza
 * el error de la primera que falló con `results` (para reintentar solo esas).
 */
async function upload(payload, { key, signal, onProgress = () => {} }) {
  const targets = (Array.isArray(payload.targets) ? payload.targets : []).filter((t) => isId(t?.platform) && t.workId != null)
  if (!targets.length) throw new Error('Elige la obra a la que se sube el capítulo.')
  if (new Set(targets.map((t) => t.platform)).size !== targets.length) throw new Error('Cada plataforma solo puede ir una vez.')
  const entries = (payload.files || []).map((f) => (typeof f === 'string' ? { path: f, single: false } : { path: String(f.path), single: Boolean(f.single) }))
  const chapter = payload.chapter || {}
  const label = `${chapter.extra ? 'Extra' : 'Cap'} ${chapter.number}`

  onProgress({ phase: 'prepare' })
  const pages = await capibaraUpload.readFiles(entries.map((e) => e.path))
  const mixer = progressMixer(targets, entries.length, pages.reduce((n, f) => n + f.size, 0), onProgress)
  let conversion = null
  const converted = () => {
    // Si todas ya son WebP no hace falta abrir el convertidor.
    if (!conversion && pages.every((f) => f.type === 'image/webp')) {
      conversion = Promise.resolve(pages.map((f) => {
        const original = { path: f.path, name: f.name, type: f.type, size: f.size }
        return { ...original, converted: false, original, smaller: true }
      }))
    }
    if (!conversion) {
      let done = 0
      conversion = webp().convertAll(pages, {
        signal,
        onFile: () => { done++; for (const t of targets) if (t.platform !== 'capibara') mixer.converted(t.platform, done) },
      })
    }
    return conversion
  }

  const run = async (t) => {
    const { platform } = t
    const report = mixer.for(platform, { convertShare: convertShareOf(platform) })
    if (platform === 'capibara') {
      mixer.status(platform, 'uploading')
      // Capibara usa ids numéricos; un joint llega como «joint:<id>».
      const workId = joints.isJointId(t.workId) ? t.workId : Number(t.workId)
      const data = await capibaraUpload.uploadChapter(key(), { workId, chapter, files: entries }, { signal, onProgress: report })
      return data
    }
    if (chapter.extra) {
      mixer.status(platform, 'skipped', { reason: 'no tiene extras' })
      return { skipped: true, reason: `${LABELS[platform]} no tiene extras.` }
    }
    if (platform === 'mangadex') {
      return mangadex.withSession(async (_token, user, settings) => {
        const lang = mangadex.isLang(chapter.lang) ? chapter.lang : settings.lang
        if (targets.length > 1 && await alreadyThere(platform, t.workId, chapter.number, signal, lang).catch(() => false)) {
          mixer.status(platform, 'skipped', { reason: 'ya estaba' })
          return { skipped: true, reason: 'Ya estaba subido.', number: Number(chapter.number) }
        }
        mixer.status(platform, 'converting')
        const files = await mangadexPages(pages, signal, (done) => mixer.converted(platform, done))
        mixer.status(platform, 'uploading')
        // La subida pide el token vigente en cada paso: un capítulo grande dura más que sus 15 minutos.
        const data = await mangadex.uploadChapter(() => mangadex.accessToken(), {
          user, settings, workId: String(t.workId), chapter: chapterFor(platform, chapter), files, signal, onProgress: report,
        })
        markUploaded(platform, t.workId, chapter.number, lang)
        return data
      })
    }
    const mod = remote[platform]
    return mod.withSession(async (session, user) => {
      if (targets.length > 1 && await alreadyThere(platform, t.workId, chapter.number, signal).catch(() => false)) {
        diagnostics.info(platform, `${label} ya estaba en la obra ${t.workId}: se omite.`)
        mixer.status(platform, 'skipped', { reason: 'ya estaba' })
        return { skipped: true, reason: 'Ya estaba subido.', number: Number(chapter.number) }
      }
      mixer.status(platform, 'converting')
      const webps = await converted()
      // Crimson solo acepta WebP; Mangation recibe lo que pese menos.
      const files = webps.map((w) => (platform === 'mangation' && !w.smaller ? { ...w.original, converted: false } : w))
      mixer.status(platform, 'uploading')
      const data = await mod.uploadChapter(session, { user, workId: String(t.workId), chapter: chapterFor(platform, chapter), files, signal, onProgress: report })
      markUploaded(platform, t.workId, chapter.number)
      diagnostics.info(platform, `${label} → obra ${t.workId}: subido (id ${data.id}).`)
      return data
    })
  }

  const settled = await Promise.allSettled(targets.map((t) => run(t).then((data) => {
    mixer.status(t.platform, data?.skipped ? 'skipped' : 'done')
    return data
  }, (err) => {
    if (err.code !== 'cancelled') mixer.status(t.platform, 'error', { message: err.message })
    throw err
  })))

  if (targets.length === 1) {
    if (settled[0].status === 'rejected') throw settled[0].reason
    onProgress({ phase: 'done' })
    return settled[0].value
  }

  const results = {}
  settled.forEach((s, i) => {
    const p = targets[i].platform
    results[p] = s.status === 'fulfilled' ? { ok: true, data: s.value } : { ok: false, error: errorInfo(s.reason) }
  })
  const failures = settled.map((s, i) => (s.status === 'rejected' ? { err: s.reason, platform: targets[i].platform } : null)).filter(Boolean)
  if (failures.length) {
    // Si alguna se canceló, se reporta como cancelación; si no, el error que más importa (un límite
    // con espera primero, para que la tanda se pause y siga).
    const pick = failures.find((f) => f.err.code === 'cancelled') || failures.find((f) => f.err.code === 'api.rate_limited') || failures[0]
    const err = pick.err
    if (failures.length < targets.length && err.code !== 'cancelled') err.message = `${LABELS[pick.platform]}: ${err.message}`
    err.platform = pick.platform
    err.results = results
    throw err
  }
  onProgress({ phase: 'done' })
  const first = results[targets[0].platform].data
  return { ...first, results }
}

const errorInfo = (err) => ({ message: err.message, code: err.code || null, status: err.status || null, retryAfter: err.retryAfter ?? null, traceId: err.traceId || null })

/* ---------- Cuenta, obras y capítulos de Crimson y Mangation ---------- */

const remoteOf = (platform) => {
  if (!remote[platform]) throw new Error('Esa plataforma no usa inicio de sesión.')
  return remote[platform]
}

const signIn = (platform, creds) => remoteOf(platform).signIn(creds)
const signOut = (platform) => remoteOf(platform).signOut()

async function createWork(platform, fields, images) {
  if (platform === 'mangadex') throw new Error('En MangaDex solo se sube a obras que ya existen: agrégala desde «Agregar obra».')
  const mod = remoteOf(platform)
  const prepared = {}
  for (const kind of ['cover', 'banner']) {
    const img = images?.[kind]
    if (!img?.path) continue
    const f = await describeFile(img.path)
    if (!f) throw new Error('La imagen de la obra no es válida.')
    // Crimson: portada y banner en WebP, a la medida que usa su panel. Mangation: la imagen tal cual (≤ 5 MB).
    prepared[kind] = platform === 'crimson'
      ? await webp().toWebp(f, kind === 'cover' ? webp().COVER : webp().BANNER)
      : { path: f.path, name: f.name, type: f.type, size: f.size }
  }
  return mod.withSession((s, user) => mod.createWork(s, user, fields, prepared))
}

async function deleteChapter(platform, workId, chapterId) {
  const mod = remoteOf(platform)
  const ok = await mod.withSession((s) => (platform === 'mangation' ? mod.deleteChapter(s, String(workId), chapterId) : mod.deleteChapter(s, chapterId)))
  existing.delete(`${platform}|${workId}`)
  return ok
}

async function renumberChapter(platform, workId, chapterId, number) {
  if (platform !== 'crimson') throw new Error('Esta plataforma no permite cambiar el número desde la app.')
  const ok = await crimson.withSession((s) => crimson.renumberChapter(s, chapterId, number))
  existing.delete(`${platform}|${workId}`)
  return ok
}

const genres = (platform) => (platform === 'mangation' ? mangation.listGenres() : crimson.GENRES.map((name) => ({ id: name, name })))

module.exports = {
  mangadex,
  IDS, LABELS, isId, info, sessions, works, chapters, upload, signIn, signOut, createWork, deleteChapter, renumberChapter, genres,
  _progressMixer: progressMixer,
}
