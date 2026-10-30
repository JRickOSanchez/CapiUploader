// Registro de diagnóstico y notas de la ventana «Novedades».
const { test } = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const diagnostics = require('../src/main/diagnostics')
const markdown = require('../src/main/markdown')

test('nunca guarda claves, tokens, cookies ni firmas de URLs', () => {
  const dirty = [
    'clave capi_9rhyfdlzoUqli4XGHNgMB125wJB54KiMumszJMZQ',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def',
    'https://r2.example.com/x.webp?X-Amz-Signature=abc123&X-Amz-Credential=zzz&ok=1',
    '{"cookie":"cf_clearance=secreto"}',
    'password=hunter2',
  ].join(' | ')
  const clean = diagnostics.redact(dirty)
  for (const secret of ['9rhyfdl', 'eyJhbGci', 'abc123', 'zzz', 'cf_clearance=secreto', 'hunter2']) assert.ok(!clean.includes(secret), `quedó ${secret}`)
  assert.match(clean, /ok=1/)
  const e = diagnostics.error('prueba', 'falló con capi_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd', new Error('Bearer xyz.secreto'))
  assert.ok(!e.message.includes('ABCDEFG') && !e.detail.includes('xyz.secreto'))
})

test('en memoria se queda con las últimas entradas y filtra por nivel', () => {
  diagnostics.clear()
  for (let i = 0; i < diagnostics.MAX_ENTRIES + 50; i++) diagnostics.info('prueba', `n${i}`)
  diagnostics.warn('prueba', 'aviso')
  const all = diagnostics.list()
  assert.equal(all.length, diagnostics.MAX_ENTRIES)
  assert.equal(all.at(-1).message, 'aviso')
  assert.deepEqual(diagnostics.list({ minLevel: 'warn' }).map((e) => e.message), ['aviso'])
  diagnostics.clear()
  assert.equal(diagnostics.list().length, 0)
})

test('en disco escribe en tandas y el archivo no crece sin límite', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capi-log-'))
  const logs = diagnostics.init(dir)
  diagnostics.info('prueba', 'hola')
  diagnostics.flush()
  const file = path.join(logs, 'capiuploader.log')
  assert.match(fs.readFileSync(file, 'utf8'), /INFO {2}\[prueba\] hola/)
  const big = 'x'.repeat(500)
  for (let i = 0; i < 2500; i++) diagnostics.info('prueba', big)
  diagnostics.flush()
  assert.ok(fs.existsSync(path.join(logs, 'capiuploader.old.log')), 'pasó al archivo viejo')
  assert.ok(fs.statSync(file).size <= 1024 * 1024)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('las notas no pueden meter HTML ni enlaces peligrosos', () => {
  const html = markdown.render('<img src=x onerror=alert(1)> [a](javascript:alert(1)) [b](https://ok.com) `<b>`')
  assert.ok(!html.includes('<img') && !html.includes('href="javascript'))
  assert.match(html, /<a href="https:\/\/ok\.com" data-external>b<\/a>/)
  assert.match(html, /<code>&lt;b&gt;<\/code>/)
})

test('notas: listas anidadas, citas y tablas; sin título ni sección de descargas', () => {
  const md = [
    '# CapiUploader v1.4.0', '', '## Novedades', '- Uno **fuerte**', '  - Dos', '- Tres', '',
    '> ⚠️ Ojo', '', '| A | B |', '|---|---|', '| 1 | 2 |', '', '## Descargas', '- Setup.exe', '', '## Correcciones', '1. Arreglo',
  ].join('\n')
  const html = markdown.releaseNotes(md)
  assert.ok(!html.includes('CapiUploader v1.4.0') && !html.includes('Setup.exe'))
  assert.match(html, /<ul><li>Uno <strong>fuerte<\/strong><ul><li>Dos<\/li><\/ul><\/li><li>Tres<\/li><\/ul>/)
  assert.match(html, /<blockquote><p>⚠️ Ojo<\/p><\/blockquote>/)
  assert.match(html, /<table><thead><tr><th>A<\/th><th>B<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td>2<\/td><\/tr><\/tbody><\/table>/)
  assert.match(html, /<h2>Correcciones<\/h2>\n<ol><li>Arreglo<\/li><\/ol>/)
})
