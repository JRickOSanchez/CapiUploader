/** Tema, ajustes, enlaces externos, actualizaciones y novedades. */
const { app, ipcMain, nativeTheme, shell } = require('electron')
const store = require('../store')
const updater = require('../updater')
const mainWindow = require('../window')
const whatsnew = require('../whatsnew')
const { handle, tasks } = require('./core')

const BUSY = 'Espera a que termine la subida, la descarga o la importación en curso.'

function register() {
  handle('settings:setTheme', async (theme, resolved) => {
    store.set('theme', theme)
    store.set('resolvedTheme', resolved)
    mainWindow.applyTheme(resolved)
    mainWindow.sendAll('theme:changed', { theme, resolved })
    return true
  })

  /** hardwareAcceleration: lo elegido (se aplica al reiniciar); gpu: si esta sesión la está usando. */
  handle('settings:get', async () => ({
    hardwareAcceleration: store.get('hardwareAcceleration') !== false,
    gpu: app.isHardwareAccelerationEnabled(),
    version: app.getVersion(),
    beta: whatsnew.isBeta(),
  }))
  handle('settings:setHardwareAcceleration', async (on) => {
    store.set('hardwareAcceleration', Boolean(on))
    return true
  })
  // Reinicia la app (p. ej. para aplicar la aceleración gráfica), nunca a mitad de un trabajo.
  handle('app:relaunch', async () => {
    if (Object.values(tasks).some((t) => t.busy)) throw new Error(BUSY)
    app.relaunch()
    app.quit()
    return true
  })

  handle('system:prefersDark', async () => nativeTheme.shouldUseDarkColors)
  nativeTheme.on('updated', () => mainWindow.sendAll('system:themeChanged', nativeTheme.shouldUseDarkColors))

  // Solo enlaces https: nunca rutas locales ni otros protocolos.
  handle('shell:open', async (url) => {
    if (/^https:\/\//.test(url)) await shell.openExternal(url)
    return true
  })

  // Ventana «Novedades» (notas del release de la versión instalada) y guía de la versión de prueba.
  handle('whatsnew:open', async () => { whatsnew.open(mainWindow.getWindow()); return true })
  handle('guide:open', async () => { whatsnew.open(mainWindow.getWindow(), { mode: 'guide' }); return true })
  // Reglas de subida de MangaDex (traducidas, incluidas en la app).
  handle('rules:open', async () => { whatsnew.open(mainWindow.getWindow(), { mode: 'rules' }); return true })
  handle('whatsnew:data', async (mode) => whatsnew.data(whatsnew.MODES.includes(mode) ? mode : 'notes'))
  // Cierra solo la ventana que lo pide (pueden estar abiertas las novedades y la guía).
  ipcMain.handle('whatsnew:close', (e) => { whatsnew.close(e.sender); return { ok: true, data: true } })

  handle('update:state', async () => updater.state())
  handle('update:check', async () => updater.check({ manual: true }))
  handle('update:install', async () => updater.install())
}

module.exports = { register }
