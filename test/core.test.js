// Utilidades, cliente de la API, imágenes, archivos y subida (proceso principal, sin Electron).
const { test } = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs/promises')
const util = require('../src/main/util')
const api = require('../src/main/api')
const images = require('../src/main/images')
const files = require('../src/main/files')
const { chapterBody } = require('../src/main/upload')

const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)])
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)])

/** Respuesta falsa con lo mínimo que usan los clientes. */
const response = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => body,
  arrayBuffer: async () => (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))),
})

/** Reemplaza fetch mientras corre `fn`. */
async function withFetch(impl, fn) {
  const original = global.fetch
  global.fetch = impl
  try { return await fn() } finally { global.fetch = original }
}

test('pool respeta el límite de trabajos en paralelo y cancela', async () => {
  let running = 0
  let peak = 0
  const done = []
  await util.pool([1, 2, 3, 4, 5], 2, async (n) => {
    running++
    peak = Math.max(peak, running)
    await util.sleep(5)
    done.push(n)
    running--
  })
  assert.equal(peak, 2)
  assert.deepEqual(done.sort(), [1, 2, 3, 4, 5])
  const ctrl = new AbortController()
  ctrl.abort()
  await assert.rejects(util.pool([1], 1, async () => {}, ctrl.signal), { code: 'cancelled' })
})

test('exclusiveTask deja correr uno a la vez y cancela con la señal', async () => {
  const task = util.exclusiveTask('Ocupado')
  let signal
  const first = task.run(async (s) => { signal = s; await util.sleep(1000, s) })
  assert.equal(task.busy, true)
  await assert.rejects(task.run(async () => {}), /Ocupado/)
  task.cancel()
  await assert.rejects(first, { code: 'cancelled' })
  assert.equal(signal.aborted, true)
  assert.equal(task.busy, false)
})

test('prepareCache borra solo lo viejo', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'capi-cache-'))
  await fs.writeFile(path.join(dir, 'nuevo'), 'x')
  await fs.writeFile(path.join(dir, 'viejo'), 'x')
  const old = new Date(Date.now() - 4 * 864e5)
  await fs.utimes(path.join(dir, 'viejo'), old, old)
  await util.prepareCache(dir)
  assert.deepEqual(await fs.readdir(dir), ['nuevo'])
  await fs.rm(dir, { recursive: true, force: true })
})

test('requestAll junta todas las páginas de una lista', async () => {
  const seen = []
  await withFetch(async (url) => {
    seen.push(url)
    const page = Number(new URL(url).searchParams.get('page'))
    return response(200, { status: true, data: [`a${page}`, `b${page}`], pagination: { page, pages: 3 } })
  }, async () => {
    assert.deepEqual(await api.requestAll('k', '/works?limit=50'), ['a1', 'b1', 'a2', 'b2', 'a3', 'b3'])
  })
  assert.match(seen[0], /\/works\?limit=50&page=1$/)
})

test('request devuelve el error de Capibara con su código de rastreo', async () => {
  await withFetch(async () => response(409, { status: false, errorCode: 'api.conflict', message: 'Ya existe', traceId: 'AB-12' }), async () => {
    await assert.rejects(api.request('k', 'POST', '/works', {}), { code: 'api.conflict', status: 409, traceId: 'AB-12', message: 'Ya existe' })
  })
})

test('putFile no reintenta un 4xx', async () => {
  let calls = 0
  await withFetch(async () => { calls++; return response(403, {}) }, async () => {
    await assert.rejects(api.putFile('https://s/x', 'image/png', Buffer.alloc(1)), /HTTP 403/)
  })
  assert.equal(calls, 1)
})

test('sniff reconoce imágenes por sus primeros bytes', () => {
  assert.equal(images.sniff(JPG), '.jpg')
  assert.equal(images.sniff(PNG), '.png')
  assert.equal(images.sniff(Buffer.from('<!doctype html><html>')), null)
})

test('nombres de carpeta válidos en Windows', () => {
  assert.equal(images.safeName('Obra: «uno» / dos?'), 'Obra «uno» dos')
  assert.equal(images.safeName('con'), 'Sin título')
  assert.equal(images.chapterFolderName({ number: 12, volumeNumber: 3, title: 'El regreso' }), 'Vol 3 Cap 12 - El regreso')
  assert.equal(images.chapterFolderName({ number: 100002, extra: true, extraNumber: 2 }), 'Extra 2')
})

test('fetchImage: no reintenta lo que no es imagen y reintenta lo incompleto', async () => {
  let calls = 0
  const html = async () => { calls++; return response(200, Buffer.from('<html>error</html>')) }
  await assert.rejects(images.fetchImage('https://x/1', { fetcher: html }), /no es una imagen/)
  assert.equal(calls, 1)
  calls = 0
  const cut = async () => { calls++; return response(200, JPG, { 'content-length': '999' }) }
  await assert.rejects(images.fetchImage('https://x/2', { fetcher: cut, retries: 1 }), /incompleta/)
  assert.equal(calls, 2)
  const ok = await images.fetchImage('https://x/3', { fetcher: async () => response(200, PNG) })
  assert.equal(ok.ext, '.png')
})

test('resolveChapters encuentra capítulos hasta dos niveles y la obra por sus carpetas', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'capi-files-'))
  const lote = path.join(root, 'Lote')
  for (const dir of ['Choujin X/Cap 2', 'Choujin X/Cap 10', 'Kirara/Vol 1/Cap 1']) {
    await fs.mkdir(path.join(lote, dir), { recursive: true })
    await fs.writeFile(path.join(lote, dir, '001.jpg'), JPG)
    await fs.writeFile(path.join(lote, dir, 'notas.txt'), 'x')
  }
  const res = await files.resolveChapters([path.join(lote, 'Choujin X'), path.join(lote, 'Kirara')])
  assert.deepEqual(res.chapters.map((c) => [c.name, c.parent, c.files.length]), [['Cap 2', 'Choujin X', 1], ['Cap 10', 'Choujin X', 1], ['Cap 1', 'Vol 1', 1]])
  assert.deepEqual(res.chapters[2].ancestors, ['Vol 1', 'Kirara', 'Lote'])
  const single = await files.resolvePaths([path.join(lote, 'Choujin X', 'Cap 2')])
  assert.deepEqual(single.files.map((f) => [f.name, f.type]), [['001.jpg', 'image/jpeg']])
  await fs.rm(root, { recursive: true, force: true })
})

test('cuerpo del capítulo: páginas simples, extra, aviso y página destacada', () => {
  const body = chapterBody({ number: 3, title: 'T', volumeNumber: 1, announcePage: null, notify: false, extra: true }, ['k1', 'k2'], [false, true])
  assert.deepEqual(body, { number: 3, pages: ['k1', { key: 'k2', single: true }], title: 'T', volumeNumber: 1, announcePage: null, notify: false, extra: true })
  assert.deepEqual(chapterBody({ number: 1 }, ['k'], [false]), { number: 1, pages: ['k'] })
})
