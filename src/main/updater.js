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
const diagnostics = require('./diagnostics')

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

/** «1.5.0-beta.2» → { core: [1, 5, 0], pre: ['beta', 2] } (pre vacío en una versión final). */
function parseVersion(v) {
  const [core, ...rest] = String(v).replace(/^v/i, '').split('-')
  const pre = rest.join('-')
  return {
    core: core.split('.').map((n) => parseInt(n, 10) || 0),
    pre: pre ? pre.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [],
  }
}

/**
 * ¿a es más nueva que b? «1.10.0» > «1.9.2». Con el mismo número, la final gana a las de prueba
 * («1.5.0» > «1.5.0-beta.3») y entre pruebas cuenta la última parte («beta.2» > «beta.1»).
 */
function newer(a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  for (let i = 0; i < Math.max(x.core.length, y.core.length); i++) {
    if ((x.core[i] || 0) !== (y.core[i] || 0)) return (x.core[i] || 0) > (y.core[i] || 0)
  }
  if (!x.pre.length || !y.pre.length) return !x.pre.length && y.pre.length > 0
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === q) continue
    if (p === undefined) return false
    if (q === undefined) return true
    if (typeof p === 'number' && typeof q === 'number') return p > q
    if (typeof p === 'number') return false
    if (typeof q === 'number') return true
    return String(p) > String(q)
  }
  return false
}

/** ¿Es una versión de prueba? («1.5.0-beta.1») */
const isPrerelease = (v) => parseVersion(v).pre.length > 0

/**
 * El último release publicado desde la API pública de GitHub. Con una versión final instalada solo
 * cuentan los releases finales (los de prueba nunca les llegan); con una de prueba instalada también
 * cuentan los de prueba, para pasar a la siguiente prueba o a la final.
 */
async function latestRelease() {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': `CapiUploader/${appVersion()}` }
  const testing = isPrerelease(appVersion())
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases${testing ? '?per_page=15' : '/latest'}`, { headers })
  if (!res.ok) throw new Error(`GitHub respondió ${res.status}`)
  let r = await res.json()
  if (testing) {
    r = (Array.isArray(r) ? r : []).filter((x) => !x.draft && x.tag_name)
      .reduce((best, x) => (!best || newer(x.tag_name, best.tag_name) ? x : best), null) || {}
  }
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
    diagnostics.warn('actualizar', 'No se pudo buscar una versión nueva.', err)
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

module.exports = { init, check, install, state: () => current, newer, isPrerelease, RELEASES_URL }
