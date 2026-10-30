/** «Mis scans»: varias API keys guardadas cifradas, una activa a la vez. */
const store = require('../store')
const api = require('../api')
const { handle, tasks } = require('./core')
const mainWindow = require('../window')

const KEY_RE = /^capi_[A-Za-z0-9]{40}$/
const UPLOAD_BUSY = 'Espera a que termine la subida para cambiar de scan.'

/** La versión 1.0 guardaba una sola clave sin datos del scan: se convierte en el primer perfil. */
let migration = null
function migrateLegacy() {
  if (!migration) {
    migration = (async () => {
      const legacy = store.takeLegacyKey()
      if (!legacy) return
      try {
        const me = await api.request(legacy, 'GET', '/me')
        store.upsertProfile(legacy, me.data)
        if (store.get('activeScanId') == null) store.setActiveId(me.data.scan.id)
        store.clearLegacyKey()
      } catch {
        // Nunca se borra la clave vieja por un error: se conserva y se reintenta en el próximo
        // arranque. Solo desaparece al migrarse o cuando el usuario agrega un scan.
        migration = null
      }
    })()
  }
  return migration
}

const profilesState = () => ({ profiles: store.listProfiles(), activeId: store.getActiveId(), encrypted: store.isEncryptionAvailable() })

/** Avisa a las ventanas que cambió el scan activo o la lista de scans. */
function changed() {
  const state = profilesState()
  mainWindow.sendAll('profiles:changed', state)
  return state
}

function register() {
  handle('profiles:list', async () => {
    await migrateLegacy()
    return profilesState()
  })

  handle('profiles:add', async (key) => {
    key = String(key || '').trim()
    if (!KEY_RE.test(key)) {
      throw Object.assign(new Error('La clave debe ser "capi_" seguido de 40 letras o números.'), { code: 'api.invalid_request' })
    }
    if (tasks.upload.busy) throw new Error(UPLOAD_BUSY)
    const me = (await api.request(key, 'GET', '/me')).data
    const { profile, replaced } = store.upsertProfile(key, me)
    store.setActiveId(profile.id)
    store.clearLegacyKey()
    return { ...changed(), added: profile, replaced, me }
  })

  handle('profiles:setActive', async (id) => {
    if (tasks.upload.busy) throw new Error(UPLOAD_BUSY)
    if (!store.getProfile(id)) throw new Error('Ese scan ya no está registrado.')
    store.setActiveId(id)
    return changed()
  })

  handle('profiles:remove', async (id) => {
    if (tasks.upload.busy && id === store.getActiveId()) throw new Error('Espera a que termine la subida para quitar este scan.')
    store.removeProfile(id)
    return changed()
  })

  /** Vuelve a consultar /me con la clave del scan para actualizar permisos y estado. */
  handle('profiles:verify', async (id) => {
    const key = store.getProfileKey(id)
    if (!key) throw new Error('No se pudo leer la API key de este scan. Vuelve a agregarla.')
    try {
      const me = (await api.request(key, 'GET', '/me')).data
      store.updateProfile(id, {
        name: me.scan.name, slug: me.scan.slug, url: me.scan.url, prefix: me.key.prefix,
        keyName: me.key.name, scopes: me.key.scopes, expiresAt: me.key.expiresAt, status: 'ok',
      })
      return { ...profilesState(), me }
    } catch (err) {
      if (err.code === 'api.key_invalid') store.updateProfile(id, { status: 'invalid' })
      throw err
    }
  })
}

module.exports = { register, migrateLegacy }
