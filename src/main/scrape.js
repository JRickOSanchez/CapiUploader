/**
 * Motor de «Importar de web»: corre el motor de sitios de HaruNeko (src/scraper/engine.js) en una
 * ventana oculta y le da lo que su aplicación de Electron le daría: peticiones sin CORS con
 * cabeceras como Referer o Cookie, las cookies de la sesión y ventanas de navegador para ejecutar
 * scripts y pasar protecciones como Cloudflare (la ventana se muestra si hay que resolver un captcha).
 *
 * Todo usa una sesión aparte («persist:scrape»): las cookies de esas webs nunca se mezclan con
 * la sesión de la app.
 */
const { app, BrowserWindow, ipcMain, session } = require('electron')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs/promises')
const cfbridge = require('./cfbridge')

const PARTITION = 'persist:scrape'
const CH = {
  init: 'FetchProvider::Initialize',
  cookies: 'FetchProvider::GetSessionCookies',
  domReady: 'RemoteBrowserWindowController::OnDomReady',
  beforeNavigate: 'RemoteBrowserWindowController::OnBeforeNavigate',
  open: 'RemoteBrowserWindowController::OpenWindow',
  close: 'RemoteBrowserWindowController::CloseWindow',
  visibility: 'RemoteBrowserWindowController::SetVisibility',
  exec: 'RemoteBrowserWindowController::ExecuteScript',
  debug: 'RemoteBrowserWindowController::SendDebugCommand',
  load: 'RemoteBrowserWindowController::LoadURL',
}

let ses = null
let host = null
let ready = null
let parentWindow = null
let seq = 0
const pending = new Map() // id → { resolve, reject }
const windows = new Set()

/** User-Agent de Chrome sin las marcas de Electron ni de la app (algunas webs las bloquean). */
function cleanUserAgent() {
  return app.userAgentFallback.replace(/\s(Electron|capi-uploader|CapiUploader)\/\S+/gi, '')
}

/* ---------- Cloudflare ---------- */

async function isCloudflareChallenge(w) {
  try {
    return await w.webContents.executeJavaScript(`Boolean(
      document.querySelector('#challenge-form, #challenge-running, #cf-challenge-running, .cf-turnstile, script[src*="/cdn-cgi/challenge-platform/"]')
      || /^(just a moment|un momento|attention required)/i.test(document.title)
    )`, true)
  } catch {
    return false
  }
}

// Una sola verificación a la vez por sitio (el motor puede abrir varias ventanas seguidas).
const verifying = new Map()

/**
 * Cloudflare no acepta la verificación hecha en Electron: se pasa en el navegador del usuario y,
 * desde ahí, ese navegador hace de túnel para todas las peticiones al sitio (ver cfbridge.js).
 */
async function verifyInBrowser(w) {
  const current = new URL(w.webContents.getURL())
  for (const k of [...current.searchParams.keys()]) if (/^__cf_chl/.test(k)) current.searchParams.delete(k)
  const target = current.href
  const site = current.hostname
  if (!verifying.has(site)) {
    const job = cfbridge.verify(target, {
      log,
      onOpen: (browser) => notify({ status: 'open', site, browser }),
    }).then((res) => {
      log('túnel listo en', res.browser, res.origin)
      notify({ status: 'done', site, browser: res.browser })
      return res
    }).catch((err) => {
      log('verificación fallida', site, err.message)
      notify({ status: 'error', site, error: err.message })
      throw err
    }).finally(() => verifying.delete(site))
    verifying.set(site, job)
  }
  await verifying.get(site)
  if (!tunnelActive) { routeThroughBrowser(); tunnelActive = true }
  verifiedAt.set(site, Date.now())
  if (!w.isDestroyed()) await w.webContents.loadURL(target, { userAgent: cleanUserAgent() }).catch(() => {})
  log('recargada por el túnel', target)
}

// Sitios recién verificados: si vuelven a pedir verificación, no se reabre el navegador sin fin.
const verifiedAt = new Map()
const REVERIFY_MS = 90e3
let tunnelActive = false

/** Las peticiones a sitios con túnel salen del navegador del usuario; el resto, normal. */
function routeThroughBrowser() {
  ses.protocol.handle('https', async (request) => {
    const origin = new URL(request.url).origin
    if (!cfbridge.routed(origin)) return ses.fetch(request, { bypassCustomProtocolHandlers: true })
    try {
      const res = await cfbridge.fetchVia(origin, request)
      if (process.env.CAPI_TUNNEL_TEST) log('túnel', request.method, res.status, request.url.slice(0, 100), [...request.headers.keys()].join(','))
      return res
    } catch (err) {
      log('túnel falló', request.method, request.url.slice(0, 120), err.message, [...request.headers.keys()].join(','))
      return new Response(`Error del túnel: ${err.message}`, { status: 502 })
    }
  })
}

/* ---------- Registro de diagnóstico (sin valores de cookies) ---------- */

let logFile = null
function log(...parts) {
  if (!logFile) logFile = path.join(app.getPath('userData'), 'scrape.log')
  const line = `${new Date().toISOString()} ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`
  fs.appendFile(logFile, line).catch(() => {})
}

function notify(payload) {
  if (parentWindow && !parentWindow.isDestroyed()) parentWindow.webContents.send('import:verify', payload)
}

/* ---------- Cabeceras (como app/electron/src/ipc/FetchProvider.ts de HaruNeko) ---------- */

let concealed = /$^/

function parseCookies(header) {
  return String(header || '').split(';').filter((c) => c.includes('=')).map((c) => {
    const i = c.indexOf('=')
    return { name: c.slice(0, i).trim(), value: c.slice(i + 1).trim() }
  }).filter((c) => c.name && c.value)
}

function mergeCookies(...sets) {
  const all = {}
  for (const set of sets) for (const { name, value } of set) all[name] = value
  return Object.entries(all).map(([n, v]) => `${n}=${v}`).join('; ')
}

function rewriteRequestHeaders(headers) {
  const entries = Object.entries(headers)
  const result = Object.fromEntries(entries.filter(([n]) => !concealed.test(n)).map(([n, v]) => [n.toLowerCase(), v]))
  const replacements = Object.fromEntries(entries.filter(([n]) => concealed.test(n)).map(([n, v]) => [n.replace(concealed, '').toLowerCase(), v]))
  replacements.cookie = mergeCookies(parseCookies(result.cookie), parseCookies(replacements.cookie))
  Object.assign(result, replacements)
  if (!String(result.cookie || '').trim()) delete result.cookie
  // La ventana del motor es un archivo local: no se filtra su origen a las webs.
  if (/^(null|file:)/i.test(String(result.origin || ''))) delete result.origin
  if (/^file:/i.test(String(result.referer || ''))) delete result.referer
  return result
}

function rewriteResponseHeaders(headers) {
  return Object.fromEntries(Object.entries(headers)
    .filter(([n]) => n.toLowerCase() !== 'link')
    .map(([n, v]) => [n, n.toLowerCase() === 'set-cookie'
      // Electron no devuelve cookies «partitioned» al filtrar por URL: se quita la marca.
      ? (Array.isArray(v) ? v.map((c) => c.replace(/partitioned/gi, '')) : String(v).replace(/partitioned/gi, ''))
      : v]))
}

function setupSession() {
  if (ses) return ses
  ses = session.fromPartition(PARTITION)
  ses.setUserAgent(cleanUserAgent())
  ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false))
  ses.on('will-download', (e) => e.preventDefault())
  // Solo se tocan las peticiones del motor. Las de las ventanas de navegador (p. ej. la verificación
  // de Cloudflare) pasan intactas: Cloudflare compara orden y forma de las cabeceras y, si cambian,
  // repite la verificación sin fin.
  const isEngine = (d) => host && !host.isDestroyed() && d.webContentsId === host.webContents.id
  const hasConcealed = (headers) => Object.keys(headers).some((n) => concealed.test(n))
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    if (!isEngine(details) && !hasConcealed(details.requestHeaders)) return cb({ cancel: false })
    cb({ cancel: false, requestHeaders: rewriteRequestHeaders(details.requestHeaders) })
  })
  ses.webRequest.onHeadersReceived((details, cb) => {
    const mitigated = Object.entries(details.responseHeaders || {}).find(([n]) => n.toLowerCase() === 'cf-mitigated')
    if (mitigated) log('cloudflare bloqueó', isEngine(details) ? 'motor' : 'ventana', details.statusCode, details.url.slice(0, 120))
    if (!isEngine(details)) return cb({ cancel: false })
    cb({ cancel: false, responseHeaders: rewriteResponseHeaders(details.responseHeaders || {}) })
  })
  return ses
}

/* ---------- Ventanas de navegador para el motor ---------- */

const fromHost = (e) => host && e.sender === host.webContents
const findWindow = (id) => {
  const w = BrowserWindow.fromId(id)
  if (!w || !windows.has(w)) throw new Error(`No existe la ventana ${id}.`)
  return w
}

async function openWindow(json) {
  const options = JSON.parse(json)
  const prefs = options.webPreferences || {}
  let preloadFile = null
  if (prefs.preload) {
    preloadFile = path.join(os.tmpdir(), `capi-scrape-${Date.now().toString(36)}${Math.random().toString(36).slice(2)}.js`)
    await fs.writeFile(preloadFile, prefs.preload)
  }
  const w = new BrowserWindow({
    show: Boolean(options.show),
    width: options.width || 1280,
    height: options.height || 800,
    center: true,
    title: 'CapiUploader · Verificación del sitio',
    autoHideMenuBar: true,
    parent: undefined,
    webPreferences: {
      session: ses,
      sandbox: true,
      webSecurity: true,
      contextIsolation: false,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: true,
      backgroundThrottling: false,
      disableBlinkFeatures: 'AutomationControlled',
      ...(preloadFile ? { preload: preloadFile } : {}),
    },
  })
  windows.add(w)
  w.setMenuBarVisibility(false)
  // Sin depurador conectado: Cloudflare lo detecta y repite la verificación en bucle.
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  w.webContents.on('dom-ready', () => host?.webContents.send(CH.domReady, w.id))
  w.webContents.on('did-start-navigation', (e) => host?.webContents.send(CH.beforeNavigate, w.id, e.url, e.isMainFrame, e.isSameDocument))
  w.once('closed', () => {
    windows.delete(w)
    if (preloadFile) fs.rm(preloadFile, { force: true }).catch(() => {})
  })
  return w.id
}

function destroyWindow(w) {
  try { if (w.webContents.debugger.isAttached()) w.webContents.debugger.detach() } catch {}
  w.removeAllListeners('close')
  w.destroy()
}

function registerIpc() {
  const on = (channel, fn) => ipcMain.handle(channel, async (e, ...args) => {
    if (!fromHost(e)) throw new Error('No autorizado.')
    return fn(...args)
  })
  on(CH.init, (prefix) => {
    concealed = new RegExp(`^${String(prefix).replace(/[^\w-]/g, '')}`, 'i')
  })
  on(CH.cookies, async (filter) => (await ses.cookies.get(filter || {})).map(({ name, value }) => ({ name, value })))
  on(CH.open, openWindow)
  on(CH.close, (id) => { destroyWindow(findWindow(id)) })
  on(CH.visibility, async (id, show) => {
    const w = findWindow(id)
    // Cloudflare no acepta la verificación hecha en Electron: se hace en el navegador del usuario.
    const challenge = show && await isCloudflareChallenge(w)
    if (show) log('ventana pide mostrarse', w.webContents.getURL(), 'cloudflare', challenge, 'UA', w.webContents.getUserAgent())
    if (challenge && cfbridge.findBrowser()) {
      const site = new URL(w.webContents.getURL()).hostname
      if (Date.now() - (verifiedAt.get(site) || 0) < REVERIFY_MS) {
        // Ya se verificó y el sitio sigue sin aceptar la aprobación: se para aquí en lugar de repetir.
        log('cloudflare no aceptó la aprobación', site)
        notify({ status: 'rejected', site })
        destroyWindow(w)
        return
      }
      try {
        await verifyInBrowser(w)
      } catch {
        // La ventana de Electron no sirve con Cloudflare (repite la verificación sin fin): se cierra
        // y el aviso del error ya llegó a la interfaz.
        verifiedAt.set(site, Date.now())
        if (!w.isDestroyed()) destroyWindow(w)
      }
      return
    }
    if (show) {
      // Hay que resolver un captcha: se muestra delante de la app.
      if (parentWindow && !parentWindow.isDestroyed()) {
        const b = parentWindow.getBounds()
        w.setBounds({ x: b.x + 40, y: b.y + 40, width: Math.min(1100, b.width - 80), height: Math.min(780, b.height - 80) })
      }
      w.show()
      w.focus()
    } else {
      w.hide()
    }
  })
  on(CH.exec, (id, script) => findWindow(id).webContents.executeJavaScript(script, true))
  on(CH.debug, (id, method, params) => {
    const dbg = findWindow(id).webContents.debugger
    if (!dbg.isAttached()) dbg.attach('1.3')
    return dbg.sendCommand(method, params)
  })
  on(CH.load, async (id, url, json) => {
    const options = JSON.parse(json || '{}')
    options.userAgent = cleanUserAgent()
    await findWindow(id).loadURL(url, options).catch((err) => {
      // Las redirecciones y descargas abortadas no son errores para el motor.
      if (!/ERR_ABORTED/.test(err.message)) throw err
    })
  })

  ipcMain.on('scrape:reply', (e, msg) => {
    if (!fromHost(e)) return
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.ok) p.resolve(msg.data)
    else p.reject(Object.assign(new Error(msg.error?.message || 'Error del motor.'), { engine: true }))
  })
}

/* ---------- Ventana del motor ---------- */

function start() {
  if (ready) return ready
  setupSession()
  ready = new Promise((resolve, reject) => {
    host = new BrowserWindow({
      show: false,
      webPreferences: {
        session: ses,
        preload: path.join(__dirname, '..', 'scraper', 'preload.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: false, // el motor pide HTML y JSON a otras webs (sin CORS), como en HaruNeko
        backgroundThrottling: false,
      },
    })
    // Mismo User-Agent que las ventanas de verificación: la cookie de Cloudflare va atada a él.
    host.webContents.setUserAgent(cleanUserAgent())
    host.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    host.webContents.on('will-navigate', (e) => e.preventDefault())
    const onReady = (e, info) => {
      if (!fromHost(e)) return
      ipcMain.removeListener('scrape:ready', onReady)
      resolve(info)
    }
    ipcMain.on('scrape:ready', onReady)
    host.webContents.once('render-process-gone', (_e, d) => {
      const err = new Error(`El motor de importación se cerró (${d.reason}).`)
      for (const p of pending.values()) p.reject(err)
      pending.clear()
      host = null
      ready = null
      reject(err)
    })
    host.loadFile(path.join(__dirname, '..', 'scraper', 'host.html')).catch(reject)
  })
  ready.catch(() => { ready = null })
  return ready
}

/**
 * Solo en desarrollo: CAPI_TUNNEL_TEST=<url> fuerza el túnel para ese sitio (sin Cloudflare), para
 * probar que todas sus peticiones funcionan a través del navegador.
 */
async function tunnelTest() {
  const url = !app.isPackaged && process.env.CAPI_TUNNEL_TEST
  if (!url) return
  await cfbridge.verify(url, { requireClearance: false, timeout: 30e3 })
  if (!tunnelActive) { routeThroughBrowser(); tunnelActive = true }
  log('túnel de prueba listo', url)
}

/** Ejecuta una orden del motor. Con `signal`, cancelarla aborta la petición en el motor. */
let tunnelTested = null
async function call(method, args = [], { signal, timeout = 180e3 } = {}) {
  await start()
  await (tunnelTested ||= tunnelTest().catch((err) => log('túnel de prueba falló', err.message)))
  if (signal?.aborted) throw cancelled()
  const id = ++seq
  return new Promise((resolve, reject) => {
    const done = (fn) => (v) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); fn(v) }
    const onAbort = () => {
      host?.webContents.send('scrape:abort', id)
      pending.delete(id)
      done(reject)(cancelled())
    }
    const timer = setTimeout(() => {
      host?.webContents.send('scrape:abort', id)
      pending.delete(id)
      done(reject)(new Error('El sitio tardó demasiado en responder.'))
    }, timeout)
    signal?.addEventListener('abort', onAbort, { once: true })
    pending.set(id, { resolve: done(resolve), reject: done(reject) })
    host.webContents.send('scrape:cmd', { id, method, args })
  })
}

function cancelled() {
  return Object.assign(new Error('Importación cancelada.'), { code: 'cancelled' })
}

function init(mainWindow) {
  parentWindow = mainWindow
  registerIpc()
}

function setParent(w) { parentWindow = w }

function shutdown() {
  cfbridge.shutdown()
  for (const w of windows) { try { destroyWindow(w) } catch {} }
  if (host && !host.isDestroyed()) host.destroy()
}

module.exports = { init, setParent, start, call, shutdown }
