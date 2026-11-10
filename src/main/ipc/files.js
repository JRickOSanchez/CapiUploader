/** Elegir o soltar archivos, carpetas y comprimidos para subir (con el avance de PSD y comprimidos). */
const { dialog } = require('electron')
const mainWindow = require('../window')
const { resolvePaths, resolveChapters, IMAGE_EXTS, ARCHIVE_EXTS } = require('../files')
const { handle } = require('./core')

const onPsd = (p) => mainWindow.send('psd:progress', p)
const onArchive = (p) => mainWindow.send('archive:progress', p)
const asList = (paths) => (Array.isArray(paths) ? paths.map(String) : [])
const ARCHIVE_FILTER = { name: 'Comprimidos (ZIP, CBZ, RAR, CBR, 7Z, TAR…)', extensions: ARCHIVE_EXTS }

function register() {
  handle('files:resolve', async (paths) => resolvePaths(asList(paths), onPsd, onArchive))
  handle('files:resolveChapters', async (paths) => resolveChapters(asList(paths), onPsd, onArchive))

  // mode 'archives': comprimidos (Windows no deja elegir carpetas y archivos en el mismo cuadro).
  handle('files:pickChapters', async (mode) => {
    const res = await dialog.showOpenDialog(mainWindow.getWindow(), mode === 'archives'
      ? { title: 'Selecciona los comprimidos de los capítulos', properties: ['openFile', 'multiSelections'], filters: [ARCHIVE_FILTER] }
      : { title: 'Selecciona las carpetas de los capítulos', properties: ['openDirectory', 'multiSelections'] })
    if (res.canceled) return { chapters: [], skipped: [], looseFiles: 0, problems: [], psd: null }
    return resolveChapters(res.filePaths, onPsd, onArchive)
  })

  handle('files:pick', async (mode) => {
    const res = await dialog.showOpenDialog(mainWindow.getWindow(), mode === 'folder'
      ? { title: 'Selecciona la carpeta del capítulo', properties: ['openDirectory'] }
      : {
          title: 'Selecciona las páginas del capítulo o un comprimido',
          properties: ['openFile', 'multiSelections'],
          filters: [
            { name: 'Imágenes, PSD y comprimidos', extensions: [...IMAGE_EXTS, 'psd', 'psb', ...ARCHIVE_EXTS] },
            { name: 'Imágenes y PSD', extensions: [...IMAGE_EXTS, 'psd', 'psb'] },
            ARCHIVE_FILTER,
          ],
        })
    if (res.canceled) return { files: [], skipped: [], problems: [], psd: null }
    return resolvePaths(res.filePaths, onPsd, onArchive)
  })
}

module.exports = { register }
