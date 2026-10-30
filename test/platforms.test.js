// Crimson Scan y Mangation contra servidores falsos: multipart por flujo, límites que pausan la
// tanda, capítulos a medias que se retoman y subidas que se cortan pero sí llegaron.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs/promises')

const { multipart, createPacer } = require('../src/main/platforms/http')
const crimson = require('../src/main/platforms/crimson')
const mangation = require('../src/main/platforms/mangation')

/** Servidor que guarda cada petición (método, ruta, cabeceras, cuerpo) y responde con handler. */
async function server(handler) {
  const calls = []
  const srv = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      const call = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) }
      calls.push(call)
      const out = await handler(call, calls)
      if (out === 'drop') { req.socket.destroy(); return }
      res.writeHead(out.status || 200, { 'content-type': 'application/json', ...(out.headers || {}) })
      res.end(out.body === undefined ? '' : JSON.stringify(out.body))
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${srv.address().port}`, calls, close: () => new Promise((r) => srv.close(r)) }
}

/** Partes de un cuerpo multipart (nombre → [valores como texto]). */
function parts(call) {
  const boundary = /boundary=(.+)$/.exec(call.headers['content-type'])[1]
  const out = {}
  for (const chunk of call.body.toString('latin1').split(`--${boundary}`).slice(1, -1)) {
    const [head, ...rest] = chunk.split('\r\n\r\n')
    const name = /name="([^"]+)"/.exec(head)[1]
    ;(out[name] ||= []).push(rest.join('\r\n\r\n').slice(0, -2))
  }
  return out
}

async function pages(n, size = 3000) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'capi-plat-'))
  const files = []
  for (let i = 0; i < n; i++) {
    const p = path.join(dir, `${String(i + 1).padStart(2, '0')}.webp`)
    await fs.writeFile(p, Buffer.alloc(size, i + 1))
    files.push({ path: p, name: path.basename(p), type: 'image/webp', size, converted: false })
  }
  return files
}

test('multipart: Content-Length exacto y los archivos se leen del disco al enviar', async () => {
  const [f] = await pages(1, 70000)
  const form = multipart([{ name: 'a', value: 'ñ"x' }, { name: 'img', path: f.path, size: f.size, filename: f.name, type: f.type }])
  let read = 0
  const chunks = []
  for await (const c of form.stream((n) => { read += n })) chunks.push(Buffer.from(c))
  const body = Buffer.concat(chunks)
  assert.equal(body.length, form.length)
  assert.equal(read, 70000)
  assert.match(body.toString('latin1'), /name="a"\r\n\r\n/)
})

test('pacer: nunca más peticiones en paralelo que el tope', async () => {
  const pacer = createPacer({ concurrency: 2, minGapMs: 0 })
  let active = 0
  let peak = 0
  await Promise.all(Array.from({ length: 8 }, async () => {
    await pacer.acquire()
    active++; peak = Math.max(peak, active)
    await new Promise((r) => setTimeout(r, 15))
    active--
    pacer.release()
  }))
  assert.equal(peak, 2)
})

test('Crimson: crea el capítulo y sube las páginas en orden con su número', async () => {
  const srv = await server((c) => {
    if (c.url === '/api/chapters') return { status: 201, body: { capituloId: 'c9', estado: 'publicado' } }
    if (c.url === '/api/upload/page') return { body: { ok: true } }
    return { status: 404, body: { error: 'no' } }
  })
  crimson.setBase(srv.url)
  try {
    const files = await pages(5)
    files[1].converted = true
    const events = []
    const res = await crimson.uploadChapter('tok', { workId: '7', chapter: { number: 12, title: 'T', notify: false }, files, onProgress: (p) => events.push(p) })
    assert.equal(res.id, 'c9')
    const create = JSON.parse(srv.calls[0].body)
    assert.deepEqual(create, { manga_id: '7', numero: 12, titulo: 'T', fecha_publicacion: null, notify_discord: false })
    assert.equal(srv.calls[0].headers.authorization, 'Bearer tok')
    const uploads = srv.calls.filter((c) => c.url === '/api/upload/page').map(parts)
    assert.equal(uploads.length, 5)
    assert.deepEqual(uploads.map((u) => u.numero[0]).sort(), ['1', '2', '3', '4', '5'])
    assert.ok(uploads.every((u) => u.capitulo_id[0] === 'c9' && u.image[0].length === 3000))
    assert.equal(uploads.filter((u) => u.converted).length, 1, 'converted=1 solo en las páginas convertidas')
    const last = events.filter((e) => e.phase === 'upload').pop()
    assert.equal(last.doneBytes, last.totalBytes)
  } finally { await srv.close() }
})

test('Crimson: si una página falla, el reintento no crea otro capítulo ni repite páginas', async () => {
  let failOn = '3'
  const srv = await server((c) => {
    if (c.url === '/api/chapters') return { status: 201, body: { capituloId: 'c1' } }
    if (parts(c).numero[0] === failOn) return { status: 400, body: { error: 'imagen rota' } }
    return { body: {} }
  })
  crimson.setBase(srv.url)
  try {
    const files = await pages(4)
    await assert.rejects(crimson.uploadChapter('tok', { workId: '1', chapter: { number: 3 }, files }), (e) => /página 3/.test(e.message) && e.partialChapterId === 'c1')
    const before = srv.calls.length
    failOn = null
    const res = await crimson.uploadChapter('tok', { workId: '1', chapter: { number: 3 }, files })
    assert.equal(res.id, 'c1')
    const again = srv.calls.slice(before)
    assert.equal(again.filter((c) => c.url === '/api/chapters').length, 0)
    assert.deepEqual(again.map((c) => parts(c).numero[0]), ['3'])
  } finally { await srv.close() }
})

test('Crimson: «máximo N capítulos cada M minutos» pausa la tanda (api.rate_limited)', async () => {
  const srv = await server(() => ({ status: 429, body: { error: 'Límite alcanzado: máximo 5 capítulos cada 30 minutos' } }))
  crimson.setBase(srv.url)
  try {
    await assert.rejects(crimson.uploadChapter('tok', { workId: '1', chapter: { number: 50 }, files: await pages(1) }),
      (e) => e.code === 'api.rate_limited' && e.retryAfter === 1800)
    assert.equal(srv.calls.length, 1, 'no se reintenta a ciegas')
  } finally { await srv.close() }
})

test('Crimson: obras y capítulos normalizados; 401 es sesión vencida', async () => {
  const srv = await server((c) => {
    if (c.url === '/api/mangas?admin=1') return { body: { mangas: [{ id: 4, titulo: 'Obra', tipo: 'manhwa', estado: 'en_curso', ultimo_capitulo: 9 }] } }
    if (c.url === '/api/mangas/4?admin=1') return { body: { manga: { id: 4, titulo: 'Obra' }, capitulos: [{ id: 1, numero: '2', estado: 'publicado' }, { id: 2, numero: '10.5', estado: 'programado', fecha_publicacion: '2026-11-01' }] } }
    return { status: 401, body: { error: 'token' } }
  })
  crimson.setBase(srv.url)
  try {
    const works = await crimson.listWorks('tok')
    assert.deepEqual([works[0].id, works[0].title, works[0].type, works[0].lastChapter], ['4', 'Obra', 'manhwa', 9])
    const ch = await crimson.listChapters('tok', '4')
    assert.deepEqual(ch.map((c) => [c.number, c.state]), [[10.5, 'scheduled'], [2, 'published']])
    await assert.rejects(crimson.listWorks('mal').then(() => crimson.getWork('x', 'nada')), (e) => e.code === 'crimson.session_expired')
  } finally { await srv.close() }
})

test('Crimson: la caducidad del token se lee del JWT', () => {
  const payload = Buffer.from(JSON.stringify({ exp: 2000000000 })).toString('base64url')
  assert.equal(crimson.jwtExpiry(`a.${payload}.b`), 2000000000 * 1000)
  assert.equal(crimson.jwtExpiry('no-es-jwt'), null)
})

test('Mangation: login guarda la cookie; el capítulo va en una sola petición con las páginas en orden', async () => {
  const srv = await server((c) => {
    if (c.url === '/api/auth/login') return { body: { user: { id: 'u1', name: 'Ana' } }, headers: { 'set-cookie': '__Host-manga_session=abc; Path=/; HttpOnly' } }
    if (c.url === '/api/mangas/mi-obra/chapters' && c.method === 'POST') return { status: 201, body: { chapter: { id: 77, pages: [1, 2, 3] } } }
    return { status: 404, body: {} }
  })
  mangation.setBase(srv.url)
  try {
    const { cookie, user } = await mangation.login('a@b.c', 'x')
    assert.equal(cookie, '__Host-manga_session=abc')
    assert.equal(user.id, 'u1')
    const files = await pages(3)
    const res = await mangation.uploadChapter(cookie, { workId: 'mi-obra', chapter: { number: 4, title: '' }, files })
    assert.equal(res.id, '77')
    const call = srv.calls.find((c) => c.method === 'POST' && c.url.endsWith('/chapters'))
    assert.equal(call.headers.cookie, cookie)
    assert.equal(Number(call.headers['content-length']), call.body.length)
    const p = parts(call)
    assert.equal(p.number[0], '4')
    assert.equal(p.title, undefined, 'sin título no se manda el campo')
    assert.deepEqual(p.pages.map((x) => x.charCodeAt(0)), [1, 2, 3])
  } finally { await srv.close() }
})

test('Mangation: si la conexión se corta pero el capítulo llegó, se da por subido (sin repetirlo)', async () => {
  const srv = await server((c) => {
    if (c.method === 'POST') return 'drop'
    return { body: { chapters: [{ id: 5, number: 8 }] } }
  })
  mangation.setBase(srv.url)
  try {
    const res = await mangation.uploadChapter('__Host-manga_session=x', { workId: 'o', chapter: { number: 8 }, files: await pages(2) })
    assert.equal(res.id, '5')
    assert.equal(srv.calls.filter((c) => c.method === 'POST').length, 1)
  } finally { await srv.close() }
})

test('Mangation: la cookie renovada por el servidor se guarda; los géneros se piden una vez', async () => {
  const saved = []
  mangation._setSessionSaver((c) => saved.push(c))
  const srv = await server((c) => (c.url === '/api/genres'
    ? { body: { genres: [{ id: 'g1', name: 'Acción' }] } }
    : { body: { mangas: [{ id: 1, slug: 's', title: 'T' }] }, headers: { 'set-cookie': '__Host-manga_session=nueva; Path=/' } }))
  mangation.setBase(srv.url)
  try {
    const works = await mangation.listWorks('__Host-manga_session=vieja', { id: 'u1' })
    assert.equal(works[0].id, 's')
    assert.match(srv.calls[0].url, /ownerId=u1/)
    assert.deepEqual(saved, ['__Host-manga_session=nueva'])
    await mangation.listGenres()
    assert.deepEqual(await mangation.listGenres(), [{ id: 'g1', name: 'Acción' }])
    assert.equal(srv.calls.filter((c) => c.url === '/api/genres').length, 1)
  } finally { await srv.close() }
})

test('Mangation: un capítulo de más de 200 MB se rechaza antes de enviarlo', async () => {
  const files = [{ path: 'x', name: 'x.webp', type: 'image/webp', size: 201 * 1024 * 1024 }]
  await assert.rejects(mangation.uploadChapter('c', { workId: 'o', chapter: { number: 1 }, files }), (e) => e.code === 'mangation.too_large')
})

test('subida a varias: el avance combina las plataformas y una omitida cuenta como lista', () => {
  const { _progressMixer } = require('../src/main/platforms')
  const events = []
  const mix = _progressMixer([{ platform: 'mangation' }, { platform: 'crimson' }], 2, 1000, (e) => events.push(e))
  const mg = mix.for('mangation', { convertShare: 0.3 })
  mix.status('crimson', 'skipped')
  mix.converted('crimson', 1) // ya omitida: no vuelve a «convirtiendo»
  assert.ok(!events.some((e) => e.platform === 'crimson' && e.status === 'converting'))
  mix.status('mangation', 'uploading')
  mg({ phase: 'file', index: 0, status: 'done' })
  assert.deepEqual(events.filter((e) => e.phase === 'file'), [{ phase: 'file', index: 0, status: 'done' }])
  mg({ phase: 'upload', doneBytes: 500, totalBytes: 1000 })
  mix.status('mangation', 'done')
  const last = events.filter((e) => e.phase === 'upload').pop()
  assert.equal(last.doneBytes, 1000)
  assert.equal(events.filter((e) => e.phase === 'file' && e.status === 'done').length, 2)
})

test('Mangation: crear obra manda ids de géneros, demografía y portada en un multipart', async () => {
  const srv = await server(() => ({ status: 201, body: { manga: { id: 'm9', slug: 'nueva', title: 'Nueva' } } }))
  mangation.setBase(srv.url)
  try {
    const [cover] = await pages(1, 5000)
    const res = await mangation.createWork('c', { id: 'u1' }, { title: ' Nueva ', type: 'manhwa', demography: 'seinen', status: 'hiatus', genres: ['g1', 'g2'], adult: true, description: 'd' }, { cover })
    assert.equal(res.id, 'nueva')
    const p = parts(srv.calls[0])
    assert.deepEqual([p.ownerId[0], p.title[0], p.type[0], p.demografy[0], p.status[0], p.adult[0], p.genres[0]], ['u1', 'Nueva', 'manhwa', 'seinen', 'hiatus', 'true', '["g1","g2"]'])
    assert.equal(p.cover[0].length, 5000)
    await assert.rejects(mangation.createWork('c', { id: 'u1' }, { title: 'x', genres: [] }, { cover }), /al menos un género/)
  } finally { await srv.close() }
})
