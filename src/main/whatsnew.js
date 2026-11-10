/**
 * Ventana «Novedades»: muestra las notas del release de la versión instalada, en una ventana aparte
 * para no tapar la interfaz. Se abre sola una vez después de actualizar (no en la primera
 * instalación) y desde «Ajustes → Ver novedades». Las notas se leen de GitHub; sin conexión, la
 * ventana lo dice y ofrece abrir la página del release.
 *
 * La misma ventana tiene otros dos modos, con textos incluidos en la app (src/main/guides, se ven sin
 * conexión):
 *   - «guía»: la guía de la versión de prueba. Con una versión beta instalada se abre cada vez que
 *     arranca la app y desde «Ajustes»;
 *   - «reglas»: las reglas de subida de MangaDex, traducidas. Se abre desde la cuenta de MangaDex, el
 *     recordatorio antes de subir y la guía.
 */
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, nativeTheme, shell } = require('electron')
const store = require('./store')
const diagnostics = require('./diagnostics')
const { releaseNotes } = require('./markdown')
const { newer, isPrerelease, RELEASES_URL } = require('./updater')

const API = 'https://api.github.com/repos/JRickOSanchez/CapiUploader/releases/tags'
const SHOW_DELAY_MS = 1500
const RENDERER = path.join(__dirname, '..', 'renderer')
const BACKGROUND = { dark: '#0a0a0d', light: '#f3f5f8' }

const ISSUES_URL = 'https://github.com/JRickOSanchez/CapiUploader/issues/new/choose'
// Textos incluidos en la app: archivo, título de la ventana, título y enlace del botón de abajo.
const LOCAL = {
  guide: { file: 'beta-mangadex.md', window: 'Guía de la versión de prueba', title: 'Cómo se sube a MangaDex', url: ISSUES_URL, query: 'guia' },
  rules: { file: 'mangadex-rules.md', window: 'Reglas de MangaDex', title: 'Reglas de subida de MangaDex', url: 'https://mangadex.org/rules', query: 'reglas' },
}
const MODES = ['notes', ...Object.keys(LOCAL)]

const windows = {} // modo -> BrowserWindow

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

/** Un texto incluido en la app (guía o reglas), ya convertido a HTML seguro. */
function local(mode) {
  const m = LOCAL[mode]
  const base = { mode, version: app.getVersion(), theme: theme(), title: m.title, url: m.url }
  try {
    return { ...base, html: releaseNotes(fs.readFileSync(path.join(__dirname, 'guides', m.file), 'utf8')) }
  } catch (err) {
    diagnostics.warn('novedades', `No se pudo leer ${m.file}.`, err)
    return { ...base, html: '', error: err.message }
  }
}

/** Lo que pide la ventana al abrirse según su modo. */
async function data(mode) {
  if (LOCAL[mode]) return local(mode)
  const version = app.getVersion()
  try {
    return { version, theme: theme(), ...(await notes(version)) }
  } catch (err) {
    diagnostics.warn('novedades', 'No se pudieron leer las notas del release.', err)
    return { version, theme: theme(), title: `CapiUploader ${version}`, html: '', url: `${RELEASES_URL}/tag/v${version}`, error: err.message }
  }
}

/** Abre (o enfoca) la ventana del modo pedido (novedades, guía o reglas), junto a la principal. */
function open(parent, { mode = 'notes' } = {}) {
  if (!MODES.includes(mode)) mode = 'notes'
  const current = windows[mode]
  if (current && !current.isDestroyed()) { current.focus(); return current }
  const t = theme()
  const m = LOCAL[mode]
  const w = new BrowserWindow({
    width: 640,
    height: 720,
    minWidth: 480,
    minHeight: 420,
    parent: parent || undefined,
    show: false,
    title: m ? m.window : 'Novedades de CapiUploader',
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
  w.removeMenu()
  w.loadFile(path.join(RENDERER, 'whatsnew.html'), m ? { query: { modo: m.query } } : undefined)
  w.once('ready-to-show', () => {
    // Si ya hay otra de estas ventanas abierta, la nueva se corre un poco para no taparla del todo.
    const other = Object.entries(windows).find(([k, x]) => k !== mode && x && !x.isDestroyed() && x.isVisible())?.[1]
    if (other) { const [x, y] = other.getPosition(); w.setPosition(x + 36, y + 36) }
    w.show()
  })
  w.on('closed', () => { if (windows[mode] === w) delete windows[mode] })
  // Los enlaces de las notas se abren en el navegador; la ventana nunca navega a otro sitio.
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  w.webContents.on('will-navigate', (e) => e.preventDefault())
  windows[mode] = w
  return w
}

/** Con una versión de prueba instalada, la guía se abre cada vez que arranca la app. */
function showBetaGuide(parent) {
  if (!isPrerelease(app.getVersion())) return false
  diagnostics.info('novedades', `Versión de prueba ${app.getVersion()}: se muestra la guía.`)
  setTimeout(() => open(parent, { mode: 'guide' }), SHOW_DELAY_MS + 600).unref?.()
  return true
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

/** Cierra la ventana que lo pide (o todas, sin sender). */
function close(sender) {
  for (const w of Object.values(windows)) {
    if (w && !w.isDestroyed() && (!sender || w.webContents === sender)) w.close()
  }
}

const isBeta = () => isPrerelease(app.getVersion())

module.exports = { open, close, data, showIfUpdated, showBetaGuide, isBeta, MODES }
