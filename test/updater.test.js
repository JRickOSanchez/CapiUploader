// Comparación de versiones del actualizador: las de prueba (beta) nunca les llegan a quienes tienen una
// final, y quien tiene una beta pasa a la siguiente beta y después a la final.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

// El actualizador usa `app` de Electron al cargarse: aquí se simula.
const load = Module._load
Module._load = function (req, ...rest) {
  if (req === 'electron') return { app: { isPackaged: true, getVersion: () => '1.4.2', getName: () => 'CapiUploader' } }
  return load.call(this, req, ...rest)
}
const { newer, isPrerelease } = require('../src/main/updater')
Module._load = load

test('versiones finales: la mayor gana, con o sin «v»', () => {
  assert.equal(newer('1.10.0', '1.9.2'), true)
  assert.equal(newer('v1.4.2', '1.4.1'), true)
  assert.equal(newer('1.4.2', '1.4.2'), false)
  assert.equal(newer('1.4.1', '1.4.2'), false)
})

test('versiones de prueba: la final gana a sus betas y entre betas cuenta el número', () => {
  assert.equal(newer('1.5.0', '1.5.0-beta.1'), true, 'quien tiene la beta recibe la final')
  assert.equal(newer('1.5.0-beta.1', '1.5.0'), false)
  assert.equal(newer('1.5.0-beta.2', '1.5.0-beta.1'), true)
  assert.equal(newer('1.5.0-beta.10', '1.5.0-beta.9'), true)
  assert.equal(newer('1.5.0-beta.1', '1.4.2'), true)
  assert.equal(newer('1.4.2', '1.5.0-beta.1'), false, 'una final vieja no reemplaza a la beta')
  assert.equal(isPrerelease('1.5.0-beta.1'), true)
  assert.equal(isPrerelease('1.4.2'), false)
})
