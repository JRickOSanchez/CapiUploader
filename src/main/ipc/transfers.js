/**
 * Trabajos largos: subir un capítulo, descargar capítulos del scan e importar de otra web.
 * Cada uno corre de a uno (tasks) y manda su avance a la interfaz. «Importar de web» vive en su
 * propia ventana: al terminar, entrega los capítulos a la principal («Varios capítulos»).
 */
const path = require('node:path')
const { app, dialog, shell } = require('electron')
const store = require('../store')
const importer = require('../importer')
const mainWindow = require('../window')
const { keepOnly } = require('../upload')
const platforms = require('../platforms')
const { downloadChapters } = require('../download')
const { handle, requireKey, tasks } = require('./core')

const FORMATS = ['original', 'jpg', 'png']
// Solo se abren en el explorador carpetas creadas por una descarga.
const openableDirs = new Set()

const defaultDownloadDir = () => store.get('downloadDir') || path.join(app.getPath('downloads'), 'CapiUploader')

function registerUpload() {
  // payload: { platform, workId, chapter, files, also: [{ platform, workId }] } (also: subir a la vez a otras plataformas).
  handle('chapter:upload', async (payload = {}) => {
    const main = { platform: platforms.isId(payload.platform) ? payload.platform : 'capibara', workId: payload.workId }
    const also = (Array.isArray(payload.also) ? payload.also : []).filter((t) => platforms.isId(t?.platform) && t.platform !== main.platform && t.workId != null)
    return tasks.upload.run((signal) => platforms.upload(
      { chapter: payload.chapter, files: payload.files, targets: [main, ...also] },
      { key: requireKey, signal, onProgress: (p) => mainWindow.send('upload:progress', p) }))
  })
  handle('chapter:cancel', async () => tasks.upload.cancel())
  // Al terminar una tanda: se olvidan las claves subidas salvo las de estos archivos (capítulos por reintentar).
  handle('upload:keepOnly', async (paths) => keepOnly(Array.isArray(paths) ? paths : []))
}

function registerDownload() {
  handle('download:folder', async () => defaultDownloadDir())

  handle('download:pickFolder', async () => {
    const res = await dialog.showOpenDialog(mainWindow.getWindow(), {
      title: 'Carpeta donde guardar los capítulos',
      defaultPath: defaultDownloadDir(),
      properties: ['openDirectory', 'createDirectory'],
    })
    if (res.canceled) return null
    store.set('downloadDir', res.filePaths[0])
    return res.filePaths[0]
  })

  handle('download:start', async ({ work, chapters, dest, format } = {}) => {
    if (!work?.id || !Array.isArray(chapters) || !chapters.length) throw new Error('Elige los capítulos a descargar.')
    const key = requireKey()
    const list = chapters.map((c) => ({
      id: Number(c.id), number: c.number, volumeNumber: c.volumeNumber ?? null, title: c.title || '',
      pages: Number.isInteger(c.pages) ? c.pages : null,
      extra: c.extra === true, extraNumber: c.extra === true && Number.isFinite(Number(c.extraNumber)) ? Number(c.extraNumber) : null,
    })).filter((c) => Number.isInteger(c.id))
    return tasks.download.run(async (signal) => {
      const summary = await downloadChapters({
        key,
        work: { id: Number(work.id), title: String(work.title || '') },
        chapters: list,
        dest: typeof dest === 'string' && path.isAbsolute(dest) ? dest : defaultDownloadDir(),
        format: FORMATS.includes(format) ? format : 'jpg',
        signal,
        onProgress: (p) => {
          if (p.dir) openableDirs.add(p.dir)
          mainWindow.send('download:progress', p)
        },
      })
      openableDirs.add(summary.workDir)
      return summary
    })
  })

  handle('download:cancel', async () => tasks.download.cancel())

  handle('download:open', async (dir) => {
    if (!openableDirs.has(dir)) throw new Error('Carpeta no disponible.')
    const err = await shell.openPath(dir)
    if (err) throw new Error(err)
    return true
  })
}

function registerImport() {
  // Si se cierra la ventana a mitad de una importación, la importación se cancela.
  handle('import:openWindow', async () => { mainWindow.openImportWindow({ onClosed: () => tasks.import.cancel() }); return true })
  handle('import:closeWindow', async () => { mainWindow.closeImportWindow(); return true })
  /** Capítulos ya bajados: la ventana principal los agrega a «Varios capítulos» para revisarlos. */
  handle('import:handoff', async (payload) => {
    const dirs = Array.isArray(payload?.dirs) ? payload.dirs.map(String) : []
    if (!dirs.length) throw new Error('No hay capítulos que pasar a «Varios capítulos».')
    mainWindow.send('import:handoff', {
      dirs,
      // Capibara usa ids numéricos; Crimson y Mangation, texto.
      workId: typeof payload.workId === 'number' ? payload.workId : String(payload.workId ?? ''),
      interval: Math.max(0, Math.floor(Number(payload.interval) || 0)),
      unit: ['minutes', 'hours', 'days'].includes(payload.unit) ? payload.unit : 'minutes',
    })
    mainWindow.focus()
    return true
  })

  handle('import:identify', async (url) => importer.identify(url))
  handle('import:open', async (url, websiteId) => importer.open(url, websiteId))

  handle('import:download', async ({ key, workTitle, chapters } = {}) => {
    if (!key || !Array.isArray(chapters) || !chapters.length) throw new Error('Elige los capítulos a importar.')
    if (tasks.upload.busy) throw new Error('Hay una subida en curso: espera a que termine para importar más capítulos.')
    return tasks.import.run((signal) => importer.download({
      key: String(key),
      workTitle: String(workTitle || ''),
      chapters: chapters.map((c) => ({
        index: Number(c.index), number: c.number, volumeNumber: c.volumeNumber ?? null, title: String(c.title || '').slice(0, 256),
      })).filter((c) => Number.isInteger(c.index) && c.number != null),
      signal,
      onProgress: (p) => mainWindow.sendAll('import:progress', p),
    }))
  })

  handle('import:cancel', async () => tasks.import.cancel())
  handle('import:release', async (key) => importer.release(String(key)))
}

function register() {
  registerUpload()
  registerDownload()
  registerImport()
}

module.exports = { register }
