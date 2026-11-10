// Comprimidos como capítulos: se arman zip, 7z y tar con el mismo 7-Zip (WASM) y se abren como lo
// haría la app en «Un capítulo» y «Varios capítulos».
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs/promises')
const archives = require('../src/main/archives')
const files = require('../src/main/files')

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)])
let tmp

/** Arma un comprimido con lo que haya en `src` (rutas relativas a esa carpeta). */
async function pack(src, out, type) {
  const SevenZip = require('7z-wasm')
  const sz = await SevenZip({ print: () => {}, printErr: () => {} })
  sz.FS.mkdir('/w')
  sz.FS.mount(sz.NODEFS, { root: tmp }, '/w')
  sz.FS.chdir(`/w/${src}`)
  const code = sz.callMain(['a', `-t${type}`, `../${out}`, '*'])
  assert.equal(code, 0)
  return path.join(tmp, out)
}

async function write(rel, buf = PNG) {
  const p = path.join(tmp, rel)
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, buf)
}

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'capi-arch-'))
  await archives.useCacheDir(path.join(tmp, 'cache'))
  // Un capítulo con las páginas sueltas y basura que no se debe extraer.
  for (const n of ['10', '2', '1']) await write(`uno/${n}.png`)
  await write('uno/notas.txt', Buffer.from('hola'))
  await write('uno/__MACOSX/._1.png', Buffer.from('x'))
  // Una obra con dos capítulos en carpetas.
  for (const c of ['Cap 1', 'Cap 2']) for (const n of ['1', '2']) await write(`obra/${c}/${n}.png`)
  await write('nada/leeme.txt', Buffer.from('sin imágenes'))
})

after(async () => { await fs.rm(tmp, { recursive: true, force: true }) })

test('reconoce los comprimidos comunes por su extensión', () => {
  for (const f of ['a.zip', 'a.CBZ', 'a.rar', 'a.cbr', 'a.7z', 'a.cb7', 'a.tar', 'a.cbt', 'a.tar.gz', 'a.tgz', 'a.tar.xz']) assert.ok(archives.isArchive(f), f)
  assert.ok(!archives.isArchive('a.png') && !archives.isArchive('a.psd'))
  assert.equal(archives.archiveTitle('C:/x/Cap 3.cbz'), 'Cap 3')
  assert.equal(archives.archiveTitle('/x/Obra.tar.gz'), 'Obra')
})

test('«Un capítulo»: un comprimido da sus imágenes en orden, sin la basura', async () => {
  const zip = await pack('uno', 'Cap 7.cbz', 'zip')
  const res = await files.resolvePaths([zip])
  assert.deepEqual(res.problems, [])
  assert.deepEqual(res.files.map((f) => f.name), ['1.png', '2.png', '10.png'])
})

test('«Varios capítulos»: un comprimido con varias carpetas da un capítulo por carpeta', async () => {
  const sevenz = await pack('obra', 'Kirara.7z', '7z')
  const res = await files.resolveChapters([sevenz])
  assert.deepEqual(res.chapters.map((c) => [c.name, c.files.length, c.archive, c.ancestors[0]]), [
    ['Cap 1', 2, 'Kirara.7z', 'Kirara'],
    ['Cap 2', 2, 'Kirara.7z', 'Kirara'],
  ])
})

test('«Varios capítulos»: una carpeta con comprimidos toma cada uno como capítulo con su nombre', async () => {
  await fs.mkdir(path.join(tmp, 'lote', 'Mi Obra'), { recursive: true })
  await pack('uno', 'lote/Mi Obra/Cap 3.zip', 'zip')
  await pack('uno', 'lote/Mi Obra/Cap 4.tar', 'tar')
  const res = await files.resolveChapters([path.join(tmp, 'lote')])
  assert.deepEqual(res.chapters.map((c) => [c.name, c.files.length, c.ancestors[0]]), [['Cap 3', 3, 'Mi Obra'], ['Cap 4', 3, 'Mi Obra']])
  // La segunda vez se usa lo ya extraído.
  const again = await files.resolveChapters([path.join(tmp, 'lote')])
  assert.deepEqual(again.chapters.map((c) => c.dir), res.chapters.map((c) => c.dir))
})

test('un comprimido sin imágenes o dañado se informa sin romper lo demás', async () => {
  const empty = await pack('nada', 'vacio.zip', 'zip')
  const broken = path.join(tmp, 'roto.rar')
  await fs.writeFile(broken, Buffer.from('esto no es un rar'))
  const good = path.join(tmp, 'Cap 7.cbz')
  const res = await files.resolveChapters([empty, broken, good])
  assert.equal(res.chapters.length, 1)
  assert.deepEqual(res.problems.map((p) => p.name), ['vacio.zip', 'roto.rar'])
  assert.match(res.problems[0].message, /No tiene imágenes/)
  assert.match(res.problems[1].message, /dañado|no es un comprimido/)
})

test('la lista de 7-Zip se lee bien y se avisa de las contraseñas', () => {
  const text = 'Path = Cap 1/01.png\nFolder = -\nSize = 2048\nEncrypted = +\n\nPath = Cap 1\nFolder = +\nSize = 0\n\nPath = __MACOSX/._01.png\nSize = 10\n'
  const entries = archives.parseListing(text)
  assert.equal(entries.length, 3)
  const { pages, bytes, encrypted } = archives.pagesIn(entries)
  assert.deepEqual(pages.map((p) => p.path), ['Cap 1/01.png'])
  assert.equal(bytes, 2048)
  assert.equal(encrypted, true)
  assert.equal(archives.explain('ERROR: x.rar : Cannot open encrypted archive. Wrong password?').code, 'archive.password')
  assert.equal(archives.explain('', true).code, 'archive.broken')
})
