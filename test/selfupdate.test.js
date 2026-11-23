// Actualizar el .zip y la portable en el mismo lugar: descarga comprobada con sha256, nombres de la
// portable y el script de PowerShell que cambia los archivos (y vuelve atrás si algo falla).
const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const crypto = require('node:crypto')
const { execFileSync, spawn } = require('node:child_process')

const selfupdate = require('../src/main/selfupdate')
const { writeZip } = require('../src/main/zip')

const onWindows = process.platform === 'win32'
const tmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'capi-selfupdate-'))
const digestOf = (buf) => `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`

async function serve(body) {
  const srv = http.createServer((_req, res) => { res.writeHead(200, { 'content-length': body.length }); res.end(body) })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${srv.address().port}/archivo.zip`, close: () => new Promise((r) => srv.close(r)) }
}

/** Corre el script como lo haría la app al cerrarse, pero esperando a que termine. */
async function runScript(plan) {
  const dir = await tmp()
  const file = await selfupdate.writeScript(plan, path.join(dir, 'update.ps1'))
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true, stdio: 'pipe' })
  } catch { /* el resultado queda en resultFile */ }
  return JSON.parse((await fsp.readFile(plan.resultFile, 'utf8')).replace(/^\uFEFF/, ''))
}

const read = (f) => fs.readFileSync(f, 'utf8')

test('descarga: solo con el sha256 correcto queda el archivo; si no coincide no deja nada', async () => {
  const body = Buffer.from('versión nueva '.repeat(5000))
  const srv = await serve(body)
  const dir = await tmp()
  try {
    const dest = path.join(dir, 'nueva.zip')
    const seen = []
    await selfupdate.download({ url: srv.url, size: body.length, digest: digestOf(body) }, dest, { allowHost: '127.0.0.1', onProgress: (p) => seen.push(p) })
    assert.deepEqual(fs.readFileSync(dest), body)
    assert.equal(seen.at(-1).done, body.length)

    const bad = path.join(dir, 'mala.zip')
    await assert.rejects(selfupdate.download({ url: srv.url, size: body.length, digest: digestOf(Buffer.from('otra')) }, bad, { allowHost: '127.0.0.1' }), /sha256/)
    assert.equal(fs.existsSync(bad), false)
    assert.equal(fs.existsSync(`${bad}.part`), false)

    await assert.rejects(selfupdate.download({ url: srv.url, size: body.length, digest: null }, bad, { allowHost: '127.0.0.1' }), /sha256/)
    // Sin permiso para el servidor local, solo vale GitHub por https.
    await assert.rejects(selfupdate.download({ url: srv.url, size: body.length, digest: digestOf(body) }, bad), /GitHub/)
    await assert.rejects(selfupdate.download({ url: 'http://github.com/x.zip', digest: digestOf(body) }, bad), /GitHub/)
  } finally { await srv.close() }
})

test('portable: el nuevo lleva el nombre del release; si se le cambió el nombre, conserva ese', () => {
  const dir = path.join('C:', 'Apps')
  assert.deepEqual(selfupdate.portableTarget(path.join(dir, 'CapiUploader-Portable-1.4.2.exe'), 'CapiUploader-Portable-1.5.0.exe'),
    { final: path.join(dir, 'CapiUploader-Portable-1.5.0.exe'), pending: path.join(dir, 'CapiUploader-Portable-1.5.0.exe') })
  const mine = path.join(dir, 'Capi.exe')
  assert.deepEqual(selfupdate.portableTarget(mine, 'CapiUploader-Portable-1.5.0.exe'), { final: mine, pending: `${mine}.new` })
  assert.equal(selfupdate.psq("C:\\Mis cosas\\l'app"), "'C:\\Mis cosas\\l''app'")
  assert.equal(selfupdate.sha256Of('sha256:' + 'A'.repeat(64)), 'a'.repeat(64))
  assert.equal(selfupdate.sha256Of('md5:abc'), '')
})

test('.zip: se descomprime junto a la app y se revisa que esté completa', { skip: !onWindows }, async () => {
  const src = await tmp()
  await fsp.mkdir(path.join(src, 'resources'))
  await fsp.writeFile(path.join(src, 'CapiUploader.exe'), 'exe nuevo')
  await fsp.writeFile(path.join(src, 'resources', 'app.asar'), 'asar nuevo')
  const zip = path.join(src, 'CapiUploader-9.9.9-win.zip')
  await writeZip(zip, src, ['CapiUploader.exe', 'resources/app.asar'])
  const appDir = await tmp()
  const stage = await selfupdate.stageZip(zip, appDir, '9.9.9', 'CapiUploader.exe')
  assert.equal(stage, path.join(appDir, selfupdate.WORK_DIR, '9.9.9'))
  assert.equal(read(path.join(stage, 'resources', 'app.asar')), 'asar nuevo')

  const incomplete = path.join(src, 'incompleto.zip')
  await writeZip(incomplete, src, ['CapiUploader.exe'])
  await assert.rejects(selfupdate.stageZip(incomplete, appDir, '9.9.8', 'CapiUploader.exe'), /app\.asar/)
  assert.equal(fs.existsSync(path.join(appDir, selfupdate.WORK_DIR, '9.9.8')), false)
})

/** Carpeta de una app «vieja» con un archivo del usuario y su versión nueva preparada al lado. */
async function zipScenario() {
  const appDir = await tmp()
  await fsp.mkdir(path.join(appDir, 'resources'))
  await fsp.writeFile(path.join(appDir, 'CapiUploader.exe'), 'exe viejo')
  await fsp.writeFile(path.join(appDir, 'resources', 'app.asar'), 'asar viejo')
  await fsp.writeFile(path.join(appDir, 'mis notas.txt'), 'del usuario')
  const stage = path.join(appDir, selfupdate.WORK_DIR, '9.9.9')
  await fsp.mkdir(path.join(stage, 'resources'), { recursive: true })
  await fsp.writeFile(path.join(stage, 'CapiUploader.exe'), 'exe nuevo')
  await fsp.writeFile(path.join(stage, 'resources', 'app.asar'), 'asar nuevo')
  await fsp.writeFile(path.join(stage, 'LICENSE.nuevo.txt'), 'nuevo')
  const data = await tmp()
  return {
    appDir, stage,
    plan: { kind: 'zip', pid: 0, appDir, stage, exe: path.join(appDir, 'CapiUploader.exe'), version: '9.9.9', resultFile: path.join(data, 'r.json'), logFile: path.join(data, 'log.txt'), tries: 2 },
  }
}

test('.zip: el script cambia los archivos de la app, deja los del usuario y borra lo temporal', { skip: !onWindows, timeout: 60e3 }, async () => {
  const { appDir, plan } = await zipScenario()
  const r = await runScript(plan)
  assert.equal(r.ok, true, r.error)
  assert.equal(r.version, '9.9.9')
  assert.equal(read(path.join(appDir, 'CapiUploader.exe')), 'exe nuevo')
  assert.equal(read(path.join(appDir, 'resources', 'app.asar')), 'asar nuevo')
  assert.equal(read(path.join(appDir, 'LICENSE.nuevo.txt')), 'nuevo')
  assert.equal(read(path.join(appDir, 'mis notas.txt')), 'del usuario')
  assert.equal(fs.existsSync(path.join(appDir, selfupdate.WORK_DIR)), false)
})

test('.zip: si un archivo no se puede cambiar, vuelve todo a la versión anterior', { skip: !onWindows, timeout: 60e3 }, async () => {
  const { appDir, plan } = await zipScenario()
  // Un archivo abierto sin compartir dentro de resources impide mover la carpeta (como un antivirus).
  // Node siempre abre dejando mover, así que lo abre otro PowerShell.
  const asar = path.join(appDir, 'resources', 'app.asar')
  const locker = spawn('powershell.exe', ['-NoProfile', '-Command',
    `$f = [IO.File]::Open(${selfupdate.psq(asar)}, 'Open', 'Read', 'None'); 'bloqueado'; [Console]::In.ReadLine() | Out-Null; $f.Close()`], { windowsHide: true })
  await new Promise((resolve, reject) => {
    locker.stdout.on('data', (d) => { if (String(d).includes('bloqueado')) resolve() })
    locker.on('exit', () => reject(new Error('no se pudo bloquear el archivo')))
  })
  let r
  try { r = await runScript(plan) } finally { locker.stdin.end(); await new Promise((res) => locker.on('exit', res)) }
  assert.equal(r.ok, false)
  assert.equal(read(path.join(appDir, 'CapiUploader.exe')), 'exe viejo')
  assert.equal(read(path.join(appDir, 'resources', 'app.asar')), 'asar viejo')
  assert.equal(fs.existsSync(path.join(appDir, 'LICENSE.nuevo.txt')), false, 'lo nuevo que no estaba se quita')
  assert.equal(read(path.join(appDir, 'mis notas.txt')), 'del usuario')
  // Lo nuevo vuelve a la carpeta preparada, completa.
  assert.equal(read(path.join(plan.stage, 'CapiUploader.exe')), 'exe nuevo')
  assert.equal(read(path.join(plan.stage, 'LICENSE.nuevo.txt')), 'nuevo')
})

test('launch: el script corre aparte aunque quien lo lanzó ya no espere', { skip: !onWindows, timeout: 60e3 }, async () => {
  const { appDir, plan } = await zipScenario()
  plan.appDir = appDir
  const dir = await tmp()
  const script = await selfupdate.writeScript(plan, path.join(dir, 'con espacios & símbolos', 'update.ps1'))
  selfupdate.launch(script)
  for (let i = 0; i < 80 && !fs.existsSync(plan.resultFile); i++) await new Promise((r) => setTimeout(r, 250))
  const r = JSON.parse((await fsp.readFile(plan.resultFile, 'utf8')).replace(/^﻿/, ''))
  assert.equal(r.ok, true, r.error)
  assert.equal(read(path.join(appDir, 'CapiUploader.exe')), 'exe nuevo')
})

test('portable: el .exe nuevo queda y el viejo se borra; con nombre propio, lo reemplaza', { skip: !onWindows, timeout: 60e3 }, async () => {
  const dir = await tmp()
  const data = await tmp()
  const base = { kind: 'portable', pid: 0, appDir: dir, version: '9.9.9', resultFile: path.join(data, 'r.json'), logFile: path.join(data, 'log.txt'), tries: 2 }

  const old = path.join(dir, 'CapiUploader-Portable-1.4.2.exe')
  const next = path.join(dir, 'CapiUploader-Portable-9.9.9.exe')
  await fsp.writeFile(old, 'viejo')
  await fsp.writeFile(next, 'nuevo')
  let r = await runScript({ ...base, current: old, pending: next, final: next })
  assert.equal(r.ok, true, r.error)
  assert.equal(fs.existsSync(old), false)
  assert.equal(read(next), 'nuevo')

  const mine = path.join(dir, 'Mi Capi.exe')
  await fsp.writeFile(mine, 'viejo')
  await fsp.writeFile(`${mine}.new`, 'nuevo')
  r = await runScript({ ...base, current: mine, pending: `${mine}.new`, final: mine })
  assert.equal(r.ok, true, r.error)
  assert.equal(read(mine), 'nuevo')
  assert.equal(fs.existsSync(`${mine}.new`), false)
  assert.equal(fs.existsSync(`${mine}.old`), false)
})

test('limpieza de la portable: solo borra restos de la actualización', async () => {
  const dir = await tmp()
  const exe = path.join(dir, 'CapiUploader-Portable-1.4.2.exe')
  const keep = ['CapiUploader-Portable-1.4.2.exe', 'otro.exe', 'CapiUploader-Portable-1.5.0.exe']
  const gone = ['CapiUploader-Portable-1.4.2.exe.new', 'CapiUploader-Portable-1.4.2.exe.old', 'CapiUploader-Portable-1.5.0.exe.part']
  for (const n of [...keep, ...gone]) await fsp.writeFile(path.join(dir, n), 'x')
  await selfupdate.cleanupPortable(exe)
  assert.deepEqual((await fsp.readdir(dir)).sort(), keep.sort())
})
