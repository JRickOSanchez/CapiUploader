// MangaDex contra un servidor falso local (nunca contra api.mangadex.org ni api.mangadex.dev):
// sesión OAuth y renovación, obras del grupo y agregadas, capítulos, y la subida por sesión
// (archivos de 10 en 10, commit con pageOrder y termsAccepted, sesión que se abandona si falla).
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs/promises')

const store = require('../src/main/store')
const mangadex = require('../src/main/platforms/mangadex')

const MANGA = '11111111-1111-4111-8111-111111111111'
const GROUP = '22222222-2222-4222-8222-222222222222'
const USER_ID = '33333333-3333-4333-8333-333333333333'
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

let tmp
before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'capi-mdx-'))
  store.init(tmp)
})
after(async () => { await fs.rm(tmp, { recursive: true, force: true }) })

/** Servidor falso: guarda cada petición y responde con handler(call). */
async function server(handler) {
  const calls = []
  const srv = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      const call = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) }
      calls.push(call)
      const out = (await handler(call, calls)) || { status: 404, body: { result: 'error', errors: [{ status: 404, title: 'not_found', detail: 'No existe' }] } }
      if (out === 'drop') { req.socket.destroy(); return }
      res.writeHead(out.status || 200, { 'content-type': 'application/json', ...(out.headers || {}) })
      res.end(out.body === undefined ? '' : JSON.stringify(out.body))
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${srv.address().port}`
  mangadex.setBase(url, url)
  return { url, calls, close: () => new Promise((r) => srv.close(r)) }
}

/** Nombres de campo y de archivo de un cuerpo multipart. */
function multipartFiles(call) {
  const boundary = /boundary=(.+)$/.exec(call.headers['content-type'])[1]
  return call.body.toString('latin1').split(`--${boundary}`).slice(1, -1).map((chunk) => {
    const head = chunk.split('\r\n\r\n')[0]
    return { field: /name="([^"]+)"/.exec(head)[1], filename: /filename="([^"]+)"/.exec(head)?.[1] }
  })
}

const PNG = (w, h) => {
  const b = Buffer.alloc(40)
  b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4)
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20)
  return b
}

async function pages(n, buf = PNG(800, 1200)) {
  const dir = await fs.mkdtemp(path.join(tmp, 'pages-'))
  const files = []
  for (let i = 0; i < n; i++) {
    const p = path.join(dir, `${String(i + 1).padStart(2, '0')}.png`)
    await fs.writeFile(p, buf)
    files.push({ path: p, name: path.basename(p), type: 'image/png', size: buf.length })
  }
  return files
}

const SETTINGS = { groups: [{ id: GROUP, name: 'Mi Scan' }], noGroup: false, lang: 'es-la', termsAcceptedAt: '2026-11-09T00:00:00Z' }

/** Servidor que se comporta como la API de subida. */
function uploadApi({ failCommit = false, existing = null } = {}) {
  let session = existing
  let fileSeq = 0
  return (c) => {
    if (c.url === '/upload/check-approval-required') return { body: { result: 'ok', requiresApproval: true } }
    if (c.url === '/upload' && c.method === 'GET') return session ? { body: { result: 'ok', data: { id: session } } } : null
    if (c.url.startsWith('/upload/') && c.method === 'DELETE') { session = null; return { body: { result: 'ok' } } }
    if (c.url === '/upload/begin') { session = uuid(900); return { body: { result: 'ok', data: { id: session, type: 'upload_session' } } } }
    if (c.url === `/upload/${uuid(900)}` && c.method === 'POST') {
      return { body: { result: 'ok', errors: [], data: multipartFiles(c).map((p) => ({ id: uuid(++fileSeq), type: 'upload_session_file', attributes: { originalFileName: p.filename } })) } }
    }
    if (c.url === `/upload/${uuid(900)}/commit`) {
      if (failCommit) return { status: 400, body: { result: 'error', errors: [{ status: 400, title: 'bad', detail: 'El capítulo ya existe.' }] } }
      session = null
      return { body: { result: 'ok', data: { id: uuid(777), type: 'chapter' } } }
    }
    return null
  }
}

test('MangaDex: inicio de sesión con el cliente personal; se guarda el refresh_token, no la contraseña', async () => {
  const srv = await server((c) => {
    if (c.url.endsWith('/token')) return { body: { access_token: 'acc1', refresh_token: 'ref1', expires_in: 900 } }
    if (c.url === '/user/me') return { body: { result: 'ok', data: { id: USER_ID, attributes: { username: 'ana' } } } }
    return null
  })
  try {
    const st = await mangadex.signIn({ username: 'ana', password: 'secreta', clientId: 'personal-client-x', clientSecret: 'sec' })
    assert.equal(st.loggedIn, true)
    assert.equal(st.user.username, 'ana')
    const tokenCall = srv.calls[0]
    assert.equal(tokenCall.headers['content-type'], 'application/x-www-form-urlencoded')
    assert.deepEqual(Object.fromEntries(new URLSearchParams(tokenCall.body.toString())), {
      grant_type: 'password', username: 'ana', password: 'secreta', client_id: 'personal-client-x', client_secret: 'sec',
    })
    assert.equal(srv.calls[1].headers.authorization, 'Bearer acc1')
    const saved = JSON.parse(store.getSecret('mangadexAuth'))
    assert.deepEqual(saved, { refreshToken: 'ref1', clientId: 'personal-client-x', clientSecret: 'sec' })
    assert.ok(!JSON.stringify(store.get('mangadexUser')).includes('secreta'))
  } finally { await srv.close() }
})

test('MangaDex: credenciales malas y cliente no aprobado dan mensajes claros', async () => {
  const srv = await server((c) => {
    const f = Object.fromEntries(new URLSearchParams(c.body.toString()))
    if (f.client_id === 'malo') return { status: 401, body: { error: 'invalid_client' } }
    return { status: 401, body: { error: 'invalid_grant', error_description: 'Invalid user credentials' } }
  })
  try {
    await assert.rejects(mangadex.login({ username: 'a', password: 'b', clientId: 'malo', clientSecret: 'x' }), (e) => e.code === 'mangadex.bad_client')
    await assert.rejects(mangadex.login({ username: 'a', password: 'b', clientId: 'c', clientSecret: 'x' }), (e) => e.code === 'mangadex.bad_credentials')
    await assert.rejects(mangadex.login({ username: 'a', password: 'b' }), (e) => e.code === 'mangadex.bad_client')
  } finally { await srv.close() }
})

test('MangaDex: un 401 renueva el token una vez y repite; si la renovación falla, la sesión se cierra', async () => {
  let refreshes = 0
  let failRefresh = false
  const srv = await server((c) => {
    if (c.url.endsWith('/token')) {
      refreshes++
      return failRefresh ? { status: 400, body: { error: 'invalid_grant' } } : { body: { access_token: `acc-r${refreshes}`, refresh_token: `ref-r${refreshes}`, expires_in: 900 } }
    }
    if (c.url === '/user/me') return c.headers.authorization === 'Bearer acc-r2' ? { body: { result: 'ok', data: { id: USER_ID } } } : { status: 401, body: {} }
    return null
  })
  try {
    store.setSecret('mangadexAuth', JSON.stringify({ refreshToken: 'ref0', clientId: 'c', clientSecret: 's' }))
    mangadex.setBase(srv.url, srv.url) // olvida el token en memoria
    const me = await mangadex.withSession(async (t) => (await fetch(`${srv.url}/user/me`, { headers: { authorization: `Bearer ${t}` } })).status === 401
      ? Promise.reject(Object.assign(new Error('x'), { code: 'mangadex.session_expired' }))
      : t)
    assert.equal(me, 'acc-r2')
    assert.equal(JSON.parse(store.getSecret('mangadexAuth')).refreshToken, 'ref-r2', 'se guarda el refresh_token rotado')
    failRefresh = true
    await assert.rejects(mangadex.accessToken({ force: true }), (e) => e.code === 'mangadex.session_expired')
    assert.equal(store.getSecret('mangadexAuth'), null)
  } finally { await srv.close() }
})

test('MangaDex: obras del grupo y agregadas, sin repetir; capítulos del grupo en el idioma de la cuenta', async () => {
  const work = (id, title) => ({ id, type: 'manga', attributes: { title: { en: title }, altTitles: [{ 'es-la': `${title} ES` }], contentRating: 'safe', originalLanguage: 'ko' },
    relationships: [{ type: 'cover_art', attributes: { fileName: 'c.jpg' } }] })
  const srv = await server((c) => {
    const u = new URL(c.url, 'http://x')
    if (u.pathname === '/manga' && u.searchParams.get('group') === GROUP) return { body: { result: 'ok', data: [work(MANGA, 'Uno')], total: 1 } }
    if (u.pathname === '/manga' && u.searchParams.getAll('ids[]').length) return { body: { result: 'ok', data: u.searchParams.getAll('ids[]').map((id) => work(id, 'Otra')), total: 2 } }
    if (u.pathname === '/chapter') {
      return { body: { result: 'ok', total: 2, data: [
        { id: uuid(1), attributes: { chapter: '12', volume: '2', title: 'T', pages: 20, translatedLanguage: 'es-la', publishAt: '2020-01-01T00:00:00+00:00' } },
        { id: uuid(2), attributes: { chapter: null, title: 'Oneshot', pages: 5 } },
      ] } }
    }
    return null
  })
  try {
    store.setSecret('mangadexAuth', null)
    mangadex.addWork(MANGA)
    mangadex.addWork(uuid(55))
    const works = await mangadex.listWorks('tok', {}, undefined, SETTINGS)
    assert.deepEqual(works.map((w) => [w.id, w.title, w.type]), [[MANGA, 'Uno ES', 'manhwa'], [uuid(55), 'Otra ES', 'manhwa']])
    assert.equal(works[0].coverUrl, `https://uploads.mangadex.org/covers/${MANGA}/c.jpg.256.jpg`)
    const ch = await mangadex.listChapters('tok', MANGA, undefined, SETTINGS, { id: USER_ID })
    assert.deepEqual(ch.map((c) => [c.number, c.volumeNumber, c.state]), [[12, 2, 'published']])
    const q = new URL(srv.calls.find((c) => c.url.startsWith('/chapter')).url, 'http://x').searchParams
    assert.equal(q.get('manga'), MANGA)
    assert.deepEqual(q.getAll('translatedLanguage[]'), [], 'se piden todos los idiomas: cada capítulo trae el suyo')
    assert.equal(ch[0].lang, 'es-la')
    assert.deepEqual(q.getAll('groups[]'), [GROUP])
    assert.equal(q.get('uploader'), null)
    // Sin grupo: lo subido por la cuenta.
    await mangadex.listChapters('tok', MANGA, undefined, { ...SETTINGS, groups: [], noGroup: true }, { id: USER_ID })
    const q2 = new URL(srv.calls.filter((c) => c.url.startsWith('/chapter')).at(-1).url, 'http://x').searchParams
    assert.equal(q2.get('uploader'), USER_ID)
  } finally { mangadex.removeWork(MANGA); mangadex.removeWork(uuid(55)); await srv.close() }
})

test('MangaDex: la subida va de 10 en 10 y el commit lleva los datos, el orden de páginas y termsAccepted', async () => {
  const srv = await server(uploadApi())
  try {
    const files = await pages(23)
    const events = []
    const res = await mangadex.uploadChapter('tok', {
      user: { id: USER_ID }, settings: SETTINGS, workId: MANGA,
      chapter: { number: 12.5, title: 'El regreso', volumeNumber: 3, publishAt: new Date(Date.now() + 3600e3).toISOString() },
      files, onProgress: (p) => events.push(p),
    })
    assert.equal(res.id, uuid(777))
    assert.equal(res.review, true)
    assert.equal(res.state, 'scheduled')
    const begin = srv.calls.find((c) => c.url === '/upload/begin')
    assert.deepEqual(JSON.parse(begin.body), { manga: MANGA, groups: [GROUP] })
    const uploads = srv.calls.filter((c) => c.method === 'POST' && c.url === `/upload/${uuid(900)}`)
    assert.deepEqual(uploads.map((c) => multipartFiles(c).length), [10, 10, 3])
    assert.deepEqual(multipartFiles(uploads[0]).slice(0, 2), [{ field: 'file1', filename: '001.png' }, { field: 'file2', filename: '002.png' }])
    const commit = JSON.parse(srv.calls.find((c) => c.url.endsWith('/commit')).body)
    assert.equal(commit.termsAccepted, true)
    assert.deepEqual(commit.pageOrder, Array.from({ length: 23 }, (_, i) => uuid(i + 1)))
    assert.deepEqual({ ...commit.chapterDraft, publishAt: undefined }, { volume: '3', chapter: '12.5', title: 'El regreso', translatedLanguage: 'es-la', publishAt: undefined })
    assert.match(commit.chapterDraft.publishAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/)
    assert.ok(events.some((e) => e.phase === 'file' && e.index === 22 && e.status === 'done'))
  } finally { await srv.close() }
})

test('MangaDex: si el commit falla, la sesión de subida se abandona; una sesión ajena no se toca', async () => {
  const srv = await server(uploadApi({ failCommit: true }))
  try {
    await assert.rejects(mangadex.uploadChapter('tok', { settings: SETTINGS, workId: MANGA, chapter: { number: 1 }, files: await pages(2) }), /ya existe/)
    assert.ok(srv.calls.some((c) => c.method === 'DELETE' && c.url === `/upload/${uuid(900)}`))
  } finally { await srv.close() }

  const other = await server(uploadApi({ existing: uuid(5) }))
  try {
    await assert.rejects(mangadex.uploadChapter('tok', { settings: SETTINGS, workId: MANGA, chapter: { number: 1 }, files: await pages(1) }), (e) => e.code === 'mangadex.session_busy')
    assert.ok(!other.calls.some((c) => c.method === 'DELETE'))
    assert.ok(!other.calls.some((c) => c.url === '/upload/begin'))
  } finally { await other.close() }
})

test('MangaDex: sin aceptar las reglas, o con páginas que no acepta, no se empieza a subir', async () => {
  const srv = await server(uploadApi())
  try {
    await assert.rejects(mangadex.uploadChapter('tok', { settings: { ...SETTINGS, termsAcceptedAt: null }, workId: MANGA, chapter: { number: 1 }, files: await pages(1) }), (e) => e.code === 'mangadex.terms')
    const webps = (await pages(1)).map((f) => ({ ...f, type: 'image/webp' }))
    await assert.rejects(mangadex.uploadChapter('tok', { settings: SETTINGS, workId: MANGA, chapter: { number: 1 }, files: webps }), /solo acepta JPG, PNG o GIF/)
    const heavy = (await pages(16)).map((f) => ({ ...f, size: 19 * 1024 * 1024 }))
    await assert.rejects(mangadex.uploadChapter('tok', { settings: SETTINGS, workId: MANGA, chapter: { number: 1 }, files: heavy }), /300 MB/)
    assert.equal(srv.calls.length, 0)
  } finally { await srv.close() }
})

test('MangaDex: qué páginas hay que convertir', async () => {
  const [ok] = await pages(1, PNG(900, 9999))
  const [tall] = await pages(1, PNG(800, 10000))
  assert.equal(await mangadex.needsConversion(ok), false)
  assert.equal(await mangadex.needsConversion(tall), true)
  assert.equal(await mangadex.needsConversion({ ...ok, type: 'image/webp' }), true)
  assert.equal(await mangadex.needsConversion({ ...ok, size: 20 * 1024 * 1024 }), true)
  assert.equal(mangadex.pickTitle({ title: { ja: 'X' }, altTitles: [{ es: 'Hola' }] }, 'es-la'), 'Hola')
  assert.equal(mangadex.publishAtValue('2000-01-01T00:00:00Z'), null)
})

test('MangaDex: un 429 pausa hasta la hora que indica X-RateLimit-Retry-After', async () => {
  let n = 0
  const srv = await server((c) => {
    if (c.url.startsWith('/group')) {
      n++
      if (n === 1) return { status: 429, headers: { 'x-ratelimit-retry-after': String(Math.ceil(Date.now() / 1000) + 1) }, body: { result: 'error', errors: [] } }
      return { body: { result: 'ok', data: [{ id: GROUP, attributes: { name: 'Mi Scan' } }] } }
    }
    return null
  })
  try {
    const t = Date.now()
    const groups = await mangadex.searchGroups('tok', 'mi scan')
    assert.deepEqual(groups, [{ id: GROUP, name: 'Mi Scan' }])
    assert.ok(Date.now() - t >= 900, `esperó ${Date.now() - t} ms`)
  } finally { await srv.close() }
})

test('MangaDex (reglas): sin grupos no se sube, salvo «Sin grupo» confirmado; se marcan todos los grupos', async () => {
  const OTHER = '44444444-4444-4444-8444-444444444444'
  const srv = await server(uploadApi())
  try {
    await assert.rejects(mangadex.uploadChapter('tok', { settings: { ...SETTINGS, groups: [] }, workId: MANGA, chapter: { number: 1 }, files: await pages(1) }), (e) => e.code === 'mangadex.no_group')
    assert.equal(srv.calls.length, 0)
    await mangadex.uploadChapter('tok', { settings: { ...SETTINGS, groups: [], noGroup: true }, workId: MANGA, chapter: { number: 1 }, files: await pages(1) })
    assert.deepEqual(JSON.parse(srv.calls.find((c) => c.url === '/upload/begin').body).groups, [])
    await mangadex.uploadChapter('tok', { settings: { ...SETTINGS, groups: [{ id: GROUP, name: 'A' }, { id: OTHER, name: 'B' }] }, workId: MANGA, chapter: { number: 2 }, files: await pages(1) })
    assert.deepEqual(JSON.parse(srv.calls.filter((c) => c.url === '/upload/begin').at(-1).body).groups, [GROUP, OTHER])
  } finally { await srv.close() }
})

test('MangaDex (reglas): el título no lleva descriptores inventados; «Censored/Uncensored» sí', async () => {
  for (const t of ['El regreso [HQ]', 'El regreso v2', 'Cap (LQ)', '[Senshi Scan] El regreso', 'El regreso {raw}']) {
    assert.ok(mangadex.titleDescriptor(t), t)
  }
  for (const t of ['El regreso', 'El regreso (Uncensored)', 'El regreso [Censored]', 'Hacia el v-day', 'La versión final', '']) {
    assert.equal(mangadex.titleDescriptor(t), null, t)
  }
  const srv = await server(uploadApi())
  try {
    await assert.rejects(mangadex.uploadChapter('tok', { settings: SETTINGS, workId: MANGA, chapter: { number: 1, title: 'Uno [HQ]' }, files: await pages(1) }), (e) => e.code === 'mangadex.title' && /\[HQ\]/.test(e.message))
    assert.equal(srv.calls.length, 0)
  } finally { await srv.close() }
})

test('MangaDex (reglas): hasta 300 MB por capítulo; la primera beta con un solo grupo se lee como lista', () => {
  const page = (mb) => ({ name: 'x.jpg', type: 'image/jpeg', size: mb * 1024 * 1024 })
  assert.doesNotThrow(() => mangadex.checkPages(Array.from({ length: 16 }, () => page(18))))
  assert.throws(() => mangadex.checkPages(Array.from({ length: 17 }, () => page(18))), /300 MB/)
  store.set('mangadexSettings', { group: { id: GROUP, name: 'Viejo' }, lang: 'es', termsAcceptedAt: 'x' })
  assert.deepEqual(mangadex.getSettings().groups, [{ id: GROUP, name: 'Viejo' }])
  const s = mangadex.setSettings({ groups: [], noGroup: true })
  assert.deepEqual([s.groups, s.noGroup], [[], true])
  assert.equal(mangadex.setSettings({ groups: [{ id: GROUP, name: 'A' }] }).noGroup, false, '«Sin grupo» se apaga al elegir un grupo')
})

test('MangaDex: cada capítulo puede ir en su idioma; sin idioma va el de la cuenta', async () => {
  const srv = await server(uploadApi())
  try {
    const en = await mangadex.uploadChapter('tok', { settings: SETTINGS, workId: MANGA, chapter: { number: 3, lang: 'en' }, files: await pages(1) })
    assert.equal(en.lang, 'en')
    const commits = () => srv.calls.filter((c) => c.url.endsWith('/commit')).map((c) => JSON.parse(c.body).chapterDraft.translatedLanguage)
    const approvals = () => srv.calls.filter((c) => c.url === '/upload/check-approval-required').map((c) => JSON.parse(c.body).locale)
    await mangadex.uploadChapter('tok', { settings: SETTINGS, workId: MANGA, chapter: { number: 4 }, files: await pages(1) })
    await mangadex.uploadChapter('tok', { settings: SETTINGS, workId: MANGA, chapter: { number: 5, lang: 'klingon' }, files: await pages(1) })
    assert.deepEqual(commits(), ['en', 'es-la', 'es-la'], 'un idioma que no está en la lista usa el de la cuenta')
    assert.deepEqual(approvals(), ['en', 'es-la', 'es-la'], 'la revisión del staff se consulta en el idioma del capítulo')
  } finally { await srv.close() }
})
