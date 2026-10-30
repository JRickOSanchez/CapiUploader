/**
 * Lectura del scan activo (obras y capítulos), arreglos de capítulos ya subidos y creación de obras.
 * Los arreglos no avisan a nadie, salvo «Publicar ya» con notify; la papelera se restaura 30 días.
 */
const fs = require('node:fs/promises')
const { dialog } = require('electron')
const api = require('../api')
const works = require('../works')
const mainWindow = require('../window')
const { describeFile, MAX_IMAGE_BYTES, IMAGE_EXTS } = require('../files')
const { handle, requireKey } = require('./core')

const chapterPath = (chapterId) => {
  const id = Number(chapterId)
  if (!Number.isInteger(id) || id < 1) throw new Error('Capítulo no válido.')
  return `/chapters/${id}`
}

/** Imagen para la portada o el banner; la interfaz la recorta a la medida exacta antes de crear la obra. */
async function pickWorkImage(kind) {
  const res = await dialog.showOpenDialog(mainWindow.getWindow(), {
    title: kind === 'banner' ? 'Elige el banner de la obra' : 'Elige la portada de la obra',
    properties: ['openFile'],
    filters: [{ name: 'Imágenes', extensions: IMAGE_EXTS }],
  })
  if (res.canceled || !res.filePaths[0]) return null
  const f = await describeFile(res.filePaths[0])
  if (!f) throw new Error('Ese archivo no es una imagen compatible.')
  if (f.size > MAX_IMAGE_BYTES) throw new Error('La imagen pesa más de 40 MB.')
  return { name: f.name, type: f.type, bytes: new Uint8Array(await fs.readFile(f.path)) }
}

function register() {
  handle('api:me', async () => (await api.request(requireKey(), 'GET', '/me')).data)
  handle('api:works', async () => api.requestAll(requireKey(), '/works?limit=50'))
  handle('api:chapters', async (workId) => api.requestAll(requireKey(), `/works/${Number(workId)}/chapters?limit=100&order=desc`))

  handle('chapter:setNumber', async (chapterId, number) => {
    const n = Number(number)
    if (!Number.isFinite(n) || n < 0) throw new Error('Número de capítulo no válido.')
    return (await api.request(requireKey(), 'PATCH', chapterPath(chapterId), { number: n })).data
  })
  handle('chapter:publish', async (chapterId, { notify = true } = {}) =>
    (await api.request(requireKey(), 'POST', `${chapterPath(chapterId)}/publish`, { notify: notify !== false })).data)
  handle('chapter:trash', async (chapterId) => (await api.request(requireKey(), 'DELETE', chapterPath(chapterId))).data)
  handle('chapter:restore', async (chapterId) => (await api.request(requireKey(), 'POST', `${chapterPath(chapterId)}/restore`)).data)

  // Obras nuevas (la clave necesita works:write).
  handle('works:catalog', async () => works.catalog(requireKey()))
  handle('works:searchBase', async (q) => works.searchBase(requireKey(), q))
  handle('works:searchAuthors', async (q) => works.searchAuthors(requireKey(), q))
  handle('works:pickImage', pickWorkImage)
  handle('works:create', async (input) => {
    const res = await works.create(requireKey(), input || {})
    mainWindow.sendAll('works:changed', { id: res.work?.id ?? null })
    return res
  })
}

module.exports = { register }
