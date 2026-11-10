// Joints de Capibara: cómo se ven en la lista de obras, sus capítulos por número, las versiones y la
// subida (POST /joints/:id/chapters), con la API simulada.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs/promises')
const joints = require('../src/main/joints')

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

const JOINT = {
  id: 4, slug: 'obra-joint', title: 'Obra', language: 'es', type: 'manga', coverUrl: null, url: 'https://capibaratraductor.com/joint/manga/obra-joint',
  role: 'UPLOADER', memberStatus: 'ACCEPTED', canUpload: true, workId: 517, chapterCount: 40, memberCount: 3,
}
const DETAIL = {
  ...JOINT,
  members: [{ scan: { id: 12, name: 'Mi Scan', slug: 'miscan' }, role: 'UPLOADER' }, { scan: { id: 13, name: 'Otro', slug: 'otro' }, role: 'LEADER' }],
  chapters: [
    {
      number: 5, extra: false, extraNumber: null, shownChapterId: 9001, choice: { scanId: 13 }, canShowMine: true, canRelease: false,
      url: 'https://capibaratraductor.com/joint/manga/obra-joint/chapters/5',
      versions: [
        { id: 9001, number: 5, title: 'De Otro', pages: 20, state: 'published', location: 'joint', scan: { name: 'Otro' }, mine: false, public: true, shown: true },
        { id: 9002, number: 5, title: 'Mío', pages: 24, state: 'published', location: 'solo', scan: { name: 'Mi Scan' }, mine: true, public: true, shown: false },
      ],
    },
    { number: 100001, extra: true, extraNumber: 1, shownChapterId: null, canShowMine: false, canRelease: false, versions: [{ id: 9100, title: '', pages: 3, state: 'published', scan: { name: 'Mi Scan' }, mine: true }] },
  ],
}

test('un joint va en la lista de obras con id «joint:<id>» y su rol', () => {
  const w = joints.asWork(JOINT)
  assert.equal(w.id, 'joint:4')
  assert.equal(w.chapters, 40)
  assert.deepEqual(w.joint, { id: 4, role: 'UPLOADER', roleText: 'Uploader', canUpload: true, workId: 517, memberCount: 3 })
  assert.equal(joints.asWork({ ...JOINT, role: 'VIEWER', canUpload: false }).joint.roleText, 'Solo ver')
  assert.ok(joints.isJointId('joint:4'))
  assert.ok(!joints.isJointId(4) && !joints.isJointId('joint:x') && !joints.isJointId('4'))
  assert.equal(joints.jointNumber('joint:4'), 4)
  assert.throws(() => joints.jointNumber('joint:0'))
})

test('los números del joint son capítulos con la versión visible (o la propia)', () => {
  const list = joints.asChapters(DETAIL)
  assert.equal(list.length, 2)
  assert.deepEqual(list[0].joint, { mine: true, mineId: 9002, shownScan: 'Otro', versions: 2 })
  assert.equal(list[0].id, 9001)
  assert.equal(list[0].title, 'De Otro')
  // Sin versión visible: la propia.
  assert.equal(list[1].id, 9100)
  assert.equal(list[1].extra, true)
  assert.equal(list[1].extraNumber, 1)
})

test('la vista del joint dice qué se puede hacer con cada número', () => {
  const v = joints.asView(DETAIL)
  assert.equal(v.workId, 'joint:4')
  assert.equal(v.members[1].roleText, 'Líder')
  const c = v.chapters[0]
  assert.equal(c.canShowMine, true)
  assert.equal(c.chosen, true)
  assert.deepEqual(c.versions.map((x) => [x.scan, x.mine, x.shown, x.location]), [['Otro', false, true, 'joint'], ['Mi Scan', true, false, 'solo']])
})

test('detail junta todas las páginas de capítulos del joint', async () => {
  const urls = []
  await withFetch(async (url) => {
    urls.push(url)
    const page = Number(new URL(url).searchParams.get('page'))
    return response(200, { status: true, data: { ...DETAIL, chapters: [DETAIL.chapters[page - 1]] }, pagination: { page, pages: 2 } })
  }, async () => {
    const d = await joints.detail('kj1', 'joint:4')
    assert.equal(d.chapters.length, 2)
  })
  assert.equal(urls.length, 2)
  assert.ok(urls[0].includes('/joints/4?limit=200&order=desc&page=1'))
})

test('elegir y liberar la versión visible mandan el número y la versión', async () => {
  const sent = []
  await withFetch(async (url, init) => {
    sent.push([new URL(url).pathname, JSON.parse(init.body)])
    if (url.endsWith('/versions/show') && sent.length > 1) return response(409, { status: false, errorCode: 'joint_choice.taken', message: 'taken' })
    return response(200, { status: true, data: { number: 5, shownChapterId: 9002 } })
  }, async () => {
    assert.deepEqual(await joints.showVersion('kj2', 'joint:4', 5, 9002), { number: 5, shownChapterId: 9002 })
    await assert.rejects(joints.showVersion('kj2', 'joint:4', 5, 9002), /Otro scan ya eligió/)
    await joints.releaseVersion('kj2', 'joint:4', 5)
  })
  assert.deepEqual(sent.map((s) => s[0]), ['/api/v1/joints/4/versions/show', '/api/v1/joints/4/versions/show', '/api/v1/joints/4/versions/release'])
  assert.deepEqual(sent[0][1], { number: 5, chapterId: 9002 })
  assert.deepEqual(sent[2][1], { number: 5 })
})

async function onePage() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'capi-joint-'))
  const page = path.join(dir, '001.png')
  await fs.writeFile(page, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(30)]))
  return { dir, page }
}

test('subir a un joint usa POST /joints/:id/chapters', async () => {
  const { uploadChapter } = require('../src/main/upload')
  const { dir, page } = await onePage()
  let created = null
  await withFetch(async (url, init = {}) => {
    if (init.method === 'PUT') return response(200, {})
    if (url.endsWith('/uploads')) return response(200, { status: true, data: { uploads: [{ uploadUrl: 'https://s.example/1', contentType: 'image/png', key: 'kj' }] } })
    created = [new URL(url).pathname, JSON.parse(init.body)]
    return response(201, { status: true, data: { id: 9500, number: 6, jointId: 4, quedoEnFicha: false, ocupadoPor: null } })
  }, async () => {
    const res = await uploadChapter('kj3', { workId: 'joint:4', chapter: { number: 6, title: 'T' }, files: [page] }, { signal: new AbortController().signal })
    assert.equal(res.id, 9500)
  })
  assert.equal(created[0], '/api/v1/joints/4/chapters')
  assert.deepEqual(created[1], { number: 6, pages: ['kj'], title: 'T' })
  await fs.rm(dir, { recursive: true, force: true })
})

test('un scan que solo puede ver recibe un error claro al subir al joint', async () => {
  const { uploadChapter } = require('../src/main/upload')
  const { dir, page } = await onePage()
  await withFetch(async (url, init = {}) => {
    if (init.method === 'PUT') return response(200, {})
    if (url.endsWith('/uploads')) return response(200, { status: true, data: { uploads: [{ uploadUrl: 'https://s.example/2', contentType: 'image/png', key: 'kv' }] } })
    return response(403, { status: false, errorCode: 'api.joint_viewer', message: 'Forbidden' })
  }, async () => {
    await assert.rejects(
      uploadChapter('kj4', { workId: 'joint:4', chapter: { number: 7 }, files: [page] }, { signal: new AbortController().signal }),
      (e) => e.code === 'api.joint_viewer' && /solo puede ver/.test(e.message))
  })
  await fs.rm(dir, { recursive: true, force: true })
})

test('la lista de obras de Capibara trae también los joints, y sin joints igual funciona', async () => {
  const platforms = require('../src/main/platforms')
  let failJoints = false
  const impl = async (url) => {
    if (url.includes('/joints')) return failJoints ? response(403, { status: false, errorCode: 'api.scope_missing', message: 'x' }) : response(200, { status: true, data: [JOINT], pagination: { pages: 1 } })
    return response(200, { status: true, data: [{ id: 1, title: 'Propia' }], pagination: { pages: 1 } })
  }
  await withFetch(impl, async () => {
    assert.deepEqual((await platforms.works('capibara', () => 'kj5')).map((w) => w.id), [1, 'joint:4'])
    failJoints = true
    assert.deepEqual((await platforms.works('capibara', () => 'kj6')).map((w) => w.id), [1])
  })
})
