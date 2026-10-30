/** Registra todos los canales que usa la interfaz (window.capi en preload.js). */
const modules = [
  require('./system'),
  require('./profiles'),
  require('./capibara'),
  require('./platforms'),
  require('./files'),
  require('./transfers'),
  require('./diagnostics'),
]

function registerIpc() {
  for (const m of modules) m.register()
}

module.exports = { registerIpc, migrateLegacy: require('./profiles').migrateLegacy }
