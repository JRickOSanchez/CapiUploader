/**
 * Red de los lectores propios: GET con reintentos y avisos claros, y una ventana oculta para las webs
 * que arman la página con JavaScript.
 *
 * Todas las peticiones a una web pasan por su turno (politeFetch): como mucho HOST_LIMIT a la vez, y si
 * la web pide calma (429 o 503 con Retry-After) todas esperan juntas en vez de insistir cada una.
 */
const { sleep, withTimeout } = require('../util')
const { hostOf } = require('./html')
const diagnostics = require('../diagnostics')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Safari/537.36'
const PAGE_TIMEOUT = 30e3
const HOST_LIMIT = 4
// Pausa si la web responde 429/503 sin decir cuánto esperar; nunca más de MAX_PAUSE (por debajo del
// tiempo límite de las imágenes, que cuenta también la espera del turno).
const DEFAULT_PAUSE_S = 10
const MAX_PAUSE_S = 60

/* ---------- Turno por sitio ---------- */

const hosts = new Map() // host -> { active, waiting: [], pausedUntil }

function hostState(url) {
  const host = hostOf(url)
  if (!hosts.has(host)) hosts.set(host, { active: 0, waiting: [], pausedUntil: 0 })
  return hosts.get(host)
}

async function takeTurn(st, signal) {
  for (;;) {
    const wait = st.pausedUntil - Date.now()
    if (wait > 0) { await sleep(wait, signal); continue }
    if (st.active < HOST_LIMIT) { st.active++; return }
    await new Promise((resolve) => st.waiting.push(resolve))
  }
}

function leaveTurn(st) {
  st.active--
  st.waiting.shift()?.()
}

/**
 * fetch con turno por sitio. Un 429/503 pausa a todas las peticiones a esa web. `timeout` (opcional)
 * cuenta solo desde que llega el turno, no la espera.
 */
async function politeFetch(url, init = {}, { timeout } = {}) {
  const st = hostState(url)
  await takeTurn(st, init.signal)
  try {
    const res = await fetch(url, timeout ? { ...init, signal: withTimeout(init.signal, timeout) } : init)
    if (res.status === 429 || res.status === 503) {
      const s = Number(res.headers.get('retry-after')) || DEFAULT_PAUSE_S
      st.pausedUntil = Math.max(st.pausedUntil, Date.now() + Math.min(s, MAX_PAUSE_S) * 1000)
      diagnostics.warn('webs', `${hostOf(url)} respondió ${res.status}: pausa de ${Math.min(s, MAX_PAUSE_S)} s para esa web.`)
    }
    return res
  } finally {
    leaveTurn(st)
  }
}

const slowError = (url) => new Error(`${hostOf(url)} tardó demasiado en responder.`)

/** GET con reintentos ante 429, 5xx y fallos de red. Un 403/503 no se reintenta: suele ser Cloudflare. */
async function get(url, { headers = {}, signal, timeout = PAGE_TIMEOUT, tries = 3 } = {}) {
  let last
  for (let a = 0; a < tries; a++) {
    if (signal?.aborted) throw signal.reason || new Error('aborted')
    try {
      const res = await politeFetch(url, { headers: { 'User-Agent': UA, ...headers }, signal }, { timeout })
      if (res.ok) return res
      if (res.status === 403 || res.status === 503) {
        throw Object.assign(new Error(`${hostOf(url)} bloqueó la lectura (${res.status}); puede que pida verificar que eres humano.`), { final: true })
      }
      if (res.status !== 429 && res.status < 500) throw Object.assign(new Error(`${hostOf(url)} respondió ${res.status}.`), { final: true })
      last = new Error(`${hostOf(url)} respondió ${res.status}.`)
    } catch (err) {
      if (err.final || signal?.aborted) throw err
      last = err.name === 'TimeoutError' ? slowError(url) : new Error(`No se pudo conectar con ${hostOf(url)}: ${err.message}`)
    }
    if (a + 1 < tries) await sleep(800 * 2 ** a, signal)
  }
  throw last
}

/** El cuerpo también puede quedarse a medias: el mismo aviso que si no respondiera. */
const readBody = (url, p) => p.catch((err) => { throw err.name === 'TimeoutError' ? slowError(url) : err })

/** HTML de una página. */
async function getText(url, o = {}) {
  const res = await get(url, { ...o, headers: { Accept: 'text/html,*/*', ...o.headers } })
  return readBody(url, res.text())
}

/** JSON de una API, o null si la respuesta no era JSON. */
async function getJson(url, o = {}) {
  const res = await get(url, { ...o, headers: { Accept: 'application/json', ...o.headers } })
  const text = await readBody(url, res.text())
  try { return JSON.parse(text) } catch { return null }
}

/** La promesa o '' si falla (para los intentos de respaldo). */
const quiet = (p) => p.catch(() => '')

/**
 * Abre una página en una ventana oculta (sin sesión ni preload) y devuelve lo que calcule `script`
 * (por defecto, el HTML ya desplazado) cuando aparezca `waitFor`.
 */
async function renderPage(url, { waitFor, timeout = 30e3, script = null } = {}) {
  const { BrowserWindow } = require('electron')
  if (!BrowserWindow) throw new Error('La ventana oculta solo existe dentro de la app.')
  if (!/^https:\/\//.test(url)) throw new Error('URL no permitida.')
  const w = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { partition: 'readers-temp', sandbox: true, contextIsolation: true, nodeIntegration: false, images: false } })
  try {
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    w.webContents.setUserAgent(UA)
    await Promise.race([w.loadURL(url), sleep(timeout)]).catch(() => {})
    const re = waitFor ? new RegExp(waitFor) : null
    const end = Date.now() + timeout
    let out = ''
    while (Date.now() < end) {
      out = await w.webContents.executeJavaScript(script || 'window.scrollTo(0, document.body.scrollHeight); document.documentElement.outerHTML', true).catch(() => '')
      if (!re || re.test(out)) break
      await sleep(800)
    }
    return out
  } finally {
    if (!w.isDestroyed()) w.destroy()
  }
}

module.exports = { UA, politeFetch, get, getText, getJson, quiet, renderPage }
