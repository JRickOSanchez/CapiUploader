const { safeStorage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

let file = null
let data = {}

function init(userDataDir) {
  file = path.join(userDataDir, 'config.json')
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    data = {}
  }
  if (!Array.isArray(data.profiles)) data.profiles = []
}

function save() {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

function get(k) { return data[k] }
function set(k, v) { data[k] = v; save() }

function isEncryptionAvailable() {
  try { return safeStorage.isEncryptionAvailable() } catch { return false }
}

/** Las API keys se guardan cifradas con el almacén seguro del sistema (DPAPI en Windows). */
function encodeKey(key) {
  return isEncryptionAvailable()
    ? { keyEnc: safeStorage.encryptString(key).toString('base64') }
    : { keyPlain: key }
}

function decodeKey(p) {
  if (p.keyEnc) {
    try { return safeStorage.decryptString(Buffer.from(p.keyEnc, 'base64')) } catch { return null }
  }
  return p.keyPlain || null
}

/* ---------- Scans (perfiles) ----------
   Cada perfil: { id (id del scan), name, slug, url, prefix, keyName, scopes, expiresAt,
                  status: 'ok' | 'invalid', addedAt, keyEnc | keyPlain } */

/** Clave de la versión 1.0 (una sola, sin datos del scan) pendiente de migrar. */
function takeLegacyKey() {
  const legacy = data.apiKey ? decodeKey({ keyEnc: data.apiKey }) : data.apiKeyPlain || null
  return legacy
}

function clearLegacyKey() {
  delete data.apiKey
  delete data.apiKeyPlain
  save()
}

/** Datos públicos del perfil: nunca incluye la clave. */
function publicProfile(p) {
  const { keyEnc, keyPlain, ...rest } = p
  return rest
}

function listProfiles() {
  return data.profiles.map(publicProfile)
}

function getProfile(id) {
  return data.profiles.find((p) => p.id === id) || null
}

function getProfileKey(id) {
  const p = getProfile(id)
  return p ? decodeKey(p) : null
}

/** Agrega o reemplaza (mismo scan) un perfil a partir de la respuesta de GET /me. */
function upsertProfile(key, me) {
  const existing = getProfile(me.scan.id)
  const profile = {
    id: me.scan.id,
    name: me.scan.name,
    slug: me.scan.slug,
    url: me.scan.url,
    prefix: me.key.prefix,
    keyName: me.key.name,
    scopes: me.key.scopes,
    expiresAt: me.key.expiresAt,
    status: 'ok',
    addedAt: existing?.addedAt || new Date().toISOString(),
    ...encodeKey(key),
  }
  if (existing) data.profiles[data.profiles.indexOf(existing)] = profile
  else data.profiles.push(profile)
  save()
  return { profile: publicProfile(profile), replaced: Boolean(existing) }
}

function updateProfile(id, patch) {
  const p = getProfile(id)
  if (!p) return null
  Object.assign(p, patch)
  save()
  return publicProfile(p)
}

function removeProfile(id) {
  data.profiles = data.profiles.filter((p) => p.id !== id)
  if (data.activeScanId === id) data.activeScanId = data.profiles[0]?.id ?? null
  save()
}

function getActiveId() {
  if (data.activeScanId != null && getProfile(data.activeScanId)) return data.activeScanId
  return data.profiles[0]?.id ?? null
}

function setActiveId(id) {
  data.activeScanId = id
  save()
}

/* ---------- Secretos (sesiones de otras plataformas) ----------
   Se guardan cifrados igual que las API keys, en data.secrets[nombre]. */

function getSecret(name) {
  const s = data.secrets?.[name]
  return s ? decodeKey(s) : null
}

function setSecret(name, value) {
  if (!data.secrets || typeof data.secrets !== 'object') data.secrets = {}
  if (value == null || value === '') delete data.secrets[name]
  else data.secrets[name] = encodeKey(String(value))
  save()
}

const deleteSecret = (name) => setSecret(name, null)

module.exports = {
  init, get, set, isEncryptionAvailable,
  getSecret, setSecret, deleteSecret,
  takeLegacyKey, clearLegacyKey,
  listProfiles, getProfile, getProfileKey, upsertProfile, updateProfile, removeProfile,
  getActiveId, setActiveId,
}
