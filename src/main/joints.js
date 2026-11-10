/**
 * Joints de Capibara: obras que varios scans llevan juntos. Con la API v1:
 *   - GET /joints y GET /joints/:id: los joints donde el scan es miembro y sus capítulos por número
 *     (cada número trae sus versiones: de qué scan es cada una y cuál ven los lectores);
 *   - POST /joints/:id/chapters: subir un capítulo (líder o uploader; un VIEWER recibe
 *     api.joint_viewer). Si el número ya está en el joint, el capítulo queda en la ficha del scan
 *     como otra versión (quedoEnFicha, ocupadoPor);
 *   - GET /joints/:id/trash: su papelera (30 días);
 *   - POST /joints/:id/versions/show y versions/release: poner la versión propia como la visible de
 *     un número, o soltar esa elección.
 *
 * En la app un joint va en la lista de obras con id «joint:<id>» (las obras usan ids numéricos y
 * podrían repetirse). Sin dependencias de Electron, para poder probarlo.
 */
const api = require('./api')

const PREFIX = 'joint:'
const DETAIL_LIMIT = 200
const ROLE_TEXT = { LEADER: 'Líder', UPLOADER: 'Uploader', VIEWER: 'Solo ver' }

const isJointId = (id) => typeof id === 'string' && /^joint:\d+$/.test(id)
const toWorkId = (jointId) => `${PREFIX}${Number(jointId)}`

/** «joint:4» o 4 → 4 (lanza si no es un joint válido). */
function jointNumber(id) {
  const n = Number(isJointId(id) ? id.slice(PREFIX.length) : id)
  if (!Number.isInteger(n) || n < 1) throw new Error('Joint no válido.')
  return n
}

/** Un joint con la forma de una obra, para el selector de obras. */
function asWork(j) {
  return {
    id: toWorkId(j.id),
    slug: j.slug,
    title: j.title,
    alternativeTitle: j.alternativeTitle ?? null,
    language: j.language,
    type: j.type,
    status: j.status,
    isNsfw: Boolean(j.isNsfw),
    coverUrl: j.coverUrl ?? null,
    bannerUrl: j.bannerUrl ?? null,
    lastChapterAt: j.lastChapterAt ?? null,
    createdAt: j.createdAt ?? null,
    url: j.url ?? null,
    chapters: Number.isInteger(j.chapterCount) ? j.chapterCount : null,
    joint: {
      id: j.id,
      role: j.role,
      roleText: ROLE_TEXT[j.role] || j.role || '',
      canUpload: j.canUpload === true,
      workId: j.workId ?? null,
      memberCount: j.memberCount ?? null,
    },
  }
}

async function list(key, signal) {
  return (await api.requestAll(key, '/joints?limit=50', signal)).map(asWork)
}

/** El joint con todos sus números (la lista de capítulos viene paginada). */
async function detail(key, id, signal) {
  const n = jointNumber(id)
  let page = 1
  let pages = 1
  let data = null
  const chapters = []
  do {
    const res = await api.request(key, 'GET', `/joints/${n}?limit=${DETAIL_LIMIT}&order=desc&page=${page}`, null, signal)
    data = data || res.data
    chapters.push(...(res.data?.chapters || []))
    pages = res.pagination?.pages || 1
    page++
  } while (page <= pages)
  return { ...data, chapters }
}

/** Los números del joint como capítulos (la versión visible, o la propia si no hay visible). */
function asChapters(d) {
  return (d.chapters || []).map((c) => {
    const versions = Array.isArray(c.versions) ? c.versions : []
    const shown = versions.find((v) => v.shown) || versions.find((v) => v.id === c.shownChapterId) || null
    const mine = versions.find((v) => v.mine) || null
    const v = shown || mine || versions[0] || {}
    return {
      id: v.id ?? null,
      number: c.number,
      extra: Boolean(c.extra),
      extraNumber: c.extraNumber ?? null,
      title: v.title || '',
      pages: v.pages ?? null,
      state: v.state || null,
      publishAt: v.publishAt ?? null,
      volumeNumber: v.volumeNumber ?? null,
      url: c.url || v.url || null,
      joint: {
        mine: Boolean(mine),
        mineId: mine?.id ?? null,
        shownScan: shown?.scan?.name || null,
        versions: versions.length,
      },
    }
  })
}

async function chapters(key, id, signal) {
  return asChapters(await detail(key, id, signal))
}

/** Lo que la ventana de un joint muestra: miembros, cada número con sus versiones y lo que se puede hacer. */
function asView(d) {
  return {
    id: d.id,
    workId: toWorkId(d.id),
    title: d.title,
    url: d.url ?? null,
    role: d.role,
    roleText: ROLE_TEXT[d.role] || d.role || '',
    canUpload: d.canUpload === true,
    members: (d.members || []).map((m) => ({ name: m.scan?.name || '', slug: m.scan?.slug || '', role: m.role, roleText: ROLE_TEXT[m.role] || m.role || '' })),
    chapters: (d.chapters || []).map((c) => ({
      number: c.number,
      extra: Boolean(c.extra),
      extraNumber: c.extraNumber ?? null,
      shownChapterId: c.shownChapterId ?? null,
      chosen: c.choice != null,
      canShowMine: c.canShowMine === true,
      canRelease: c.canRelease === true,
      url: c.url ?? null,
      versions: (c.versions || []).map((v) => ({
        id: v.id,
        title: v.title || '',
        pages: v.pages ?? null,
        state: v.state || null,
        location: v.location || null,
        scan: v.scan?.name || '',
        mine: v.mine === true,
        public: v.public !== false,
        shown: v.shown === true,
      })),
    })),
  }
}

async function view(key, id, signal) {
  return asView(await detail(key, id, signal))
}

async function trash(key, id) {
  const d = (await api.request(key, 'GET', `/joints/${jointNumber(id)}/trash`)).data || {}
  return {
    days: d.days ?? 30,
    chapters: (d.chapters || []).map((c) => ({
      id: c.id,
      number: c.number,
      displayNumber: c.displayNumber ?? null,
      title: c.title || '',
      extra: Boolean(c.extra),
      jointChapter: c.jointChapter !== false,
      deletedAt: c.deletedAt ?? null,
      purgeAt: c.purgeAt ?? null,
      restorable: c.restorable !== false,
      reason: c.reason ?? null,
    })),
  }
}

const numberOf = (number) => {
  const n = Number(number)
  if (!Number.isFinite(n) || n < 0) throw new Error('Número de capítulo no válido.')
  return n
}

/** Pone la versión propia (chapterId) como la que ven los lectores en ese número. */
async function showVersion(key, id, number, chapterId) {
  const c = Number(chapterId)
  if (!Number.isInteger(c) || c < 1) throw new Error('Versión no válida.')
  try {
    return (await api.request(key, 'POST', `/joints/${jointNumber(id)}/versions/show`, { number: numberOf(number), chapterId: c })).data
  } catch (err) {
    if (err.code === 'joint_choice.taken' || err.code === 'api.joint_choice_taken') err.message = 'Otro scan ya eligió la versión visible de este número. Tiene que liberarla primero.'
    throw err
  }
}

/** Suelta la elección propia de ese número (otro scan podrá elegir la suya). */
async function releaseVersion(key, id, number) {
  return (await api.request(key, 'POST', `/joints/${jointNumber(id)}/versions/release`, { number: numberOf(number) })).data
}

/** Ruta para crear un capítulo: en un joint o en una obra. */
const chaptersPath = (workId) => (isJointId(workId) ? `/joints/${jointNumber(workId)}/chapters` : `/works/${Number(workId)}/chapters`)

/** El error de un VIEWER, dicho claro. */
function explainUploadError(err) {
  if (err?.code === 'api.joint_viewer') err.message = 'En este joint tu scan solo puede ver: pide al líder el rol de uploader para subir capítulos.'
  return err
}

module.exports = {
  isJointId, toWorkId, jointNumber, asWork, asChapters, asView, list, detail, chapters, view, trash,
  showVersion, releaseVersion, chaptersPath, explainUploadError, ROLE_TEXT,
}
