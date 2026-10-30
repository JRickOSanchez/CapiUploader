// Uso de la API y de la memoria: ritmo por clave, lecturas compartidas, reintentos que ya llegaron,
// claves de subida que vencen y obras que se vuelven a abrir cuando el motor se cerró por inactividad.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs/promises')

const response = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => body,
})
async function withFetch(impl, fn) {
  const original = global.fetch
  global.fetch = impl
  try { return await fn() } finally { global.fetch = original }
}

test('si a la clave le quedan pocas peticiones en el minuto, espera a que se reinicie', async () => {
  const api = require('../src/main/api')
  const times = []
  await withFetch(async () => {
    times.push(Date.now())
    return response(200, { status: true, data: 1 }, { 'x-ratelimit-remaining': '2', 'x-ratelimit-reset': '1' })
  }, async () => {
    await api.request('clave-ritmo', 'POST', '/x', {})
    await api.request('clave-ritmo', 'POST', '/x', {})
  })
  assert.ok(times[1] - times[0] >= 900, `esperó ${times[1] - times[0]} ms`)
})

test('dos lecturas iguales al mismo tiempo hacen una sola petición', async () => {
  const api = require('../src/main/api')
  let calls = 0
  await withFetch(async () => {
    calls++
    await new Promise((r) => setTimeout(r, 20))
    return response(200, { status: true, data: [1] })
  }, async () => {
    const [a, b] = await Promise.all([api.request('k2', 'GET', '/works'), api.request('k2', 'GET', '/works')])
    assert.deepEqual(a, b)
    await api.request('k2', 'GET', '/works') // ya terminó: esta sí sale
  })
  assert.equal(calls, 2)
})

test('un capítulo que «ya existe» tras un corte se da por creado', async () => {
  const { uploadChapter } = require('../src/main/upload')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'capi-up-'))
  const page = path.join(dir, '001.png')
  await fs.writeFile(page, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(30)]))
  let posts = 0
  await withFetch(async (url, init = {}) => {
    if (init.method === 'PUT') return response(200, {})
    if (url.endsWith('/uploads')) return response(200, { status: true, data: { uploads: [{ uploadUrl: 'https://s/1', contentType: 'image/png', key: 'k1' }] } })
    if (init.method === 'POST') {
      posts++
      // El primer intento llega a Capibara pero la respuesta se pierde; el reintento ve el duplicado.
      return posts === 1 ? response(502, null) : response(409, { status: false, errorCode: 'api.chapter_exists', message: 'Ya existe' })
    }
    return response(200, { status: true, data: [{ id: 77, number: 9 }], pagination: { pages: 1 } })
  }, async () => {
    const ctrl = new AbortController()
    const res = await uploadChapter('k3', { workId: 5, chapter: { number: 9 }, files: [page] }, { signal: ctrl.signal })
    assert.equal(res.id, 77)
  })
  await fs.rm(dir, { recursive: true, force: true })
})

test('keepOnly deja solo las claves de los capítulos por reintentar', async () => {
  const { uploadChapter, keepOnly, cachedKeys } = require('../src/main/upload')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'capi-keep-'))
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(30)])
  const a = path.join(dir, 'a.png')
  const b = path.join(dir, 'b.png')
  await fs.writeFile(a, png)
  await fs.writeFile(b, png)
  keepOnly([])
  // Dos subidas que fallan al crear el capítulo: sus claves quedan guardadas para reintentar.
  await withFetch(async (url, init = {}) => {
    if (init.method === 'PUT') return response(200, {})
    if (url.endsWith('/uploads')) return response(200, { status: true, data: { uploads: [{ uploadUrl: 'https://s', contentType: 'image/png', key: `k${Math.random()}` }] } })
    return response(400, { status: false, errorCode: 'api.invalid_request', message: 'No' })
  }, async () => {
    for (const f of [a, b]) {
      await assert.rejects(uploadChapter('k4', { workId: 1, chapter: { number: 1 }, files: [f] }, { signal: new AbortController().signal }))
    }
  })
  assert.equal(cachedKeys(), 2)
  assert.equal(keepOnly([b]), 1)
  assert.equal(keepOnly([]), 0)
  await fs.rm(dir, { recursive: true, force: true })
})

test('si el motor se cerró por inactividad, la obra se vuelve a abrir y el capítulo se busca por id', async () => {
  const calls = []
  let generation = 1
  const fake = {
    generation: () => generation,
    start: async () => ({ websites: 1 }),
    async call(method, args) {
      calls.push([method, ...args])
      if (method === 'manga') {
        // Al reabrir, la web lista los capítulos en otro orden.
        const ids = generation === 1 ? ['a', 'b'] : ['b', 'a']
        // Como el motor real, al volver a arrancar repite sus claves: siempre «m1».
        return { key: 'm1', title: 'Obra', chapters: ids.map((id, index) => ({ index, id, title: id })) }
      }
      if (method === 'pages') return { count: 1 }
      if (method === 'image') return new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000)]))
      return true
    },
  }
  require.cache[require.resolve('../src/main/scrape')] = { id: 'scrape', loaded: true, exports: fake }
  delete require.cache[require.resolve('../src/main/importer')]
  const importer = require('../src/main/importer')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'capi-imp-'))
  await importer.init(dir)
  const opened = await importer.open('https://web.com/obra', 'sitio')
  generation = 2 // el motor se cerró por inactividad
  const res = await importer.download({ key: opened.key, workTitle: 'Obra', chapters: [{ index: 1, number: 2 }], signal: new AbortController().signal, onProgress: () => {} })
  assert.equal(res.dirs.length, 1)
  assert.equal(calls.filter((c) => c[0] === 'manga').length, 2)
  // El capítulo «b» estaba en la posición 1 y ahora en la 0, en la obra vuelta a abrir.
  assert.deepEqual(calls.find((c) => c[0] === 'pages'), ['pages', 'm1', 0])
  assert.match(opened.key, /^e\d+$/)
  await fs.rm(dir, { recursive: true, force: true })
})
