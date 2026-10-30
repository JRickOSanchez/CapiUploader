/**
 * Utilidades compartidas del proceso principal (sin Electron, para poder probarlas):
 * esperas cancelables, trabajos en paralelo, tareas de una en una, orden natural y cachés.
 */
const path = require('node:path')
const fs = require('node:fs/promises')

/** Error de cancelación (code: 'cancelled'), el que esperan la interfaz y los bucles de trabajo. */
function cancelled(message = 'Operación cancelada.') {
  return Object.assign(new Error(message), { code: 'cancelled' })
}

/** Espera `ms`; si `signal` se cancela antes, falla con `cancelled()`. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled())
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(cancelled()) }, { once: true })
  })
}

/** Señal que se cancela con `signal` o al pasar `ms` (TimeoutError). */
function withTimeout(signal, ms) {
  const t = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, t]) : t
}

/**
 * Ejecuta `worker(item, i)` sobre cada elemento, con `limit` en paralelo. Si uno falla no se
 * empiezan más y se espera a que terminen los que estaban en marcha antes de lanzar el error: así
 * nada sigue trabajando por detrás cuando el que llama reintenta.
 */
async function pool(items, limit, worker, signal) {
  let next = 0
  let failed = false
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !failed) {
      if (signal?.aborted) throw cancelled()
      const i = next++
      try {
        await worker(items[i], i)
      } catch (err) {
        failed = true
        throw err
      }
    }
  })
  const results = await Promise.allSettled(runners)
  const bad = results.find((r) => r.status === 'rejected')
  if (bad) throw bad.reason
}

/**
 * Trabajo que solo puede correr de a uno (una subida, una descarga…): `run(fn)` falla con
 * `busyMessage` si ya hay uno en curso y le pasa a `fn` la señal que cancela `cancel()`.
 */
function exclusiveTask(busyMessage) {
  let controller = null
  return {
    get busy() { return controller !== null },
    async run(fn) {
      if (controller) throw new Error(busyMessage)
      controller = new AbortController()
      try {
        return await fn(controller.signal)
      } finally {
        controller = null
      }
    },
    cancel() {
      controller?.abort()
      return true
    },
  }
}

/** Compara nombres como lo haría una persona: «Cap 2» antes que «Cap 10». */
const naturalCompare = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare

/** Días que se guardan las cachés (conversiones de PSD, capítulos importados). */
const CACHE_MAX_AGE = 3 * 24 * 60 * 60 * 1000

/**
 * Crea la carpeta de una caché y borra lo que tenga más de `maxAge`. Si algo falla da igual: se
 * reintenta en el próximo arranque.
 */
async function prepareCache(dir, maxAge = CACHE_MAX_AGE) {
  await fs.mkdir(dir, { recursive: true })
  const now = Date.now()
  for (const name of await fs.readdir(dir).catch(() => [])) {
    const p = path.join(dir, name)
    const st = await fs.stat(p).catch(() => null)
    if (st && now - st.mtimeMs > maxAge) await fs.rm(p, { recursive: true, force: true }).catch(() => {})
  }
  return dir
}

module.exports = { cancelled, sleep, withTimeout, pool, exclusiveTask, naturalCompare, prepareCache }
