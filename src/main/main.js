/**
 * Arranque de CapiUploader: carpeta de datos, una sola instancia, canales IPC, ventana principal y
 * los servicios de fondo (PSD, importación, actualizaciones).
 */
const { app, BrowserWindow } = require('electron')
const store = require('./store')
const psd = require('./psd')
const webp = require('./webp')
const scrape = require('./scrape')
const importer = require('./importer')
const updater = require('./updater')
const mainWindow = require('./window')
const diagnostics = require('./diagnostics')
const whatsnew = require('./whatsnew')
const { registerIpc, migrateLegacy } = require('./ipc')

// Solo en desarrollo (sin empaquetar): las pruebas usan su propia carpeta de configuración
// para no tocar nunca la del usuario. La app instalada ignora esta variable.
if (!app.isPackaged && process.env.CAPI_USER_DATA_DIR) app.setPath('userData', process.env.CAPI_USER_DATA_DIR)

// Los ajustes se leen antes de que la app esté lista: la aceleración gráfica solo se puede apagar aquí.
store.init(app.getPath('userData'))
if (store.get('hardwareAcceleration') === false) app.disableHardwareAcceleration()

// Registro de diagnóstico: lo que pasa y lo que falla, también lo que nadie atrapó.
diagnostics.init(app.getPath('userData'))
diagnostics.info('app', `CapiUploader ${app.getVersion()} iniciado (Electron ${process.versions.electron}, ${process.platform} ${process.arch})`)
process.on('uncaughtException', (err) => diagnostics.error('app', `Error no controlado: ${err.message}`, err))
process.on('unhandledRejection', (err) => diagnostics.error('app', `Promesa rechazada sin controlar: ${err?.message || err}`, err))

// Una sola instancia: abrir el acceso directo otra vez enfoca la ventana existente.
if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => mainWindow.focus())

registerIpc()

function openMainWindow() {
  // Las ventanas ocultas del motor de importación no deben mantener viva la app.
  return mainWindow.createWindow({
    onClosed: () => {
      scrape.shutdown()
      if (process.platform !== 'darwin') app.quit()
    },
  })
}

app.whenReady().then(() => {
  const userData = app.getPath('userData')
  psd.init(userData).catch(() => {})
  importer.init(userData).catch(() => {})
  migrateLegacy()
  const win = openMainWindow()
  scrape.init(win)
  whatsnew.showIfUpdated(win)
  updater.init((s) => mainWindow.send('update:state', s))
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openMainWindow()
  })
})

app.on('before-quit', () => {
  scrape.shutdown()
  webp.close()
  diagnostics.flush()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
