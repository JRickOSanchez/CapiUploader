/**
 * Cliente de la API v1 de Capibara: reintentos ante 429 y errores 5xx o de red, errores con su
 * código (errorCode) y código de rastreo (traceId), listas paginadas y subidas a URLs firmadas.
 *
 * Para no chocar con los límites: cada clave lleva la cuenta de las peticiones que le quedan en el
 * minuto (cabeceras X-RateLimit-*) y, si quedan pocas, espera a que se reinicie; y dos lecturas
 * iguales al mismo tiempo comparten una sola petición.
 * Sin dependencias de Electron, para poder probarlo.
 */
const { sleep } = require('./util')
const diagnostics = require('./diagnostics')

const BASE = 'https://capibaratraductor.com/api/v1'
const MAX_RETRIES = 3
// Un 429 con una espera corta (límite por minuto) se reintenta aquí; uno largo (límites por hora o por
// día) se devuelve como error con retryAfter para que quien llama decida (el lote se pausa solo).
const MAX_INLINE_WAIT_S = 60
// Peticiones por minuto que se dejan libres (para otros bots o paneles que usen la misma clave).
const RESERVE = 3

const LIMIT_TEXT = {
  perMinute: 'peticiones por minuto de la clave',
  perDay: 'peticiones por día de la clave',
  scanPerMinute: 'peticiones por minuto del scan',
  chaptersPerHour: 'capítulos creados por hora',
  uploadsPerHour: 'imágenes subidas por hora',
  chapterEditsPerHour: 'ediciones de capítulos por hora',
  pageEditsPerHour: 'ediciones de páginas por hora',
  pagesDeletedPerHour: 'páginas quitadas por hora',
  chapterVisibilityPerHour: 'capítulos ocultados, borrados o restaurados por hora',
  worksPerDay: 'obras creadas por día',
  workEditsPerHour: 'ediciones y publicaciones de obras por hora',
  workImagesPerHour: 'portadas y banners subidos por hora',
}

class ApiError extends Error {
  constructor(message, code, status, extra = {}) {
    super(message)
    this.code = code
    this.status = status
    // traceId: código de rastreo de Capibara para soporte. retryAfter (s) y limit: en api.rate_limited.
    Object.assign(this, extra)
  }
}

const traceOf = (json, res) => json?.traceId || res.headers.get('x-trace-id') || null
/** Espera exponencial con algo de azar, para que los reintentos no salgan todos a la vez. */
const backoff = (attempt) => 1000 * 2 ** attempt + Math.floor(Math.random() * 400)

/* ---------- Ritmo por clave ---------- */

const budgets = new Map() // key -> { remaining, resetAt }

/** Antes de cada petición: si al minuto le quedan pocas, se espera a que se reinicie. */
async function takeBudget(key, signal) {
  const b = budgets.get(key)
  if (!b) return
  const now = Date.now()
  if (now >= b.resetAt) { budgets.delete(key); return }
  if (b.remaining <= RESERVE) {
    diagnostics.warn('api', `Quedan ${b.remaining} peticiones este minuto: se espera ${Math.ceil((b.resetAt - now) / 1000)} s.`)
    await sleep(b.resetAt - now + 250, signal)
  }
  else b.remaining--
}

/** Lo que dice Capibara en cada respuesta: peticiones que quedan y segundos hasta el próximo minuto. */
function noteBudget(key, res) {
  const remaining = Number(res.headers.get('x-ratelimit-remaining'))
  const reset = Number(res.headers.get('x-ratelimit-reset'))
  if (Number.isFinite(remaining) && Number.isFinite(reset)) budgets.set(key, { remaining, resetAt: Date.now() + reset * 1000 })
}

/** «Vuelve a intentar en 616 s» → «Capibara limita los capítulos creados por hora. Se libera en 11 min.» */
function rateLimitError(json, res) {
  const retryAfter = Number(json?.data?.retryAfter) || Number(res.headers.get('retry-after')) || 60
  const limit = json?.data?.limit || null
  const what = LIMIT_TEXT[limit] ? `Capibara limita los ${LIMIT_TEXT[limit]}` : 'Se pasó un límite de Capibara'
  const when = retryAfter < 90 ? `${retryAfter} s` : `${Math.ceil(retryAfter / 60)} min`
  return new ApiError(`${what}. Se libera en ${when}.`, 'api.rate_limited', 429, { retryAfter, limit, traceId: traceOf(json, res) })
}

/**
 * Petición a la API. body: un objeto (se manda como JSON) o un FormData (multipart, p. ej.
 * portadas). Devuelve el sobre completo { status, data, pagination? }.
 */
async function request(key, method, path, body, signal) {
  // Lecturas iguales y simultáneas (p. ej. la lista de capítulos pedida desde dos secciones): una sola petición.
  if (method === 'GET' && !signal) {
    const id = `${key}|${path}`
    if (!inflight.has(id)) inflight.set(id, send(key, method, path, body, signal).finally(() => inflight.delete(id)))
    return inflight.get(id)
  }
  return send(key, method, path, body, signal)
}
const inflight = new Map()

async function send(key, method, path, body, signal) {
  const form = body instanceof FormData
  let lastErr
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res
    await takeBudget(key, signal)
    const started = Date.now()
    try {
      res = await fetch(BASE + path, {
        method,
        signal,
        headers: {
          Authorization: `Bearer ${key}`,
          'Accept-Language': 'es',
          Accept: 'application/json',
          ...(body && !form ? { 'Content-Type': 'application/json' } : {}),
        },
        body: form ? body : body ? JSON.stringify(body) : undefined,
      })
    } catch (err) {
      if (signal?.aborted) throw err
      lastErr = new ApiError('No se pudo conectar con Capibara. Revisa tu conexión.', 'network', 0, { retried: attempt > 0 })
      diagnostics.warn('api', `${method} ${path} → sin conexión (intento ${attempt + 1})`, err.message)
      if (attempt < MAX_RETRIES) { await sleep(backoff(attempt), signal); continue }
      throw lastErr
    }
    noteBudget(key, res)
    diagnostics.log(res.ok ? 'info' : 'warn', 'api', `${method} ${path} → ${res.status} (${Date.now() - started} ms${attempt ? `, intento ${attempt + 1}` : ''})`)

    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after')) || 5
      if (wait <= MAX_INLINE_WAIT_S && attempt < MAX_RETRIES) {
        await sleep(wait * 1000, signal)
        continue
      }
      throw Object.assign(rateLimitError(await res.json().catch(() => null), res), { retried: attempt > 0 })
    }
    if (res.status >= 500 && attempt < MAX_RETRIES) {
      const wait = Number(res.headers.get('retry-after'))
      await sleep(wait > 0 && wait <= MAX_INLINE_WAIT_S ? wait * 1000 : backoff(attempt), signal)
      continue
    }

    const json = await res.json().catch(() => null)
    if (!res.ok || !json || json.status === false) {
      throw new ApiError(json?.message || `Error HTTP ${res.status}`, json?.errorCode || 'http_error', res.status,
        // retried: el error llegó en un reintento (el intento anterior pudo haber llegado a Capibara).
        { traceId: traceOf(json, res), data: json?.data ?? null, retried: attempt > 0 })
    }
    return json
  }
  throw lastErr
}

/** Todas las páginas de una lista (GET con `pagination`): junta los `data` en un solo arreglo. */
async function requestAll(key, path, signal) {
  const sep = path.includes('?') ? '&' : '?'
  const all = []
  let page = 1
  let pages = 1
  do {
    const res = await request(key, 'GET', `${path}${sep}page=${page}`, null, signal)
    if (Array.isArray(res.data)) all.push(...res.data)
    pages = res.pagination?.pages || 1
    page++
  } while (page <= pages)
  return all
}

/** Sube un binario a una URL firmada. Reintenta ante 429, 5xx y errores de red; no ante otros 4xx. */
async function putFile(url, contentType, buffer, signal) {
  let lastErr
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { method: 'PUT', signal, headers: { 'Content-Type': contentType }, body: buffer })
      if (res.ok) return
      lastErr = new Error(`HTTP ${res.status}`)
      if (res.status < 500 && res.status !== 429) throw lastErr
    } catch (err) {
      if (signal?.aborted || err === lastErr) throw err
      lastErr = err
    }
    if (attempt < MAX_RETRIES) await sleep(backoff(attempt), signal)
  }
  throw lastErr
}

module.exports = { request, requestAll, putFile, ApiError }
