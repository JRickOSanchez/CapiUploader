const BASE = 'https://capibaratraductor.com/api/v1'
const MAX_RETRIES = 3

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')) }, { once: true })
})

class ApiError extends Error {
  constructor(message, code, status) {
    super(message)
    this.code = code
    this.status = status
  }
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

    if (res.status === 429 && attempt < MAX_RETRIES) {
      const wait = Number(res.headers.get('retry-after')) || 5
      await sleep(Math.min(wait, 120) * 1000, signal)
      continue
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
