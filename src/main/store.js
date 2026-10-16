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

/** La API key se guarda cifrada con el almacén seguro del sistema (DPAPI en Windows). */
function setApiKey(key) {
  if (!key) {
    delete data.apiKey
    delete data.apiKeyPlain
  } else if (isEncryptionAvailable()) {
    data.apiKey = safeStorage.encryptString(key).toString('base64')
    delete data.apiKeyPlain
  } else {
    data.apiKeyPlain = key
    delete data.apiKey
  }
  save()
}

function getApiKey() {
  if (data.apiKey) {
    try {
      return safeStorage.decryptString(Buffer.from(data.apiKey, 'base64'))
    } catch {
      return null
    }
  }
  return data.apiKeyPlain || null
}

module.exports = { init, get, set, setApiKey, getApiKey, isEncryptionAvailable }
