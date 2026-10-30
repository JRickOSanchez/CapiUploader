/**
 * Ventanas de la interfaz: la principal y la de «Importar de web» (la misma interfaz en modo
 * importar, index.html?ventana=importar). Se crean con los colores del tema guardado, abren los
 * enlaces externos en el navegador y no navegan a ningún otro sitio.
 *
 * `send` avisa solo a la principal; `sendAll`, a las dos (progreso de la importación, tema, scan…).
 */
const path = require('node:path')
const { BrowserWindow, nativeTheme, shell } = require('electron')
const store = require('./store')

const BACKGROUND = { dark: '#0a0a0d', light: '#f3f5f8' }
const SYMBOLS = { dark: '#e6e8ef', light: '#1b1e28' }
const RENDERER = path.join(__dirname, '..', 'renderer')

let win = null
let importWin = null

const titleBarColors = (theme) => ({ color: '#00000000', symbolColor: SYMBOLS[theme] || SYMBOLS.light, height: 52 })
const currentTheme = () => store.get('resolvedTheme') || (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
const uiWindows = () => [win, importWin].filter((w) => w && !w.isDestroyed())

/** Ventana con la interfaz de la app (misma preload y mismas reglas de seguridad). */
function appWindow({ width, height, minWidth, minHeight, query }) {
  const theme = currentTheme()
  const w = new BrowserWindow({
    width, height, minWidth, minHeight,
    show: false,
    backgroundColor: BACKGROUND[theme] || BACKGROUND.light,
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarColors(theme),
    icon: path.join(RENDERER, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  w.removeMenu()
  w.loadFile(path.join(RENDERER, 'index.html'), query ? { query } : undefined)
  w.once('ready-to-show', () => w.show())
  // Los enlaces externos se abren en el navegador, nunca dentro de la app.
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  w.webContents.on('will-navigate', (e) => e.preventDefault())
  return w
}

/** La ventana principal. `onClosed` se llama al cerrarla (la app termina con ella). */
function createWindow({ onClosed } = {}) {
  win = appWindow({ width: 1320, height: 860, minWidth: 1040, minHeight: 680 })
  win.on('closed', () => {
    win = null
    if (importWin && !importWin.isDestroyed()) importWin.close()
    onClosed?.()
  })
  return win
}

/** Abre (o enfoca) la ventana «Importar de web». `onClosed` se llama al cerrarla. */
function openImportWindow({ onClosed } = {}) {
  if (importWin && !importWin.isDestroyed()) {
    if (importWin.isMinimized()) importWin.restore()
    importWin.focus()
    return importWin
  }
  importWin = appWindow({ width: 1240, height: 820, minWidth: 980, minHeight: 620, query: { ventana: 'importar' } })
  importWin.on('closed', () => {
    importWin = null
    onClosed?.()
  })
  return importWin
}

const closeImportWindow = () => { if (importWin && !importWin.isDestroyed()) importWin.close() }
const getWindow = () => win

/** Manda un aviso a la ventana principal (si sigue abierta). */
function send(channel, payload) {
  win?.webContents.send(channel, payload)
}

/** Manda un aviso a todas las ventanas de la interfaz. */
function sendAll(channel, payload) {
  for (const w of uiWindows()) w.webContents.send(channel, payload)
}

/** Colores de la barra de título y del fondo de todas las ventanas según el tema elegido. */
function applyTheme(resolved) {
  for (const w of uiWindows()) {
    if (process.platform !== 'darwin') {
      try { w.setTitleBarOverlay(titleBarColors(resolved)) } catch { /* sin overlay */ }
    }
    w.setBackgroundColor(BACKGROUND[resolved] || BACKGROUND.light)
  }
}

/** Enfoca la ventana principal (una segunda instancia, o al recibir capítulos importados). */
function focus() {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.focus()
}

module.exports = { createWindow, openImportWindow, closeImportWindow, getWindow, send, sendAll, applyTheme, focus }
