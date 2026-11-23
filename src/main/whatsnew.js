/**
 * Ventana «Novedades»: muestra las notas del release de la versión instalada, en una ventana aparte
 * para no tapar la interfaz. Se abre sola una vez después de actualizar (no en la primera
 * instalación) y desde «Ajustes → Ver novedades». Las notas se leen de GitHub; sin conexión, la
 * ventana lo dice y ofrece abrir la página del release.
 */
const path = require('node:path')
const { app, BrowserWindow, nativeTheme, shell } = require('electron')
const store = require('./store')
const diagnostics = require('./diagnostics')
const { releaseNotes } = require('./markdown')
const { newer, RELEASES_URL } = require('./updater')

const API = 'https://api.github.com/repos/JRickOSanchez/CapiUploader/releases/tags'
const SHOW_DELAY_MS = 1500
const RENDERER = path.join(__dirname, '..', 'renderer')
const BACKGROUND = { dark: '#0a0a0d', light: '#f3f5f8' }

let win = null

const theme = () => store.get('resolvedTheme') || (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')

/** Notas del release de `version` (se prueba con «v» y sin ella), ya convertidas a HTML seguro. */
async function notes(version) {
  for (const tag of [`v${version}`, version]) {
    const res = await fetch(`${API}/${encodeURIComponent(tag)}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `CapiUploader/${version}` },
      signal: AbortSignal.timeout(10e3),
    })
    if (res.status === 404) continue
    if (!res.ok) throw new Error(`GitHub respondió ${res.status}.`)
    const r = await res.json()
    return { title: r.name || `CapiUploader ${version}`, html: releaseNotes(r.body), url: r.html_url, publishedAt: r.published_at }
  }
  return { title: `CapiUploader ${version}`, html: '', url: `${RELEASES_URL}/tag/v${version}`, publishedAt: null, missing: true }
}

/** Lo que pide la ventana al abrirse. */
async function data() {
  const version = app.getVersion()
  try {
    return { version, theme: theme(), ...(await notes(version)) }
  } catch (err) {
    diagnostics.warn('novedades', 'No se pudieron leer las notas del release.', err)
    return { version, theme: theme(), title: `CapiUploader ${version}`, html: '', url: `${RELEASES_URL}/tag/v${version}`, error: err.message }
  }
}

/** Abre (o enfoca) la ventana de novedades, junto a la principal. */
function open(parent) {
  if (win && !win.isDestroyed()) { win.focus(); return win }
  const t = theme()
  win = new BrowserWindow({
    width: 640,
    height: 720,
    minWidth: 480,
    minHeight: 420,
    parent: parent || undefined,
    show: false,
    title: 'Novedades de CapiUploader',
    backgroundColor: BACKGROUND[t] || BACKGROUND.light,
    autoHideMenuBar: true,
    icon: path.join(RENDERER, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'whatsnew.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.removeMenu()
  win.loadFile(path.join(RENDERER, 'whatsnew.html'))
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => { win = null })
  // Los enlaces de las notas se abren en el navegador; la ventana nunca navega a otro sitio.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  return win
}

/**
 * Al arrancar: si la versión cambió desde la última vez (una actualización, no la primera
 * instalación), abre las novedades. En desarrollo, CAPI_WHATSNEW_TEST=1 la abre siempre.
 */
function showIfUpdated(parent) {
  const current = app.getVersion()
  const last = store.get('lastVersionSeen')
  if (last !== current) store.set('lastVersionSeen', current)
  const forced = !app.isPackaged && process.env.CAPI_WHATSNEW_TEST === '1'
  if (!forced && !(last && newer(current, last))) return false
  diagnostics.info('novedades', `Actualizada de ${last || '¿?'} a ${current}: se muestran las novedades.`)
  setTimeout(() => open(parent), SHOW_DELAY_MS).unref?.()
  return true
}

const close = () => { if (win && !win.isDestroyed()) win.close() }

module.exports = { open, close, data, showIfUpdated }
