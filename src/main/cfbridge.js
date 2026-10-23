/**
 * Sitios protegidos por Cloudflare: verificación y peticiones a través del navegador del usuario.
 *
 * Cloudflare ata su cookie de aprobación a la huella de la conexión del navegador que pasó la
 * verificación; Electron no puede imitarla. Por eso, cuando un sitio pide verificación, se abre
 * Chrome, Edge o Brave (perfil temporal, sin tocar el del usuario), el usuario la pasa ahí y ese
 * navegador queda minimizado haciendo de túnel: las peticiones del motor a ese sitio se hacen con
 * `fetch` dentro de una pestaña del propio sitio y la respuesta vuelve a la app.
 *
 * Mientras la verificación está en pantalla solo se leen cookies y títulos a nivel de navegador,
 * sin conectarse a la página: así Cloudflare no detecta nada.
 */
const { app } = require('electron')
const { spawn } = require('node:child_process')
const path = require('node:path')
const fsSync = require('node:fs')
const fs = require('node:fs/promises')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const CHALLENGE_TITLE = /^(just a moment|un momento|attention required|verif)/i
const CONCEALED = /^x-fetchapi-/i
const FORBIDDEN = /^(cookie|user-agent|host|origin|connection|content-length|accept-encoding|sec-|proxy-|keep-alive|transfer-encoding|upgrade|te|trailer|via|expect|date|dnt)/i

function findBrowser() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const local = process.env.LOCALAPPDATA || ''
  const candidates = [
    ['Chrome', path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe')],
    ['Chrome', path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe')],
    ['Chrome', path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')],
    ['Edge', path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
    ['Edge', path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
    ['Brave', path.join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')],
    ['Brave', path.join(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')],
  ]
  for (const [name, exe] of candidates) if (exe && fsSync.existsSync(exe)) return { name, exe }
  return null
}

/** Cliente mínimo del protocolo de depuración del navegador. */
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  let closed = false
  ws.addEventListener('message', (m) => {
    const d = JSON.parse(m.data)
    const p = pending.get(d.id)
    if (p) { pending.delete(d.id); d.error ? p.reject(new Error(d.error.message)) : p.resolve(d.result) }
  })
  ws.addEventListener('close', () => {
    closed = true
    for (const p of pending.values()) p.reject(new Error('Se cerró el navegador.'))
    pending.clear()
  })
  const open = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('No se pudo conectar con el navegador.')), { once: true })
  })
  return {
    ws,
    open,
    get closed() { return closed },
    send: (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      if (closed) return reject(new Error('Se cerró el navegador.'))
      const i = ++id
      pending.set(i, { resolve, reject })
      ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }))
    }),
    close: () => { try { ws.close() } catch {} },
  }
}

/* ---------- El navegador (uno solo, compartido por todos los sitios) ---------- */

let browser = null // { name, child, session, profile }

async function ensureBrowser(firstUrl) {
  if (browser && !browser.session.closed) return { browser, opened: false }
  const found = findBrowser()
  if (!found) throw new Error('No se encontró Chrome, Edge ni Brave en este equipo.')
  const profile = path.join(app.getPath('temp'), `capi-verify-${Date.now().toString(36)}`)
  await fs.mkdir(profile, { recursive: true })
  const child = spawn(found.exe, [
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--new-window',
    firstUrl,
  ], { stdio: 'ignore' })
  let port = null
  for (let t = 0; t < 80 && !port && child.exitCode === null; t++) {
    await sleep(250)
    const txt = await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')
    port = Number(txt.split(/\r?\n/)[0]) || null
  }
  if (!port) { try { child.kill() } catch {} ; throw new Error(`No se pudo abrir ${found.name}.`) }
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
  const session = cdp(version.webSocketDebuggerUrl)
  await session.open
  browser = { name: found.name, child, session, profile }
  // El proceso lanzado puede terminar y dejar Edge abierto en otro proceso: lo que cuenta es la
  // conexión. Al cerrarse el navegador de verdad, se cierra la conexión y se olvidan los túneles.
  session.ws.addEventListener('close', () => {
    if (browser?.session === session) { browser = null; routes.clear() }
    setTimeout(() => fs.rm(profile, { recursive: true, force: true }).catch(() => {}), 3000)
  })
  return { browser, opened: true }
}

/* ---------- Túneles por sitio ---------- */

const routes = new Map() // origin → { targetId, sessionId, windowId }

const hostOf = (u) => new URL(u).hostname.replace(/^www\./, '')
const cookieFor = (host) => (c) => {
  const d = c.domain.replace(/^\./, '')
  return d.endsWith(host) || host.endsWith(d)
}

async function pageTarget(session, url) {
  const { targetInfos } = await session.send('Target.getTargets')
  return targetInfos.find((t) => t.type === 'page' && t.url.startsWith(new URL(url).origin))
    || targetInfos.find((t) => t.type === 'page')
}

/**
 * Abre `url` en el navegador del usuario y espera a que pase la verificación. Después la pestaña
 * queda como túnel para todo el sitio y la ventana se minimiza.
 */
async function verify(url, { timeout = 140e3, onOpen, requireClearance = true, log = () => {} } = {}) {
  const origin = new URL(url).origin
  const host = hostOf(url)
  const { browser: b, opened } = await ensureBrowser(url)
  const { session } = b
  let target
  if (opened) {
    for (let t = 0; t < 20 && !target; t++) { target = await pageTarget(session, url); if (!target) await sleep(250) }
  } else {
    const { targetId } = await session.send('Target.createTarget', { url, newWindow: true })
    target = { targetId }
  }
  if (!target) throw new Error('No se pudo abrir la página en el navegador.')
  const { windowId } = await session.send('Browser.getWindowForTarget', { targetId: target.targetId }).catch(() => ({}))
  if (windowId) await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }).catch(() => {})
  onOpen?.(b.name)

  let lastState = ''
  let approvedAt = 0
  const start = Date.now()
  while (Date.now() - start < timeout) {
    await sleep(1500)
    if (!browser || browser.session.closed) throw new Error('Se cerró el navegador antes de terminar la verificación.')
    const { targetInfos } = await session.send('Target.getTargets')
    const info = targetInfos.find((t) => t.targetId === target.targetId)
    if (!info) throw new Error('Se cerró la pestaña antes de terminar la verificación.')
    const { cookies } = await session.send('Storage.getCookies')
    const passed = !requireClearance || cookies.some((c) => c.name === 'cf_clearance' && cookieFor(host)(c))
    const state = `${info.title} | ${info.url.slice(0, 80)} | aprobación ${passed ? 'sí' : 'no'} | pestañas ${targetInfos.filter((t) => t.type === 'page').length}`
    if (state !== lastState) { log('verificación:', state); lastState = state }
    if (passed && !approvedAt) approvedAt = Date.now()
    // Aprobado pero la página no sale de la verificación: Cloudflare tampoco deja entrar al navegador.
    if (approvedAt && Date.now() - approvedAt > 25e3 && CHALLENGE_TITLE.test(info.title || '')) {
      throw new Error('Cloudflare aprobó la verificación pero no deja entrar al sitio ni siquiera desde el navegador. Este sitio no se puede importar por ahora.')
    }
    if (passed && info.url.startsWith(origin) && !CHALLENGE_TITLE.test(info.title || '')) {
      // Verificado. El túnel usa una pestaña aparte que no navega (robots.txt del sitio): si la
      // página verificada redirige, el navegador cancelaría las peticiones hechas desde ella.
      const work = await quietTab(session, origin)
      routes.set(origin, { ...work, windowId })
      if (windowId) await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } }).catch(() => {})
      return { browser: b.name, origin }
    }
  }
  throw new Error('Se agotó el tiempo para la verificación.')
}

/** Pestaña en segundo plano en `origin/robots.txt`, lista para hacer fetch con las cookies del sitio. */
async function quietTab(session, origin) {
  const { targetId } = await session.send('Target.createTarget', { url: `${origin}/robots.txt`, background: true })
  const { sessionId } = await session.send('Target.attachToTarget', { targetId, flatten: true })
  for (let t = 0; t < 60; t++) {
    const r = await session.send('Runtime.evaluate', { expression: 'location.origin + " " + document.readyState', returnByValue: true }, sessionId).catch(() => null)
    if (r?.result?.value === `${origin} complete`) break
    await sleep(250)
  }
  return { targetId, sessionId }
}

// «img.sitio.com» y «sitio.com» comparten la aprobación de Cloudflare (cookie de «.sitio.com»).
const baseDomain = (h) => h.replace(/^www\./, '').split('.').slice(-2).join('.')

function siblingRoute(origin) {
  const base = baseDomain(new URL(origin).hostname)
  for (const o of routes.keys()) if (baseDomain(new URL(o).hostname) === base) return o
  return null
}

function routed(origin) {
  if (!browser || browser.session.closed) return false
  return routes.has(origin) || (/^https:/.test(origin) && Boolean(siblingRoute(origin)))
}

const opening = new Map()
/** Túnel del origen; para un subdominio de un sitio ya verificado se abre su pestaña la primera vez. */
async function routeFor(origin) {
  if (routes.has(origin)) return routes.get(origin)
  if (!siblingRoute(origin) || !browser) return null
  if (!opening.has(origin)) {
    opening.set(origin, quietTab(browser.session, origin)
      .then((tab) => { routes.set(origin, tab); return tab })
      .finally(() => opening.delete(origin)))
  }
  return opening.get(origin)
}

/**
 * Hace la petición dentro de la pestaña del sitio, con la conexión y las cookies del navegador,
 * y devuelve una Response para Electron.
 */
async function fetchVia(origin, request) {
  const route = await routeFor(origin)
  if (!route || !browser) throw new Error('El túnel del navegador ya no está disponible.')
  const headers = {}
  let referrer
  for (const [name, value] of request.headers) {
    const real = name.replace(CONCEALED, '')
    if (/^referer$/i.test(real)) { referrer = value; continue }
    if (FORBIDDEN.test(real)) continue
    headers[real] = value
  }
  const method = request.method || 'GET'
  const body = /^(GET|HEAD)$/i.test(method) ? null : Buffer.from(await request.arrayBuffer()).toString('base64')
  const init = { method, headers, referrer: referrer && referrer.startsWith(origin) ? referrer : undefined, body }
  const expression = `(async () => {
    const init = ${JSON.stringify(init)};
    const opts = { method: init.method, headers: init.headers, credentials: 'include', redirect: 'follow' };
    if (init.referrer) opts.referrer = init.referrer;
    if (init.body) opts.body = Uint8Array.from(atob(init.body), (c) => c.charCodeAt(0));
    const r = await fetch(${JSON.stringify(request.url)}, opts);
    const bytes = new Uint8Array(await r.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return JSON.stringify({ status: r.status, statusText: r.statusText, url: r.url, headers: [...r.headers], body: btoa(bin) });
  })()`
  let res
  for (let attempt = 0; ; attempt++) {
    res = await browser.session.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, route.sessionId)
    if (!res.exceptionDetails) break
    const message = res.exceptionDetails.exception?.description || 'Falló la petición en el navegador.'
    // «Failed to fetch» suele ser un corte de red pasajero: un reintento.
    if (attempt >= 1 || !/Failed to fetch/i.test(message)) throw new Error(message.split('\n')[0])
    await sleep(800)
  }
  const r = JSON.parse(res.result.value)
  const out = new Headers()
  for (const [n, v] of r.headers) if (!/^(content-encoding|content-length|transfer-encoding)$/i.test(n)) out.append(n, v)
  const status = r.status >= 200 && r.status <= 599 ? r.status : 502
  const nullBody = status === 204 || status === 304 || /^HEAD$/i.test(method)
  return new Response(nullBody ? null : Buffer.from(r.body, 'base64'), { status, statusText: r.statusText, headers: out })
}

function shutdown() {
  if (!browser) return
  const b = browser
  browser = null
  routes.clear()
  b.session.send('Browser.close').catch(() => {}).finally(() => {
    b.session.close()
    setTimeout(() => { if (b.child.exitCode === null) { try { b.child.kill() } catch {} } }, 1500)
  })
}

module.exports = { findBrowser, verify, routed, fetchVia, shutdown, hostOf }
