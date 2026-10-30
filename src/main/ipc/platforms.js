/**
 * Plataformas: cuál está activa (cambia obras, formularios y tema), sesiones de Crimson y Mangation,
 * sus obras y capítulos, crear obras y arreglar capítulos subidos. Capibara sigue usando sus canales
 * (api:*, chapter:*, works:*); aquí solo se le leen obras y capítulos para la subida a varias.
 */
const { dialog } = require('electron')
const store = require('../store')
const platforms = require('../platforms')
const mainWindow = require('../window')
const { describeFile, MAX_IMAGE_BYTES, IMAGE_EXTS } = require('../files')
const { handle, requireKey, tasks } = require('./core')

// Solo se aceptan imágenes de obra elegidas con el diálogo de la app (no rutas cualesquiera).
const pickedImages = new Set()

const current = () => (platforms.isId(store.get('platform')) ? store.get('platform') : 'capibara')
const sessionsChanged = () => mainWindow.sendAll('platform:sessions', platforms.sessions())

function assertRemote(platform) {
  if (platform !== 'crimson' && platform !== 'mangation') throw new Error('Plataforma no válida.')
  return platform
}

function register() {
  handle('platform:state', async () => ({ active: current(), sessions: platforms.sessions(), info: platforms.info() }))

  handle('platform:setActive', async (platform) => {
    if (!platforms.isId(platform)) throw new Error('Plataforma no válida.')
    if (tasks.upload.busy) throw new Error('Hay una subida en curso: espera a que termine para cambiar de plataforma.')
    store.set('platform', platform)
    mainWindow.sendAll('platform:changed', { active: platform })
    return { active: platform, sessions: platforms.sessions() }
  })

  handle('platform:signIn', async (platform, creds = {}) => {
    const res = await platforms.signIn(assertRemote(platform), { username: String(creds.username || ''), password: String(creds.password || '') })
    sessionsChanged()
    return res
  })
  handle('platform:signOut', async (platform) => {
    if (tasks.upload.busy) throw new Error('Hay una subida en curso: espera a que termine para cerrar la sesión.')
    platforms.signOut(assertRemote(platform))
    sessionsChanged()
    return true
  })

  // Si una petición dice que la sesión venció, la interfaz pide entrar de nuevo.
  const withSessions = (fn) => async (...args) => {
    try {
      return await fn(...args)
    } catch (err) {
      if (/session_expired$/.test(err.code || '')) sessionsChanged()
      throw err
    }
  }

  handle('platform:works', withSessions((platform) => platforms.works(platform, requireKey)))
  handle('platform:chapters', withSessions((platform, workId) => platforms.chapters(platform, workId, requireKey)))
  handle('platform:genres', withSessions((platform) => platforms.genres(assertRemote(platform))))

  handle('platform:pickImage', async (kind) => {
    const res = await dialog.showOpenDialog(mainWindow.getWindow(), {
      title: kind === 'banner' ? 'Elige el banner de la obra' : 'Elige la portada de la obra',
      properties: ['openFile'],
      filters: [{ name: 'Imágenes', extensions: IMAGE_EXTS }],
    })
    if (res.canceled || !res.filePaths[0]) return null
    const f = await describeFile(res.filePaths[0])
    if (!f) throw new Error('Ese archivo no es una imagen compatible.')
    if (f.size > MAX_IMAGE_BYTES) throw new Error('La imagen pesa más de 40 MB.')
    pickedImages.add(f.path)
    return { path: f.path, name: f.name, type: f.type, size: f.size, url: f.url }
  })

  handle('platform:createWork', withSessions(async (platform, fields = {}, images = {}) => {
    const imgs = {}
    for (const kind of ['cover', 'banner']) {
      const p = images?.[kind]?.path
      if (!p) continue
      if (!pickedImages.has(p)) throw new Error('Vuelve a elegir la imagen de la obra.')
      imgs[kind] = { path: p }
    }
    const res = await platforms.createWork(assertRemote(platform), fields, imgs)
    mainWindow.sendAll('works:changed', { id: res.id, platform })
    return res
  }))

  handle('platform:deleteChapter', withSessions((platform, workId, chapterId) =>
    platforms.deleteChapter(assertRemote(platform), String(workId), String(chapterId))))
  handle('platform:renumberChapter', withSessions((platform, workId, chapterId, number) => {
    const n = Number(number)
    if (!Number.isFinite(n) || n < 0) throw new Error('Número de capítulo no válido.')
    return platforms.renumberChapter(assertRemote(platform), String(workId), String(chapterId), n)
  }))
}

module.exports = { register }
