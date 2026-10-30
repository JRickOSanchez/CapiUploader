// Detección del número, el tomo y la obra por el nombre de las carpetas (src/renderer/js/names.js).
// El archivo es un script de la interfaz: se carga en un contexto propio con un `state` falso.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const state = { works: [
  { id: 1, title: 'Choujin X', slug: 'choujin-x' },
  { id: 2, title: 'Kirara Hoshikita quiere brillar', slug: 'kirara-hoshikita' },
  { id: 3, title: 'Kaiju No. 8', slug: 'kaiju-no-8' },
] }
const ctx = vm.createContext({ state })
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'names.js'), 'utf8'), ctx)
// Las funciones del script quedan en el contexto; se copian a objetos normales para comparar.
const plain = (v) => JSON.parse(JSON.stringify(v))
const parse = (name) => plain(ctx.parseChapterName(name))

test('número, tomo y título del nombre de la carpeta', () => {
  assert.deepEqual(parse('Capítulo 12.5 - El regreso'), { number: 12.5, volume: null, title: 'El regreso', extra: false })
  assert.deepEqual(parse('Vol 3 Ch 20'), { number: 20, volume: 3, title: '', extra: false })
  assert.deepEqual(parse('[Scan] Kirara 015'), { number: 15, volume: null, title: '', extra: false })
  assert.deepEqual(parse('013 - Título'), { number: 13, volume: null, title: 'Título', extra: false })
})

test('extras: solo si el «Extra» va antes del «Cap N»', () => {
  assert.deepEqual(parse('Extra 2 - Ilustraciones'), { number: 2, volume: null, title: 'Ilustraciones', extra: true })
  assert.equal(parse('Cap 12 - Un día especial').extra, false)
  assert.equal(parse('Omake').extra, true)
})

test('la obra sale de las carpetas o del nombre del capítulo', () => {
  assert.equal(ctx.workHintFromName('Choujin X Cap 12 - Título'), 'Choujin X')
  assert.equal(ctx.volumeFromFolder('Tomo 03'), 3)
  assert.equal(ctx.volumeFromFolder('Choujin X'), null)
  assert.equal(ctx.guessWork(['Vol 1', 'Choujin X [Scan]', 'Lote'], 'Cap 3').work.id, 1)
  assert.equal(ctx.guessWork([], 'Kirara Cap 4').work.id, 2)
  assert.equal(ctx.guessWork(['Kaiju No. 8'], 'Cap 1').work.id, 3)
  assert.equal(ctx.guessWork(['Descargas'], 'Cap 1'), null)
})
