/**
 * Actualizaciones desde los releases de GitHub (JRickOSanchez/CapiUploader).
 *
 * - Instalada con el Setup: electron-updater baja el instalador nuevo en segundo plano (comprueba
 *   su sha512 con el latest.yml del release) y lo instala al cerrar la app o al pulsar «Reiniciar y
 *   actualizar».
 * - Portable o .zip: se actualizan en el mismo lugar donde están (ver selfupdate.js). Se baja el
 *   archivo del release en segundo plano, se comprueba su sha256 y se deja listo junto a la app; al
 *   cerrarla (o al pulsar «Reiniciar y actualizar») se cambian los archivos y se conservan los scans
 *   y ajustes, que están en otra carpeta.
 *
 * Si algo de eso no se puede (el release no trae latest.yml o el sha256, la carpeta no deja escribir,
 * falla la descarga), cae al aviso con el enlace del release. En desarrollo no se busca nada.
 */
const path = require('node:path')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const { app } = require('electron')
const diagnostics = require('./diagnostics')
const selfupdate = require('./selfupdate')

const OWNER = 'JRickOSanchez'
const REPO = 'CapiUploader'
const RELEASES_URL = `https://github.com/${OWNER}/${REPO}/releases`
const FIRST_CHECK_MS = 8e3
const CHECK_EVERY_MS = 6 * 3600e3
// Solo en desarrollo: CAPI_UPDATE_TEST=1.3.0 hace como si esta fuera la 1.3.0 del .zip, para probar
// el aviso contra los releases reales. La app empaquetada lo ignora.
const TEST_VERSION = (!app.isPackaged && process.env.CAPI_UPDATE_TEST) || null
const appVersion = () => TEST_VERSION || app.getVersion()
// Solo en desarrollo, para probar la actualización en el lugar sin tocar ninguna app de verdad:
// CAPI_SELFUPDATE_DIR hace de carpeta del .zip y CAPI_SELFUPDATE_PORTABLE de .exe portable. En
// desarrollo nunca se vuelve a abrir nada al terminar.
const DEV_DIR = (!app.isPackaged && process.env.CAPI_SELFUPDATE_DIR) || null
const DEV_PORTABLE = (!app.isPackaged && process.env.CAPI_SELFUPDATE_PORTABLE) || null

let send = () => {}
let autoUpdater = null
let timer = null
// Actualización del .zip o la portable ya preparada: { script, launched }.
let staged = null
// status: idle | checking | none | available | downloading | ready | error
let current = { status: 'idle', kind: installKind(), currentVersion: appVersion() }

/** installed (Setup), portable, zip o dev. */
function installKind() {
  if (!app.isPackaged) return DEV_PORTABLE ? 'portable' : TEST_VERSION || DEV_DIR ? 'zip' : 'dev'
  if (process.env.PORTABLE_EXECUTABLE_FILE) return 'portable'
  const uninstaller = path.join(path.dirname(process.execPath), `Uninstall ${app.getName()}.exe`)
  return fs.existsSync(uninstaller) ? 'installed' : 'zip'
}

/** Lo que se actualiza solo: la carpeta del .zip o el .exe portable. null si no hay (o en desarrollo sin prueba). */
function placeOf(kind) {
  if (kind === 'zip') {
    if (!app.isPackaged) return DEV_DIR ? { appDir: DEV_DIR, exe: path.join(DEV_DIR, 'CapiUploader.exe') } : null
    return { appDir: path.dirname(process.execPath), exe: process.execPath }
  }
  if (kind === 'portable') {
    const file = app.isPackaged ? process.env.PORTABLE_EXECUTABLE_FILE : DEV_PORTABLE
    return file ? { appDir: path.dirname(file), exe: file } : null
  }
  return null
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
  const asset = (re) => {
    const a = r.assets?.find((x) => re.test(x.name))
    return a ? { name: a.name, url: a.browser_download_url, size: a.size, digest: a.digest || null } : null
  }
  const assets = { installed: asset(/Setup.*\.exe$/i), portable: asset(/Portable.*\.exe$/i), zip: asset(/-win\.zip$/i) }
  return {
    version: String(r.tag_name || '').replace(/^v/i, ''),
    name: r.name || r.tag_name,
    url: r.html_url || RELEASES_URL,
    publishedAt: r.published_at || null,
    assets,
    downloads: Object.fromEntries(Object.entries(assets).map(([k, a]) => [k, a?.url || null])),
  }
}

/**
 * .zip o portable: baja la versión nueva, comprueba su sha256 y la deja lista junto a la app.
 * Si no se puede, queda el aviso con el enlace (manualReason dice por qué).
 */
async function prepareSelf(rel) {
  const kind = current.kind
  const place = placeOf(kind)
  const asset = rel.assets[kind]
  const manual = (reason, error = null) => {
    setState({ status: 'available', manual: true, manualReason: reason, error })
    if (error) diagnostics.warn('actualizar', `No se pudo preparar la ${rel.version} para instalarla sola: ${error}`)
  }
  if (!place || !asset) return manual('missing')
  // Si esa misma versión ya falló al cambiar los archivos, no se vuelve a bajar en cada arranque.
  if (current.lastFailure?.version === rel.version) return manual('failed')
  if (!selfupdate.sha256Of(asset.digest)) return manual('no_digest')
  if (!(await selfupdate.canWrite(place.appDir))) return manual('no_write')

  const userData = app.getPath('userData')
  const work = path.join(userData, 'updates')
  const onProgress = ({ done, total }) => setState({ status: 'downloading', percent: total ? Math.min(99, Math.floor((done / total) * 100)) : 0 })
  try {
    setState({ status: 'downloading', percent: 0, phase: 'download' })
    let plan
    if (kind === 'zip') {
      const zip = await selfupdate.download(asset, path.join(work, asset.name), { onProgress })
      setState({ status: 'downloading', percent: 99, phase: 'unpack' })
      const stage = await selfupdate.stageZip(zip, place.appDir, rel.version, path.basename(place.exe))
      await fsp.rm(zip, { force: true }).catch(() => {})
      plan = { kind, appDir: place.appDir, stage, exe: place.exe }
    } else {
      const { final, pending } = selfupdate.portableTarget(place.exe, asset.name)
      await selfupdate.download(asset, pending, { onProgress })
      plan = { kind, appDir: place.appDir, current: place.exe, pending, final }
    }
    Object.assign(plan, {
      // En desarrollo no hay que esperar a que se cierre nada.
      pid: app.isPackaged ? process.pid : 0,
      version: rel.version,
      resultFile: path.join(userData, selfupdate.RESULT_FILE),
      logFile: path.join(userData, 'update-log.txt'),
    })
    staged = { script: await selfupdate.writeScript(plan, path.join(work, 'update.ps1')), launched: false }
    diagnostics.info('actualizar', `La ${rel.version} está lista: se instala al cerrar la app (${kind}).`)
    setState({ status: 'ready', version: rel.version, percent: 100, phase: null, selfUpdate: true })
  } catch (err) {
    manual('error', err?.message || String(err))
  }
}

/** Al abrir: cuenta cómo le fue a la última actualización y borra lo que haya quedado de ella. */
async function afterSelfUpdate() {
  const r = await selfupdate.takeResult(app.getPath('userData'))
  if (r?.ok) diagnostics.info('actualizar', `Se actualizó sola a la ${r.version} (${r.kind}).`)
  else if (r) {
    diagnostics.warn('actualizar', `No se pudo actualizar sola a la ${r.version}: ${r.error}. Se dejó la versión anterior.`)
    setState({ lastFailure: { version: r.version, error: r.error } })
  }
  const place = placeOf(current.kind)
  if (place && current.kind === 'zip') await selfupdate.cleanup(place.appDir)
  if (place && current.kind === 'portable') await selfupdate.cleanupPortable(place.exe)
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
      download: rel.downloads[current.kind] || rel.url, manual: false, manualReason: null, checkedAt: Date.now(), error: null,
    })
    if (current.kind === 'installed') {
      setState({ status: 'downloading', percent: 0 })
      setupAutoUpdater().checkForUpdates().catch((err) => setState({ status: 'available', manual: true, error: err?.message || String(err) }))
    } else {
      // .zip o portable: en segundo plano; el estado avisa cuando esté lista (o si hay que bajarla a mano).
      prepareSelf(rel)
    }
  } catch (err) {
    setState({ status: 'error', error: err?.message || String(err), checkedAt: Date.now() })
    diagnostics.warn('actualizar', 'No se pudo buscar una versión nueva.', err)
  }
  return current
}

/** Cierra la app y la actualiza (Setup: el instalador; .zip y portable: el script); después se vuelve a abrir. */
function install() {
  if (current.status !== 'ready') return false
  if (staged) {
    staged.launched = true
    selfupdate.launch(staged.script, { relaunch: app.isPackaged })
    if (app.isPackaged) setImmediate(() => app.quit())
    return true
  }
  if (!autoUpdater) return false
  setImmediate(() => autoUpdater.quitAndInstall(true, true))
  return true
}

function init(onState) {
  send = onState
  if (current.kind === 'dev') return
  afterSelfUpdate().catch((err) => diagnostics.warn('actualizar', 'No se pudo revisar la última actualización.', err))
  // Como el Setup: si la versión nueva ya está lista, se instala al cerrar la app (sin volver a abrirla).
  app.on('will-quit', () => {
    if (!staged || staged.launched) return
    staged.launched = true
    try { selfupdate.launch(staged.script) } catch (err) { diagnostics.warn('actualizar', 'No se pudo lanzar la actualización al cerrar.', err) }
  })
  setTimeout(() => check(), FIRST_CHECK_MS)
  timer = setInterval(() => check(), CHECK_EVERY_MS)
  timer.unref?.()
}

module.exports = { init, check, install, state: () => current, newer, isPrerelease, RELEASES_URL }
