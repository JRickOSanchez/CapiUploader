const BASE = 'https://capibaratraductor.com/api/v1'
const MAX_RETRIES = 3
// Un 429 con una espera corta (límite por minuto) se reintenta aquí; uno largo (límites por hora o por
// día) se devuelve como error con retryAfter para que quien llama decida (el lote se pausa solo).
const MAX_INLINE_WAIT_S = 60

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
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')) }, { once: true })
})

class ApiError extends Error {
  constructor(message, code, status, extra = {}) {
    super(message)
    this.code = code
    this.status = status
    // traceId: código de rastreo de Capibara para soporte. retryAfter (s) y limit: en api.rate_limited.
    Object.assign(this, extra)
  }
}

/** «Vuelve a intentar en 616 s» → «Capibara limita los capítulos creados por hora. Se libera en 11 min.» */
function rateLimitError(json, res) {
  const retryAfter = Number(json?.data?.retryAfter) || Number(res.headers.get('retry-after')) || 60
  const limit = json?.data?.limit || null
  const mins = Math.ceil(retryAfter / 60)
  const what = LIMIT_TEXT[limit] ? `Capibara limita los ${LIMIT_TEXT[limit]}` : 'Se pasó un límite de Capibara'
  return new ApiError(`${what}. Se libera en ${retryAfter < 90 ? `${retryAfter} s` : `${mins} min`}.`, 'api.rate_limited', 429,
    { retryAfter, limit, traceId: json?.traceId || res.headers.get('x-trace-id') || null })
}

/** Petición a la API con reintentos ante 429 (Retry-After) y errores 5xx / de red. */
async function request(key, method, path, body, signal) {
  let lastErr
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res
    try {
      res = await fetch(BASE + path, {
        method,
        signal,
        headers: {
          Authorization: `Bearer ${key}`,
          'Accept-Language': 'es',
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      })
    } catch (err) {
      if (signal?.aborted) throw err
      lastErr = new ApiError('No se pudo conectar con Capibara. Revisa tu conexión.', 'network', 0)
      if (attempt < MAX_RETRIES) { await sleep(1000 * 2 ** attempt, signal); continue }
      throw lastErr
    }

    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after')) || 5
      if (wait <= MAX_INLINE_WAIT_S && attempt < MAX_RETRIES) {
        await sleep(wait * 1000, signal)
        continue
      }
      throw rateLimitError(await res.json().catch(() => null), res)
    }
    if (res.status >= 500 && attempt < MAX_RETRIES) {
      await sleep(1000 * 2 ** attempt, signal)
      continue
    }

    const json = await res.json().catch(() => null)
    if (!res.ok || !json || json.status === false) {
      throw new ApiError(
        json?.message || `Error HTTP ${res.status}`,
        json?.errorCode || 'http_error',
        res.status,
        { traceId: json?.traceId || res.headers.get('x-trace-id') || null, data: json?.data ?? null },
      )
    }
    return json
  }
  throw lastErr
}

/** Sube un binario a una URL firmada, con reintentos. */
async function putFile(url, contentType, buffer, signal) {
  let lastErr
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { method: 'PUT', signal, headers: { 'Content-Type': contentType }, body: buffer })
      if (res.ok) return
      lastErr = new Error(`HTTP ${res.status}`)
      if (res.status < 500 && res.status !== 429) throw lastErr
    } catch (err) {
      if (signal?.aborted) throw err
      lastErr = err
    }
    if (attempt < MAX_RETRIES) await sleep(1000 * 2 ** attempt, signal)
  }
  throw lastErr
}

module.exports = { request, putFile, ApiError }
