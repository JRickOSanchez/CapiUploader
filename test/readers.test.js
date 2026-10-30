// Lectores propios de «Importar de web» y creación de obras (funciones puras, sin red).
const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const readers = require('../src/main/readers')
const html = require('../src/main/readers/html')
const mangatv = require('../src/main/readers/sites/mangatv')
const onf = require('../src/main/readers/sites/onf')
const mangadex = require('../src/main/readers/sites/mangadex')
const tmo = require('../src/main/readers/sites/tmo')
const enchilada = require('../src/main/readers/sites/enchilada')
const works = require('../src/main/works')

test('identify reconoce cada sitio y rechaza las URLs de capítulos', () => {
  const ok = {
    'https://mangatv.net/manga/2870/owari-no-seraph': 'mangatv',
    'https://onfmangas.com/manga/10303/literary-link': 'onf',
    'https://mangadex.org/title/a77742b1-befd-49a4-bff5-1ad4e6b0ef7b/chainsaw-man': 'mangadex',
    'https://shademanga.com/serie/100007': 'shade',
    'https://readdarkgathering.com/': 'dark',
    'https://enchiladascan.github.io/enchiladaweb/ririsa/inicio': 'enchilada',
    'https://zonatmo.org/library/manga/1682/gachiakuta': 'tmo',
  }
  for (const [url, site] of Object.entries(ok)) assert.equal(readers.identify(url)?.site, site, url)
  assert.equal(readers.identify('https://mangadex.org/title/a77742b1-befd-49a4-bff5-1ad4e6b0ef7b/x').id, 'a77742b1-befd-49a4-bff5-1ad4e6b0ef7b')
  for (const url of ['https://mangatv.net/leer/abc', 'https://onfmangas.com/lector/1/x', 'https://zonatmo.org/view_uploads/5', 'https://mangadex.org/chapter/x']) {
    assert.match(readers.identify(url).error, /capítulo/, url)
  }
  assert.equal(readers.identify('https://otraweb.com/manga/x'), null)
  assert.equal(readers.identify('no es una url'), null)
})

test('pageTitle quita el nombre del sitio y las frases de relleno', () => {
  assert.equal(html.pageTitle('<title>Ver Gachiakuta Online Gratis | ZonaTMO</title>', 'ZonaTMO'), 'Gachiakuta')
  assert.equal(html.pageTitle('<title>Literary Link - Leer Online en Español</title>'), 'Literary Link')
  assert.equal(html.pageTitle('<meta property="og:title" content="Owari no Seraph Manga en Español">'), 'Owari no Seraph')
  assert.equal(html.slugTitle('https://web.com/manga/mi-obra-genial/'), 'Mi obra genial')
})

test('unpackJs desempaqueta un script p,a,c,k,e,d sin ejecutarlo', () => {
  const packed = "eval(function(p,a,c,k,e,d){return p}('0 1=\\'2\\';',3,3,'var|x|hola'.split('|'),0,{}))"
  assert.equal(html.unpackJs(packed), "var x='hola';")
  assert.equal(html.unpackJs('sin script'), null)
})

test('MangaTV: descifra la lista de páginas y salta las señuelo', () => {
  const key = crypto.randomBytes(32)
  const iv = crypto.randomBytes(12)
  const plain = JSON.stringify({ p: ['https://img/1.jpg', 'https://mangatv.net/falsa.webp', '//img/2.jpg'], s: [1] })
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()])
  const page = `<script>ReaderBlob.start(${JSON.stringify({ k: key.toString('base64'), iv: iv.toString('base64'), c: data.toString('base64') })})</script>`
  assert.deepEqual(mangatv.parsePages(page), ['https://img/1.jpg', 'https:////img/2.jpg'.replace('https:////', 'https://')])
  assert.deepEqual(mangatv.parsePages('ts_reader.run({"sources":[{"images":["https://a/1.jpg"]}]})'), ['https://a/1.jpg'])
})

test('MangaTV: título, espejo y scan de cada fila', () => {
  const row = `<li data-num="1.00"><span class="chapternum">Capítulo 1</span>
    <span class="chapternum">  El contenedor      ZonaTMO | Karneval -Fansub-</span>
    <span class="chapterdate">2014-08-30</span><a href="https://mangatv.net/leer/f533ce" class="dload"></a></li>`
  assert.deepEqual(mangatv.parseChapters(row), [{
    number: 1, label: 'Capítulo 1 - El contenedor', group: 'Karneval -Fansub- · vía ZonaTMO', date: '2014-08-30', url: 'https://mangatv.net/leer/f533ce',
  }])
})

test('ONF: capítulos y páginas incrustados en hexadecimal, con copia de respaldo', () => {
  const hex = (v) => Buffer.from(JSON.stringify(v)).toString('hex')
  const work = `<script>const _hex = "${hex([{ url: '/lector/1/obra-capitulo-1', numero: '1', titulo_str: 'Capítulo 1', grupos_list: [{ nombre: 'Cliv' }], otras_versiones: [{ url: '/lector/2/obra-capitulo-1', grupo_cap_nombres: 'Otro' }] }])}"</script>`
  assert.deepEqual(onf.parseChapters(work).map((c) => [c.number, c.group, c.url]), [
    [1, 'Cliv', 'https://onfmangas.com/lector/1/obra-capitulo-1'],
    [1, 'Otro', 'https://onfmangas.com/lector/2/obra-capitulo-1'],
  ])
  const chapter = `const _hexP = "${hex([{ src: 'https://a.mangadex.network/1.jpg', fallback: 'https://uploads.mangadex.org/1.jpg' }])}"`
  assert.deepEqual(onf.parsePages(chapter), [{ url: 'https://a.mangadex.network/1.jpg', alt: 'https://uploads.mangadex.org/1.jpg' }])
})

test('MangaDex: idioma, scan, tomo y sin capítulos externos', () => {
  const feed = { data: [
    { id: 'c1', attributes: { chapter: '2', volume: '1', title: 'Hola', translatedLanguage: 'es-la', pages: 20 }, relationships: [{ type: 'scanlation_group', attributes: { name: 'Mi Scan' } }] },
    { id: 'c2', attributes: { chapter: '3', externalUrl: 'https://x', pages: 0 } },
  ] }
  assert.deepEqual(mangadex.parseChapters(feed), [{
    number: 2, volume: 1, label: 'Capítulo 2 - Hola', group: 'Mi Scan', date: '', languages: ['spanish'], url: 'https://mangadex.org/chapter/c1',
  }])
  assert.deepEqual(mangadex.parsePages({ result: 'ok', baseUrl: 'https://n/', chapter: { hash: 'h', data: ['1.png'] } }), ['https://n/data/h/1.png'])
  assert.equal(mangadex.isOwnHost('https://abc.mangadex.network/x'), true)
})

test('ZonaTMO: una fila por versión de cada capítulo', () => {
  const page = `<li class="upload-link" data-chapter-number="7"><a href="/view_uploads/10">Leer</a><a href="/groups/1">Scan A</a> 05/04/2026
    <a href="/view_uploads/11">Leer</a><a href="/groups/2">Scan B</a></li>`
  assert.deepEqual(tmo.parseChapters(page, 'https://zonatmo.org/').map((c) => [c.number, c.group, c.date, c.url]), [
    [7, 'Scan A', '2026-04-05', 'https://zonatmo.org/view_uploads/10'],
    [7, 'Scan B', '', 'https://zonatmo.org/view_uploads/11'],
  ])
  assert.deepEqual(tmo.headers('https://zonatmo.net/x'), { Referer: 'https://zonatmo.net/', Origin: 'https://zonatmo.net' })
})

test('Enchilada: acepta páginas en Google Drive y descarta la interfaz', () => {
  assert.deepEqual(enchilada.parsePages([
    'https://drive.usercontent.google.com/uc?id=1&export-download',
    'assets/img/icons/discord.png',
    'assets/mangas/x/cap1/02.jpg',
  ]), ['https://drive.usercontent.google.com/uc?id=1&export-download', 'https://enchiladascan.github.io/enchiladaweb/assets/mangas/x/cap1/02.jpg'])
  assert.equal(enchilada.jsonUrl("const RAW = ('assets/mangas/a/cap1/images.json' || '')", 'a', 'cap1'), 'https://enchiladascan.github.io/enchiladaweb/assets/mangas/a/cap1/images.json')
})

test('obra nueva: valida la ficha antes de llamar a la API', () => {
  assert.throws(() => works.workBody({ language: 'es' }), /título/)
  assert.throws(() => works.workBody({ title: 'X', language: 'es', type: 'manga', demographyId: 2 }), /autor/)
  assert.deepEqual(works.workBody({ title: ' X ', language: 'es', baseId: 7, genreIds: [3, '3', -1], isNSFW: true }, { cover: 'k1' }),
    { title: 'X', language: 'es', baseId: 7, genreIds: [3], isNSFW: true, cover: 'k1' })
  assert.deepEqual(works.workBody({ title: 'X', language: 'pt', type: 'manhwa', demographyId: 2, authorIds: [9], status: 'ongoing' }).base,
    { type: 'manhwa', demographyId: 2, authorIds: [9] })
})

test('obra nueva: la portada debe tener la medida exacta', () => {
  const jpeg = (w, hgt) => {
    const b = Buffer.alloc(40)
    b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xc0
    b.writeUInt16BE(17, 4); b[6] = 8; b.writeUInt16BE(hgt, 7); b.writeUInt16BE(w, 9)
    return b
  }
  assert.deepEqual(works.imageSize(jpeg(1200, 1800)), [1200, 1800])
  assert.equal(works.checkImage('cover', jpeg(1200, 1800)).type, 'image/jpeg')
  assert.throws(() => works.checkImage('cover', jpeg(1000, 1500)), /1200×1800/)
  assert.throws(() => works.checkImage('banner', Buffer.from('nada de imagen')), /no es una imagen/)
})

test('ZonaTMO (API de zonatmo.net): capítulos con scan e idioma, y páginas en orden desde el CDN', () => {
  const items = [{ slug: 'obra-capitulo-12-5', chapter_number: '12.50', language: 'es', group: { name: 'Mi Scan' }, release_date: '2026-04-22 01:24:46' }, { title: 'sin slug' }]
  assert.deepEqual(tmo.parseApiChapters(items, 'https://zonatmo.net', 'obra'), [{
    number: 12.5, label: 'Capítulo 12.5', group: 'Mi Scan', date: '2026-04-22', languages: ['spanish'],
    url: 'https://zonatmo.net/manga/obra/obra-capitulo-12-5/', api: { slug: 'obra', chapter: 'obra-capitulo-12-5' },
  }])
  const pages = tmo.parseApiPages({ chapter: { jit: 'J', images: [{ image_url: 'page_0002.webp', page_number: 2 }, { image_url: 'page_0001.webp', page_number: 1 }] } })
  assert.deepEqual(pages, ['https://cdn.zonatmo.to/manga/J/page_0001.webp', 'https://cdn.zonatmo.to/manga/J/page_0002.webp'])
  assert.equal(readers.identify('https://zonatmo.net/manga/gachiakuta').site, 'tmo')
})
