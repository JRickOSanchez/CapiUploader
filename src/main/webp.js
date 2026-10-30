/**
 * Convertidor a WebP para Crimson y Mangation (Capibara recibe siempre los archivos originales).
 *
 * Usa el códec de Chromium en una ventana oculta con unos pocos hilos (Web Workers), así no hace falta
 * ninguna librería nativa. Cada página se convierte una sola vez: el resultado queda en una caché en
 * disco (userData/cache/webp, se limpia sola a los 3 días) y lo reutilizan las dos plataformas, los
 * reintentos y las subidas siguientes. La ventana se cierra sola cuando lleva un rato sin trabajo.
 *
 * Reglas: los WebP no se tocan; las páginas que pasan de 16383 px por lado (el máximo de WebP) se
 * reducen lo justo; si el WebP sale más pesado que el original, se guarda igual para Crimson (que
 * solo acepta WebP) y Mangation usa el original.
 */
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const { app, BrowserWindow, ipcMain } = require('electron')
const { prepareCache, cancelled } = require('./util')
const diagnostics = require('./diagnostics')

const QUALITY = 0.9
const COVER = { quality: 0.9, maxWidth: 800 }
const BANNER = { quality: 0.9, maxWidth: 1600 }
const THREADS = Math.max(1, Math.min(3, os.cpus().length - 1))
const IDLE_MS = 60e3
const JOB_TIMEOUT_MS = 90e3
const PROFILE = 'v1' // cambia si cambian los ajustes, para no reutilizar conversiones viejas

let cacheDir = null
let win = null
let ready = null
let idleTimer = null
let seq = 0
const waiting = new Map() // id -> { resolve, reject, timer }
const inFlight = new Map() // clave de caché -> Promise (dos plataformas piden la misma página a la vez)
let active = 0

async function dir() {
  if (!cacheDir) cacheDir = await prepareCache(path.join(app.getPath('userData'), 'cache', 'webp'))
  return cacheDir
}

ipcMain.on('webp:done', (e, id, result) => {
  if (!win || e.sender !== win.webContents) return
  const w = waiting.get(id)
  if (!w) return
  waiting.delete(id)
  clearTimeout(w.timer)
  if (result?.ok) w.resolve(result)
  else w.reject(new Error(result?.error || 'No se pudo convertir la imagen.'))
})

function failAll(message) {
  for (const [id, w] of waiting) { clearTimeout(w.timer); w.reject(new Error(message)); waiting.delete(id) }
}

function openWindow() {
  if (ready) return ready
  win = new BrowserWindow({
    show: false,
    width: 200,
    height: 200,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'converter.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  })
  const w = win
  w.webContents.on('render-process-gone', () => { failAll('El convertidor se cerró inesperadamente.'); close() })
  w.on('closed', () => { if (win === w) { win = null; ready = null } })
  ready = w.loadFile(path.join(__dirname, '..', 'renderer', 'converter.html')).then(() => w)
  ready.catch(() => close())
  return ready
}

function close() {
  clearTimeout(idleTimer)
  const w = win
  win = null
  ready = null
  if (w && !w.isDestroyed()) w.destroy()
}

function armIdle() {
  clearTimeout(idleTimer)
  if (active > 0) return
  idleTimer = setTimeout(close, IDLE_MS)
  idleTimer.unref?.()
}

/** Convierte unos bytes con el códec de Chromium. */
async function encode(bytes, type, opts, signal) {
  if (signal?.aborted) throw cancelled()
  active++
  clearTimeout(idleTimer)
  try {
    const w = await openWindow()
    const id = ++seq
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error('La conversión tardó demasiado.')) }, JOB_TIMEOUT_MS)
      waiting.set(id, { resolve, reject, timer })
      w.webContents.send('webp:job', { id, bytes, type, quality: opts.quality ?? QUALITY, maxWidth: opts.maxWidth || 0, threads: THREADS })
    })
  } finally {
    active--
    armIdle()
  }
}

const webpName = (name) => name.replace(/\.[^.]+$/, '') + '.webp'
const cacheKey = (f, opts) => crypto.createHash('sha1').update(`${PROFILE}|${f.path}|${f.size}|${f.mtime}|${opts.quality ?? QUALITY}|${opts.maxWidth || 0}`).digest('hex')

/**
 * Versión WebP de un archivo { path, name, type, size, mtime }. Devuelve
 * { path, name, type, size, converted, original: { path, name, type, size }, smaller }.
 * smaller: el WebP pesa menos que el original (si no, Mangation sube el original).
 */
async function toWebp(f, opts = {}, signal) {
  const original = { path: f.path, name: f.name, type: f.type, size: f.size }
  if (f.type === 'image/webp') return { ...original, converted: false, original, smaller: true }
  const key = cacheKey(f, opts)
  if (inFlight.has(key)) return inFlight.get(key)
  const job = (async () => {
    const out = path.join(await dir(), `${key}.webp`)
    const hit = await fs.stat(out).catch(() => null)
    if (hit?.size > 0) {
      fs.utimes(out, new Date(), new Date()).catch(() => {}) // que la limpieza no la borre mientras se usa
      return { path: out, name: webpName(f.name), type: 'image/webp', size: hit.size, converted: true, original, smaller: hit.size < f.size }
    }
    const res = await encode(await fs.readFile(f.path), f.type, opts, signal)
    const tmp = `${out}.${process.pid}.tmp`
    await fs.writeFile(tmp, res.bytes)
    await fs.rename(tmp, out)
    if (res.resized) diagnostics.info('webp', `${f.name}: ${res.srcWidth}×${res.srcHeight} px pasa del máximo de WebP; se redujo a ${res.width}×${res.height}.`)
    return { path: out, name: webpName(f.name), type: 'image/webp', size: res.bytes.length, converted: true, original, smaller: res.bytes.length < f.size }
  })()
  inFlight.set(key, job)
  try {
    return await job
  } finally {
    inFlight.delete(key)
  }
}

/**
 * Convierte las páginas de un capítulo (en paralelo, con tope). onFile(i, result) avisa cada una.
 * Si una falla, el error dice cuál.
 */
async function convertAll(files, { signal, onFile = () => {}, opts = {} } = {}) {
  const out = new Array(files.length)
  let next = 0
  const started = Date.now()
  let converted = 0
  await Promise.all(Array.from({ length: Math.min(THREADS + 1, files.length) }, async () => {
    while (next < files.length) {
      if (signal?.aborted) throw cancelled('Subida cancelada.')
      const i = next++
      try {
        out[i] = await toWebp(files[i], opts, signal)
      } catch (err) {
        if (err.code === 'cancelled') throw err
        throw Object.assign(new Error(`No se pudo convertir a WebP la página ${i + 1} (${files[i].name}): ${err.message}`), { code: 'webp.failed' })
      }
      if (out[i].converted) converted++
      onFile(i, out[i])
    }
  }))
  if (converted) {
    const before = files.reduce((s, f) => s + f.size, 0)
    const after = out.reduce((s, f) => s + f.size, 0)
    diagnostics.info('webp', `${converted} páginas a WebP en ${((Date.now() - started) / 1000).toFixed(1)} s (${Math.round(before / 1024)} → ${Math.round(after / 1024)} KB).`)
  }
  return out
}

module.exports = { toWebp, convertAll, close, COVER, BANNER, THREADS }
