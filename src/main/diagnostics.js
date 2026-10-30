/**
 * Registro de diagnóstico: qué hizo la app y qué falló, para resolver problemas sin adivinar.
 *
 * - En memoria se guardan las últimas MAX_ENTRIES entradas (lo que muestra «Ajustes → Diagnóstico»).
 * - En disco, userData/logs/capiuploader.log: se escribe en tandas (cada FLUSH_MS) y, al pasar de
 *   MAX_FILE_BYTES, el archivo pasa a capiuploader.old.log y se empieza otro. Nunca crece sin límite.
 * - Todo se limpia antes de guardarse: API keys, tokens, cookies y firmas de URLs nunca quedan escritas.
 *
 * Sin Electron: antes de init() solo se guarda en memoria (así lo usan las pruebas).
 */
const fs = require('node:fs')
const path = require('node:path')

const MAX_ENTRIES = 500
const MAX_DETAIL = 600
const MAX_FILE_BYTES = 1024 * 1024
const FLUSH_MS = 2000
const LEVELS = ['info', 'warn', 'error']

const entries = []
let file = null
let fileSize = 0
let buffer = []
let flushTimer = null

/* ---------- Limpieza de datos sensibles ---------- */

const SECRETS = [
  [/capi_[A-Za-z0-9]{6,}/g, 'capi_…'],
  [/\bBearer\s+[\w.~+/=-]+/gi, 'Bearer …'],
  // Firmas y tokens en URLs (subidas firmadas, CDNs): la dirección queda, la firma no.
  [/([?&](?:x-amz-[\w-]+|signature|sig|token|access_token|key|expires|policy|key-pair-id)=)[^&\s"'<>]+/gi, '$1…'],
  [/((?:cookie|set-cookie|authorization|x-api-key|password|contrase(?:ñ|n)a|token)"?\s*[:=]\s*)"?[^"',;\s}]+/gi, '$1…'],
]

/** Texto sin claves, tokens ni firmas. */
function redact(text) {
  let s = String(text ?? '')
  for (const [re, by] of SECRETS) s = s.replace(re, by)
  return s
}

function detailText(detail) {
  if (detail === undefined || detail === null || detail === '') return ''
  let s
  if (detail instanceof Error) s = detail.stack || detail.message
  else if (typeof detail === 'string') s = detail
  else { try { s = JSON.stringify(detail) } catch { s = String(detail) } }
  s = redact(s)
  return s.length > MAX_DETAIL ? `${s.slice(0, MAX_DETAIL)}… (${s.length} caracteres)` : s
}

/* ---------- Registro ---------- */

/** level: info | warn | error; area: api, subida, importar, motor, descargar, app… */
function log(level, area, message, detail) {
  if (!LEVELS.includes(level)) level = 'info'
  const entry = { at: Date.now(), level, area: String(area || 'app'), message: redact(message), detail: detailText(detail) }
  entries.push(entry)
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
  if (file) queue(format(entry))
  return entry
}

const info = (area, message, detail) => log('info', area, message, detail)
const warn = (area, message, detail) => log('warn', area, message, detail)
const error = (area, message, detail) => log('error', area, message, detail)

const LEVEL_TAG = { info: 'INFO ', warn: 'AVISO', error: 'ERROR' }
/** «2026-10-29 21:05:43», en la hora del equipo (la misma que muestra la ventana). */
function localTime(at) {
  const d = new Date(at)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function format(e) {
  const when = localTime(e.at)
  return `${when} ${LEVEL_TAG[e.level]} [${e.area}] ${e.message}${e.detail ? `\n    ${e.detail.replace(/\n/g, '\n    ')}` : ''}`
}

/** Entradas en memoria (de la más vieja a la más nueva). minLevel: 'warn' deja solo avisos y errores. */
function list({ minLevel = 'info', limit = MAX_ENTRIES } = {}) {
  const min = LEVELS.indexOf(minLevel)
  return entries.filter((e) => LEVELS.indexOf(e.level) >= min).slice(-limit)
}

/** El registro como texto, para copiarlo. */
const text = (opts) => list(opts).map(format).join('\n')

function clear() {
  entries.length = 0
}

/* ---------- Archivo ---------- */

function queue(line) {
  buffer.push(`${line}\n`)
  if (!flushTimer) {
    flushTimer = setTimeout(() => { flushTimer = null; flush() }, FLUSH_MS)
    flushTimer.unref?.()
  }
}

/** Escribe lo pendiente (síncrono: también sirve al cerrar la app). */
function flush() {
  if (!file || !buffer.length) return
  const lines = buffer
  buffer = []
  let piece = ''
  let pieceBytes = 0
  const write = () => {
    if (!piece) return
    fs.appendFileSync(file, piece)
    fileSize += pieceBytes
    piece = ''
    pieceBytes = 0
  }
  try {
    for (const line of lines) {
      const bytes = Buffer.byteLength(line)
      // El tope se respeta línea por línea: una tanda grande también rota el archivo a tiempo.
      if (fileSize + pieceBytes + bytes > MAX_FILE_BYTES && fileSize + pieceBytes > 0) {
        write()
        fs.renameSync(file, file.replace(/\.log$/, '.old.log'))
        fileSize = 0
      }
      piece += line
      pieceBytes += bytes
    }
    write()
  } catch {
    // Sin disco o sin permiso: el registro sigue en memoria.
  }
}

/** Empieza a guardar en userData/logs. Devuelve la carpeta. */
function init(userData) {
  const dir = path.join(userData, 'logs')
  try {
    fs.mkdirSync(dir, { recursive: true })
    file = path.join(dir, 'capiuploader.log')
    fileSize = fs.existsSync(file) ? fs.statSync(file).size : 0
    for (const e of entries) queue(format(e)) // lo anotado antes de init también va al archivo
  } catch {
    file = null
  }
  return dir
}

const folder = () => (file ? path.dirname(file) : null)

module.exports = { log, info, warn, error, list, text, clear, flush, init, folder, redact, MAX_ENTRIES }
