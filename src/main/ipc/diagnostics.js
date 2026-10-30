/** «Ajustes → Diagnóstico»: ver, copiar y vaciar el registro, y anotar los errores de la interfaz. */
const os = require('node:os')
const { app, shell, clipboard } = require('electron')
const diagnostics = require('../diagnostics')
const store = require('../store')
const { handle, tasks } = require('./core')

// Errores de la interfaz: como mucho estos por minuto, para que un fallo que se repite no llene el registro.
const RENDERER_PER_MINUTE = 20
let rendererWindow = { start: 0, count: 0 }

/** Encabezado para soporte: versiones y estado de la app, sin claves ni nombres de archivos. */
function summary() {
  const scans = store.listProfiles()
  const busy = Object.entries(tasks).filter(([, t]) => t.busy).map(([name]) => name)
  return [
    `CapiUploader ${app.getVersion()}${app.isPackaged ? '' : ' (desarrollo)'}`,
    `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · ${os.type()} ${os.release()} ${os.arch()}`,
    `Aceleración gráfica: ${app.isHardwareAccelerationEnabled() ? 'activada' : 'desactivada'} · Memoria libre: ${Math.round(os.freemem() / 1024 ** 2)} MB`,
    `Scans: ${scans.length} · Trabajos en curso: ${busy.join(', ') || 'ninguno'}`,
  ].join('\n')
}

function register() {
  handle('diag:list', async (minLevel) => ({
    entries: diagnostics.list({ minLevel: ['info', 'warn', 'error'].includes(minLevel) ? minLevel : 'info' }),
    folder: diagnostics.folder(),
  }))

  /** Copia al portapapeles el resumen y el registro, listos para mandar a soporte. */
  handle('diag:copy', async (minLevel) => {
    const body = diagnostics.text({ minLevel: minLevel === 'warn' ? 'warn' : 'info' })
    clipboard.writeText(`${summary()}\n\n${body || 'Sin entradas.'}`)
    return true
  })

  handle('diag:clear', async () => {
    diagnostics.clear()
    return true
  })

  handle('diag:openFolder', async () => {
    diagnostics.flush()
    const dir = diagnostics.folder()
    if (!dir) throw new Error('El registro no se está guardando en disco.')
    const err = await shell.openPath(dir)
    if (err) throw new Error(err)
    return true
  })

  handle('diag:renderer', async (entry) => {
    const now = Date.now()
    if (now - rendererWindow.start > 60e3) rendererWindow = { start: now, count: 0 }
    if (++rendererWindow.count > RENDERER_PER_MINUTE) return false
    diagnostics.error('interfaz', String(entry?.message || 'Error').slice(0, 300), entry?.stack ? String(entry.stack) : undefined)
    return true
  })
}

module.exports = { register, summary }
