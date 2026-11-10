// «Descargar»: guardar cada capítulo como carpeta o comprimido (CBZ/ZIP), con la API simulada.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs/promises')
const { downloadChapters } = require('../src/main/download')
const { writeZip, zipEntries } = require('../src/main/zip')
const archives = require('../src/main/archives')

const PNG = (n) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, n)])

const response = (status, { json = null, bytes = null } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => (k.toLowerCase() === 'content-length' && bytes ? String(bytes.length) : null) },
  json: async () => json,
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
})
async function withFetch(impl, fn) {
  const original = global.fetch
  global.fetch = impl
  try { return await fn() } finally { global.fetch = original }
}

/** Capibara simulado: el capítulo 50 tiene 2 páginas. */
const fakeCapibara = (calls) => async (url) => {
  calls.push(url)
  if (url.includes('/chapters/50/pages')) {
    return response(200, { json: { status: true, data: { pages: [{ number: 1, imageUrl: 'https://img.example/1' }, { number: 2, imageUrl: 'https://img.example/2' }] } } })
  }
  if (url.startsWith('https://img.example/')) return response(200, { bytes: PNG(Number(url.slice(-1))) })
  return response(404, { json: { status: false, errorCode: 'api.not_found', message: 'no' } })
}

const CH = { id: 50, number: 3, volumeNumber: null, title: 'Uno', pages: 2 }
const run = (dest, pack) => downloadChapters({
  key: `kdl-${pack}`, work: { id: 9, title: 'Obra' }, chapters: [CH], dest, format: 'original', pack,
  signal: new AbortController().signal, onProgress: () => {},
})

test('un ZIP escrito por la app se lee de vuelta', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'capi-zip-'))
  await fs.writeFile(path.join(dir, '001.png'), PNG(1))
  await fs.writeFile(path.join(dir, '002.png'), PNG(2))
  const file = await writeZip(path.join(dir, 'x.cbz'), dir, ['001.png', '002.png'])
  assert.deepEqual(await zipEntries(file), [{ name: '001.png', size: 48 }, { name: '002.png', size: 48 }])
  assert.equal(await zipEntries(path.join(dir, '001.png')), null)
  await fs.rm(dir, { recursive: true, force: true })
})

test('descargar en CBZ deja un archivo por capítulo, sin la carpeta, y 7-Zip lo abre', async () => {
  const dest = await fs.mkdtemp(path.join(os.tmpdir(), 'capi-dl-'))
  const calls = []
  await withFetch(fakeCapibara(calls), async () => {
    const s = await run(dest, 'cbz')
    assert.equal(s.done, 1)
    assert.equal(s.pages, 2)
  })
  const workDir = path.join(dest, 'Obra')
  assert.deepEqual(await fs.readdir(workDir), ['Cap 3 - Uno.cbz'])
  const cbz = path.join(workDir, 'Cap 3 - Uno.cbz')
  assert.deepEqual((await zipEntries(cbz)).map((e) => e.name), ['001.png', '002.png'])

  // Otra vez: ya está completo y no se pide nada.
  const before = calls.length
  await withFetch(fakeCapibara(calls), async () => assert.equal((await run(dest, 'cbz')).skipped, 1))
  assert.equal(calls.length, before)

  // El CBZ se puede volver a subir: 7-Zip (el de «Varios capítulos») lo abre.
  await archives.useCacheDir(path.join(dest, 'cache'))
  const out = await archives.extract(cbz)
  assert.deepEqual((await fs.readdir(out)).filter((n) => n.endsWith('.png')), ['001.png', '002.png'])
  assert.deepEqual(await fs.readFile(path.join(out, '002.png')), PNG(2))
  await fs.rm(dest, { recursive: true, force: true })
})

test('una carpeta ya descargada se empaqueta en ZIP sin bajar nada y se deja como estaba', async () => {
  const dest = await fs.mkdtemp(path.join(os.tmpdir(), 'capi-dl-'))
  const calls = []
  await withFetch(fakeCapibara(calls), async () => assert.equal((await run(dest, 'folder')).done, 1))
  const n = calls.length
  await withFetch(fakeCapibara(calls), async () => assert.equal((await run(dest, 'zip')).done, 1))
  assert.equal(calls.length, n)
  assert.deepEqual((await fs.readdir(path.join(dest, 'Obra'))).sort(), ['Cap 3 - Uno', 'Cap 3 - Uno.zip'])
  assert.deepEqual(await fs.readdir(path.join(dest, 'Obra', 'Cap 3 - Uno')), ['001.png', '002.png'])
  await fs.rm(dest, { recursive: true, force: true })
})
