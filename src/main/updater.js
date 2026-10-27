/**
 * Actualizaciones desde los releases de GitHub (JRickOSanchez/CapiUploader).
 *
 * - Instalada con el Setup: electron-updater baja el instalador nuevo en segundo plano (comprueba
 *   su sha512 con el latest.yml del release) y lo instala al cerrar la app o al pulsar «Reiniciar y
 *   actualizar».
 * - Portable o .zip: no se pueden reemplazar solas; se avisa y se abre la descarga del release.
 *
 * Si el release no trae latest.yml (o falla la descarga), la versión instalada también cae al aviso
 * con enlace. En desarrollo (sin empaquetar) no se busca nada.
 */
const path = require('node:path')
const fs = require('node:fs')
const { app } = require('electron')

const OWNER = 'JRickOSanchez'
const REPO = 'CapiUploader'
const RELEASES_URL = `https://github.com/${OWNER}/${REPO}/releases`
const FIRST_CHECK_MS = 8e3
const CHECK_EVERY_MS = 6 * 3600e3
// Solo en desarrollo: CAPI_UPDATE_TEST=1.3.0 hace como si esta fuera la 1.3.0 del .zip, para probar
// el aviso contra los releases reales. La app empaquetada lo ignora.
const TEST_VERSION = (!app.isPackaged && process.env.CAPI_UPDATE_TEST) || null
const appVersion = () => TEST_VERSION || app.getVersion()

let send = () => {}
let autoUpdater = null
let timer = null
// status: idle | checking | none | available | downloading | ready | error
let current = { status: 'idle', kind: installKind(), currentVersion: appVersion() }

/** installed (Setup), portable, zip o dev. */
function installKind() {
  if (!app.isPackaged) return TEST_VERSION ? 'zip' : 'dev'
  if (process.env.PORTABLE_EXECUTABLE_FILE) return 'portable'
  const uninstaller = path.join(path.dirname(process.execPath), `Uninstall ${app.getName()}.exe`)
  return fs.existsSync(uninstaller) ? 'installed' : 'zip'
}

function setState(patch) {
  current = { ...current, ...patch }
  send(current)
}

/** «1.10.0» > «1.9.2». Ignora la «v» del tag y lo que vaya tras un guion. */
function newer(a, b) {
  const parse = (v) => String(v).replace(/^v/i, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0)
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0)
  }
  return false
}

/** El último release publicado (no borradores ni prerelease) desde la API pública de GitHub. */
async function latestRelease() {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `CapiUploader/${appVersion()}` },
  })
  if (!res.ok) throw new Error(`GitHub respondió ${res.status}`)
  const r = await res.json()
  const asset = (re) => r.assets?.find((a) => re.test(a.name))?.browser_download_url || null
  return {
    version: String(r.tag_name || '').replace(/^v/i, ''),
    name: r.name || r.tag_name,
    url: r.html_url || RELEASES_URL,
    publishedAt: r.published_at || null,
    downloads: {
      installed: asset(/Setup.*\.exe$/i),
      portable: asset(/Portable.*\.exe$/i),
      zip: asset(/-win\.zip$/i),
    },
  }
}

function setupAutoUpdater() {
  if (autoUpdater) return autoUpdater
  autoUpdater = require('electron-updater').autoUpdater
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null
  autoUpdater.on('download-progress', (p) => setState({ status: 'downloading', percent: Math.round(p.percent || 0) }))
  autoUpdater.on('update-downloaded', (info) => setState({ status: 'ready', version: info.version || current.version, percent: 100 }))
  // El latest.yml del release dice otra versión que el tag: se deja el aviso con el enlace.
  autoUpdater.on('update-not-available', () => {
    if (current.status === 'downloading') setState({ status: 'available', manual: true })
  })
  autoUpdater.on('error', (err) => {
    // Sin latest.yml en el release o sin red: queda el aviso con el enlace de descarga.
    if (current.status === 'downloading' || current.status === 'available') {
      setState({ status: 'available', manual: true, error: err?.message || String(err) })
    }
  })
  return autoUpdater
}

async function check({ manual = false } = {}) {
  if (current.kind === 'dev') {
    setState({ status: 'none', checkedAt: Date.now(), dev: true })
    return current
  }
  // Ya bajada o bajándose: no hace falta volver a preguntar.
  if (current.status === 'ready' || current.status === 'downloading') return current
  setState({ status: 'checking', manual })
  try {
    const rel = await latestRelease()
    if (!rel.version || !newer(rel.version, appVersion())) {
      setState({ status: 'none', checkedAt: Date.now() })
      return current
    }
    setState({
      status: 'available', version: rel.version, name: rel.name, url: rel.url, publishedAt: rel.publishedAt,
      download: rel.downloads[current.kind] || rel.url, manual: current.kind !== 'installed', checkedAt: Date.now(), error: null,
    })
    if (current.kind === 'installed') {
      setState({ status: 'downloading', percent: 0 })
      setupAutoUpdater().checkForUpdates().catch((err) => setState({ status: 'available', manual: true, error: err?.message || String(err) }))
    }
  } catch (err) {
    setState({ status: 'error', error: err?.message || String(err), checkedAt: Date.now() })
  }
  return current
}

/** Cierra la app y corre el instalador ya bajado; al terminar se vuelve a abrir. */
function install() {
  if (current.status !== 'ready' || !autoUpdater) return false
  setImmediate(() => autoUpdater.quitAndInstall(true, true))
  return true
}

function init(onState) {
  send = onState
  if (current.kind === 'dev') return
  setTimeout(() => check(), FIRST_CHECK_MS)
  timer = setInterval(() => check(), CHECK_EVERY_MS)
  timer.unref?.()
}

module.exports = { init, check, install, state: () => current, newer, RELEASES_URL }
