/** Elegir o soltar archivos y carpetas para subir (con el avance de la conversión de PSD). */
const { dialog } = require('electron')
const mainWindow = require('../window')
const { resolvePaths, resolveChapters, IMAGE_EXTS } = require('../files')
const { handle } = require('./core')

const onPsd = (p) => mainWindow.send('psd:progress', p)
const asList = (paths) => (Array.isArray(paths) ? paths.map(String) : [])

function register() {
  handle('files:resolve', async (paths) => resolvePaths(asList(paths), onPsd))
  handle('files:resolveChapters', async (paths) => resolveChapters(asList(paths), onPsd))

  handle('files:pickChapters', async () => {
    const res = await dialog.showOpenDialog(mainWindow.getWindow(), {
      title: 'Selecciona las carpetas de los capítulos',
      properties: ['openDirectory', 'multiSelections'],
    })
    if (res.canceled) return { chapters: [], skipped: [], looseFiles: 0, psd: null }
    return resolveChapters(res.filePaths, onPsd)
  })

  handle('files:pick', async (mode) => {
    const res = await dialog.showOpenDialog(mainWindow.getWindow(), mode === 'folder'
      ? { title: 'Selecciona la carpeta del capítulo', properties: ['openDirectory'] }
      : {
          title: 'Selecciona las páginas del capítulo',
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: 'Imágenes y PSD', extensions: [...IMAGE_EXTS, 'psd', 'psb'] }],
        })
    if (res.canceled) return { files: [], skipped: [], psd: null }
    return resolvePaths(res.filePaths, onPsd)
  })
}

module.exports = { register }
