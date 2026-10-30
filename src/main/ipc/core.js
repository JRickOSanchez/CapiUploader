/**
 * Base de los canales IPC: cada handler responde { ok, data } o { ok: false, error } a la interfaz,
 * la clave del scan activo se lee solo aquí (la interfaz nunca la ve) y los trabajos largos corren
 * de uno en uno.
 */
const { ipcMain } = require('electron')
const store = require('../store')
const { exclusiveTask } = require('../util')
const diagnostics = require('../diagnostics')

/** Registra un canal: devuelve { ok, data } | { ok: false, error } al renderer. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) }
    } catch (err) {
      markActiveIfInvalid(err)
      if (err.code !== 'cancelled') {
        diagnostics.log(err.code === 'api.rate_limited' ? 'warn' : 'error', 'ipc', `${channel}: ${err.message}`,
          [err.code, err.status, err.traceId && `código ${err.traceId}`].filter(Boolean).join(' · '))
      }
      return {
        ok: false,
        error: {
          message: err.message, code: err.code || null, status: err.status || null,
          traceId: err.traceId || null, retryAfter: err.retryAfter ?? null, limit: err.limit || null,
          // Subidas a varias plataformas: cuál falló y cómo le fue a cada una.
          platform: err.platform || null, results: err.results || null,
        },
      }
    }
  })
}

/** API key del scan activo, o un error que la interfaz sabe mostrar. */
function requireKey() {
  const id = store.getActiveId()
  const key = id != null ? store.getProfileKey(id) : null
  if (!key) {
    throw Object.assign(new Error(id != null
      ? 'No se pudo leer la API key de este scan. Vuelve a agregarla en «Mis scans».'
      : 'Agrega la API key de tu scan para continuar.'), { code: 'api.key_missing' })
  }
  return key
}

/** Si una petición con la clave activa responde «clave inválida», se marca el scan. */
function markActiveIfInvalid(err) {
  if (err?.code !== 'api.key_invalid') return
  const id = store.getActiveId()
  if (id != null) store.updateProfile(id, { status: 'invalid' })
}

/** Trabajos largos: uno de cada tipo a la vez, cancelables desde la interfaz. */
const tasks = {
  upload: exclusiveTask('Ya hay una subida en curso.'),
  download: exclusiveTask('Ya hay una descarga en curso.'),
  import: exclusiveTask('Ya hay una importación en curso.'),
}

module.exports = { handle, requireKey, tasks }
