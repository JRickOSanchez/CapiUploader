/**
 * Peticiones a las APIs de Crimson y Mangation (sin Electron, para poder probarlas con servidores
 * falsos). Cada plataforma tiene su propio «ritmo» (pacer): un tope de peticiones en paralelo, una
 * separación mínima entre arranques y una pausa compartida cuando el servidor responde 429/503, para
 * no agotar su límite ni repetir el error en cada página.
 *
 * Reintentos: las lecturas (GET) y lo que se marque `retry: true` se repiten ante errores de red y
 * 5xx con espera creciente; lo demás (crear un capítulo, subir uno entero) nunca se repite a ciegas:
 * el que llama decide comprobando qué quedó del otro lado.
 */
const fs = require('node:fs')
const { cancelled, sleep, withTimeout } = require('../util')
const diagnostics = require('../diagnostics')

const MAX_RETRIES = 3
const MAX_PAUSE_MS = 120e3
const UA = `CapiUploader (+https://github.com/JRickOSanchez/CapiUploader)`

class PlatformError extends Error {
  constructor(message, code, status = 0, extra = {}) {
    super(message)
    this.code = code
    this.status = status
    Object.assign(this, extra)
  }
}

/** Cola con tope de peticiones en paralelo, separación mínima y pausa compartida. */
function createPacer({ concurrency = 4, minGapMs = 80 } = {}) {
  let active = 0
  let lastStart = 0
  let pausedUntil = 0
  const waiting = []

  const wake = () => { while (active < concurrency && waiting.length) { active++; waiting.shift()() } }

  return {
    async acquire(signal) {
      if (active >= concurrency) {
        await new Promise((resolve, reject) => {
          const entry = () => { signal?.removeEventListener('abort', onAbort); resolve() }
          const onAbort = () => { const i = waiting.indexOf(entry); if (i >= 0) waiting.splice(i, 1); reject(cancelled()) }
          waiting.push(entry)
          signal?.addEventListener('abort', onAbort, { once: true })
        })
      } else {
        active++
      }
      try {
        for (;;) {
          const wait = Math.max(pausedUntil - Date.now(), lastStart + minGapMs - Date.now())
          if (wait <= 0) break
          await sleep(wait, signal)
        }
        lastStart = Date.now()
      } catch (err) {
        this.release()
        throw err
      }
    },
    release() { active--; wake() },
    /** Todas las peticiones de la plataforma esperan `ms` (el servidor pidió calma). */
    pause(ms) { pausedUntil = Math.max(pausedUntil, Date.now() + Math.min(ms, MAX_PAUSE_MS)) },
    get pausedFor() { return Math.max(0, pausedUntil - Date.now()) },
  }
}

/* ---------- multipart/form-data por flujo ----------
   Las páginas no se cargan enteras en memoria: se leen del disco mientras se envían, con
   Content-Length exacto (algunos servidores rechazan el envío «chunked») y avance por bytes. */

const CRLF = '\r\n'
const quote = (s) => String(s).replace(/[\r\n"]/g, (c) => ({ '\r': '%0D', '\n': '%0A', '"': '%22' }[c]))

/**
 * parts: [{ name, value }] (texto) | [{ name, path, size, filename, type }] (archivo en disco)
 *        | [{ name, data: Buffer, filename, type }].
 * Devuelve { contentType, length, stream(onBytes) }; stream() crea un flujo nuevo cada vez (reintentos).
 */
function multipart(parts) {
  const boundary = `----CapiUploader${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`
  const enc = new TextEncoder()
  const pieces = parts.map((p) => {
    const file = p.path != null || p.data != null
    const head = enc.encode(`--${boundary}${CRLF}Content-Disposition: form-data; name="${quote(p.name)}"`
      + (file ? `; filename="${quote(p.filename || 'archivo')}"${CRLF}Content-Type: ${p.type || 'application/octet-stream'}` : '')
      + `${CRLF}${CRLF}`)
    const value = file ? null : enc.encode(String(p.value ?? ''))
    const size = p.data != null ? p.data.length : p.path != null ? Number(p.size) : value.length
    return { head, value, size, part: p }
  })
  const tail = enc.encode(`--${boundary}--${CRLF}`)
  const crlf = enc.encode(CRLF)
  const length = pieces.reduce((n, x) => n + x.head.length + x.size + crlf.length, 0) + tail.length

  async function* chunks(onBytes) {
    for (const x of pieces) {
      yield x.head
      if (x.value) yield x.value
      else if (x.part.data != null) { yield x.part.data; onBytes?.(x.part.data.length) }
      else {
        for await (const c of fs.createReadStream(x.part.path, { highWaterMark: 256 * 1024 })) { yield c; onBytes?.(c.length) }
      }
      yield crlf
    }
    yield tail
  }
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    length,
    stream: (onBytes) => ReadableStream.from(chunks(onBytes)),
  }
}

/* ---------- Cliente ---------- */

const errorText = (body) => {
  const v = body?.error ?? body?.message
  if (typeof v === 'string') return v
  return typeof v?.message === 'string' ? v.message : null
}

const backoff = (attempt) => Math.min(1000 * 2 ** attempt, 15e3) * (0.75 + Math.random() * 0.5)

/**
 * Cliente de una plataforma.
 * conf: { id, label, base, origin, pacer, auth(session) -> headers, classify(res, body, opts) -> Error|null }
 * request({ session, method, path, json, form (de multipart()), onBytes, signal, retry, timeoutMs, raw })
 */
function createClient(conf) {
  const { id, label, origin } = conf
  const pacer = conf.pacer || createPacer()
  const base = () => conf.base()

  /** onBytes(n) avisa los bytes enviados; si un intento falla, se descuentan (n negativo). */
  async function request(opts) {
    let sent = 0
    const count = opts.onBytes && ((n) => { sent += n; opts.onBytes(n) })
    const rewind = () => { if (sent) { opts.onBytes(-sent); sent = 0 } }
    try {
      return await attempt(opts, count, rewind)
    } catch (err) {
      rewind()
      throw err
    }
  }

  async function attempt({ session, method = 'GET', path, json, form, signal, retry, timeoutMs = 60e3, raw = false, quiet = false }, count, rewind) {
    const canRetry = retry ?? (method === 'GET' || method === 'HEAD')
    let retried = false
    for (let attempt = 0; ; attempt++) {
      rewind()
      if (signal?.aborted) throw cancelled()
      await pacer.acquire(signal)
      let res
      let body
      try {
        res = await fetch(base() + path, {
          method,
          signal: withTimeout(signal, form ? Math.max(timeoutMs, 10 * 60e3) : timeoutMs),
          headers: {
            Accept: 'application/json, */*',
            'Accept-Language': 'es',
            'User-Agent': UA,
            ...(origin ? { Origin: origin, Referer: `${origin}/` } : {}),
            ...(conf.auth && session ? conf.auth(session) : {}),
            ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...(form ? { 'Content-Type': form.contentType, 'Content-Length': String(form.length) } : {}),
          },
          body: json !== undefined ? JSON.stringify(json) : form ? form.stream(count) : undefined,
          ...(form ? { duplex: 'half' } : {}),
        })
        body = res.status === 204 ? null : await res.text().then((t) => { try { return JSON.parse(t) } catch { return t ? { message: t.slice(0, 300) } : null } })
      } catch (err) {
        if (signal?.aborted) throw cancelled()
        const timeout = err.name === 'TimeoutError'
        const e = new PlatformError(timeout ? `${label} tardó demasiado en responder.` : `No se pudo conectar con ${label}. Revisa tu conexión.`, timeout ? 'timeout' : 'network', 0, { retried })
        if (canRetry && attempt < MAX_RETRIES) {
          if (!quiet) diagnostics.warn(id, `${method} ${path}: ${e.message} Reintento ${attempt + 1}.`)
          retried = true
          await sleep(backoff(attempt), signal)
          continue
        }
        throw e
      } finally {
        pacer.release()
      }
      if (session) conf.onResponse?.(res)

      // La plataforma puede reconocer errores propios (límite de subidas, sesión vencida…).
      const special = conf.classify?.(res, body, { path, method })
      if (special) throw Object.assign(special, { retried })

      if (res.status === 429 || res.status === 503) {
        const wait = (Number(res.headers.get('retry-after')) || 0) * 1000 || backoff(attempt + 2)
        pacer.pause(wait)
        if (canRetry && attempt < MAX_RETRIES) { retried = true; continue }
        throw new PlatformError(`${label} pide esperar antes de seguir.`, 'api.rate_limited', res.status, { retryAfter: Math.ceil(Math.max(wait, pacer.pausedFor) / 1000), retried })
      }
      if (res.status >= 500 && canRetry && attempt < MAX_RETRIES) {
        if (!quiet) diagnostics.warn(id, `${method} ${path}: ${label} respondió ${res.status}. Reintento ${attempt + 1}.`)
        retried = true
        await sleep(backoff(attempt), signal)
        continue
      }
      if (res.status === 401) throw new PlatformError(`Tu sesión de ${label} venció. Inicia sesión de nuevo.`, `${id}.session_expired`, 401, { retried })
      if (!res.ok) {
        const msg = errorText(body)
        throw new PlatformError(msg || `${label} respondió con un error (HTTP ${res.status}).`,
          res.status === 409 ? `${id}.conflict` : res.status === 404 ? `${id}.not_found` : res.status === 403 ? `${id}.forbidden` : 'http_error',
          res.status, { retried })
      }
      return raw ? { body, res } : body
    }
  }

  return { request, pacer }
}

/** Datos de un archivo en disco para multipart() (tamaño ya leído). */
async function filePart(name, file, filename = file.name, type = file.type) {
  const st = await fs.promises.stat(file.path)
  return { name, path: file.path, size: st.size, filename, type }
}

module.exports = { PlatformError, createPacer, createClient, multipart, filePart, UA }
