// Consumo de peticiones de «Importar de web»: turno por sitio, sin reintentos inútiles y listas
// reutilizadas. Lectores y motor se reemplazan por versiones falsas que cuentan las llamadas.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs/promises')

const response = (status, body = '', headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  text: async () => body,
  arrayBuffer: async () => Buffer.from(body),
})

const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000)])

test('si una web pide calma (429), todas sus peticiones esperan juntas', async () => {
  const { politeFetch } = require('../src/main/readers/http')
  const times = []
  const original = global.fetch
  global.fetch = async () => { times.push(Date.now()); return times.length === 1 ? response(429, '', { 'retry-after': '1' }) : response(200, 'ok') }
  try {
    await politeFetch('https://lenta.com/a')
    await Promise.all([politeFetch('https://lenta.com/b'), politeFetch('https://lenta.com/c')])
    await politeFetch('https://otra.com/x') // otra web no espera
  } finally { global.fetch = original }
  assert.ok(times[1] - times[0] >= 900 && times[2] - times[0] >= 900, 'las dos siguientes esperaron el Retry-After')
})

test('una imagen que no existe (404) se pide una sola vez', async () => {
  const { fetchImage } = require('../src/main/images')
  let calls = 0
  await assert.rejects(fetchImage('https://x/1.jpg', { fetcher: async () => { calls++; return response(404) } }), (err) => err.fatal === true)
  assert.equal(calls, 1)
})

/** Carga importer.js con un lector propio y un motor falsos. */
function loadImporter(fakeReaders, fakeScrape) {
  const set = (rel, exports) => { require.cache[require.resolve(rel)] = { id: rel, loaded: true, exports } }
  set('../src/main/readers', fakeReaders)
  set('../src/main/scrape', fakeScrape)
  delete require.cache[require.resolve('../src/main/importer')]
  return require('../src/main/importer')
}

test('lector propio: la lista se reutiliza al volver a buscar y una página rota no se reintenta', async () => {
  const counts = { list: 0, image: 0 }
  const importer = loadImporter({
    identify: (url) => ({ site: 'x', title: 'X', url }),
    list: async () => { counts.list++; return { title: 'Obra', chapters: [{ number: 1, label: 'Cap 1', url: 'https://x/c1' }] } },
    pages: async () => ({ urls: ['https://x/1.jpg', 'https://x/2.jpg'], alts: [], headers: {} }),
    image: async (url) => {
      counts.image++
      if (url.endsWith('2.jpg')) throw Object.assign(new Error('x respondió 404.'), { fatal: true })
      return JPG
    },
  }, { generation: () => 1 })
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'capi-imp-'))
  await importer.init(dir)
  const a = await importer.open('https://x/obra', 'own:x')
  await importer.release(a.key)
  const b = await importer.open('https://x/obra', 'own:x')
  assert.equal(counts.list, 1, 'la segunda búsqueda no volvió a leer la web')
  const res = await importer.download({ key: b.key, workTitle: 'Obra', chapters: [{ index: 0, number: 1 }], signal: new AbortController().signal, onProgress: () => {} })
  assert.match(res.failed[0].error, /404/)
  assert.equal(counts.image, 2, 'cada página se pidió una vez')
  await fs.rm(dir, { recursive: true, force: true })
})

test('motor: una obra soltada hace poco se reutiliza sin volver a leer la web', async () => {
  const calls = []
  const importer = loadImporter({ identify: () => null }, {
    generation: () => 1,
    forget: (key) => calls.push(['forget', key]),
    async call(method, args) {
      calls.push([method, ...args])
      return { key: 'm1', title: 'Obra', website: { id: 'sitio' }, chapters: [{ index: 0, id: 'a', title: 'a' }] }
    },
  })
  const a = await importer.open('https://web.com/obra', 'sitio')
  await importer.release(a.key)
  const b = await importer.open('https://web.com/obra', 'sitio')
  assert.equal(b.key, a.key)
  assert.equal(b.title, 'Obra')
  assert.equal(calls.filter((c) => c[0] === 'manga').length, 1)
  assert.equal(calls.filter((c) => c[0] === 'release').length, 0, 'no se liberó mientras se podía reutilizar')
})

test('motor: una imagen que falla se reintenta 2 veces, con espera', async () => {
  let tries = 0
  const importer = loadImporter({ identify: () => null }, {
    generation: () => 1,
    async call(method) {
      if (method === 'manga') return { key: 'm1', title: 'Obra', chapters: [{ index: 0, id: 'a', title: 'a' }] }
      if (method === 'pages') return { count: 1 }
      tries++
      throw new Error('El sitio tardó demasiado en responder.')
    },
  })
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'capi-eng-'))
  await importer.init(dir)
  const o = await importer.open('https://web.com/obra', 'sitio')
  const t = Date.now()
  const res = await importer.download({ key: o.key, workTitle: 'Obra', chapters: [{ index: 0, number: 1 }], signal: new AbortController().signal, onProgress: () => {} })
  assert.equal(tries, 3)
  assert.equal(res.failed.length, 1)
  assert.ok(Date.now() - t >= 2900, 'esperó 1 s y 2 s entre intentos')
  await fs.rm(dir, { recursive: true, force: true })
})
