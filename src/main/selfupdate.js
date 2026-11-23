/**
 * Actualizar el .zip y la portable en el mismo lugar donde están (el Setup lo hace electron-updater).
 *
 *   1. Se baja el archivo del release y se comprueba su sha256 con el que da GitHub (`digest`). Sin
 *      digest, o si no coincide, no se usa.
 *   2. Se deja listo junto a la app, en el mismo disco:
 *      - .zip: se descomprime en «<carpeta>\.capi-update\<versión>»;
 *      - portable: el .exe nuevo queda al lado del actual.
 *   3. Al cerrar la app (o al pulsar «Reiniciar y actualizar») un script de PowerShell espera a que la
 *      app termine y cambia los archivos:
 *      - .zip: mueve cada archivo viejo a una copia de respaldo y pone el nuevo (en el mismo disco son
 *        renombres, al instante); si algo falla, devuelve los viejos;
 *      - portable: borra el .exe viejo (o lo reemplaza si se le cambió el nombre).
 *      Después vuelve a abrir la app si se pidió y deja el resultado en update-result.json.
 *
 * Sin Electron, para poder probarlo.
 */
// En Electron, «fs» trata los .asar como carpetas y los deja abiertos (eso impide mover la carpeta
// preparada mientras la app sigue abierta). Aquí son archivos como cualquier otro: «original-fs».
const fs = (() => { try { return require('original-fs') } catch { return require('node:fs') } })()
const fsp = fs.promises
const path = require('node:path')
const crypto = require('node:crypto')
const { execFile, spawn } = require('node:child_process')
const { Readable, Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')

const WORK_DIR = '.capi-update'
const RESULT_FILE = 'update-result.json'
// Las descargas de los releases redirigen a estos dominios de GitHub.
const GITHUB_HOST = /^(github\.com|[a-z0-9-]+\.githubusercontent\.com)$/i
const PORTABLE_NAME = /^CapiUploader-Portable-\d+\.\d+\.\d+(?:-[\w.]+)?\.exe$/i

const sha256Of = (digest) => (/^sha256:([0-9a-f]{64})$/i.exec(String(digest || ''))?.[1] || '').toLowerCase()

/** ¿Se puede escribir en la carpeta? (Una carpeta como Archivos de programa no deja sin permisos.) */
async function canWrite(dir) {
  const probe = path.join(dir, `.capi-probe-${process.pid}`)
  try {
    await fsp.writeFile(probe, 'ok')
    await fsp.rm(probe, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Baja un archivo del release a `dest` y comprueba su tamaño y su sha256.
 * asset: { url, size, digest }. allowHost (pruebas): otro dominio permitido además de GitHub.
 */
async function download(asset, dest, { signal, onProgress = () => {}, allowHost = null } = {}) {
  const want = sha256Of(asset.digest)
  if (!want) throw new Error('El release no dice el sha256 del archivo: no se puede comprobar la descarga.')
  // Solo https a GitHub (las pruebas pueden permitir un servidor local con http).
  const okHost = (u) => {
    try {
      const { protocol, hostname } = new URL(u)
      return (protocol === 'https:' && GITHUB_HOST.test(hostname)) || (allowHost != null && hostname === allowHost)
    } catch { return false }
  }
  if (!okHost(asset.url)) throw new Error('La descarga no viene de GitHub.')
  const res = await fetch(asset.url, { signal, redirect: 'follow', headers: { 'User-Agent': 'CapiUploader' } })
  if (!res.ok || !res.body) throw new Error(`GitHub respondió ${res.status} al bajar la actualización.`)
  if (!okHost(res.url || asset.url)) throw new Error('La descarga terminó fuera de GitHub.')
  const total = Number(asset.size) || Number(res.headers.get('content-length')) || 0
  const hash = crypto.createHash('sha256')
  let got = 0
  let last = 0
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk)
      got += chunk.length
      const now = Date.now()
      if (now - last > 250) { last = now; onProgress({ done: got, total }) }
      cb(null, chunk)
    },
  })
  const part = `${dest}.part`
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  try {
    await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(part), { signal })
    if (asset.size && got !== Number(asset.size)) throw new Error(`La descarga quedó incompleta (${got} de ${asset.size} bytes).`)
    if (hash.digest('hex') !== want) throw new Error('La descarga no coincide con la del release (sha256 distinto).')
    await fsp.rename(part, dest)
  } catch (err) {
    await fsp.rm(part, { force: true }).catch(() => {})
    throw err
  }
  onProgress({ done: got, total: got })
  return dest
}

const run = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { windowsHide: true, maxBuffer: 4 << 20 }, (err, _out, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve()))
})

/** Descomprime el .zip del release con el tar de Windows (o Expand-Archive si no está). */
async function unzip(zip, dir) {
  await fsp.rm(dir, { recursive: true, force: true })
  await fsp.mkdir(dir, { recursive: true })
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  try {
    await run(tar, ['-xf', zip, '-C', dir])
  } catch {
    await fsp.rm(dir, { recursive: true, force: true })
    await fsp.mkdir(dir, { recursive: true })
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath ${psq(zip)} -DestinationPath ${psq(dir)} -Force`])
  }
}

/**
 * .zip: lo descomprime junto a la app y revisa que sea una CapiUploader completa.
 * Devuelve la carpeta con la versión nueva.
 */
async function stageZip(zip, appDir, version, exeName) {
  const stage = path.join(appDir, WORK_DIR, version.replace(/[^\w.-]/g, '_'))
  await unzip(zip, stage)
  for (const need of [exeName, path.join('resources', 'app.asar')]) {
    if (!fs.existsSync(path.join(stage, need))) {
      await fsp.rm(stage, { recursive: true, force: true })
      throw new Error(`El .zip del release no trae ${need}.`)
    }
  }
  return stage
}

/**
 * Portable: dónde queda el .exe nuevo. Si el actual tiene el nombre del release, el nuevo va con el
 * suyo («CapiUploader-Portable-1.5.1.exe») y el viejo se borra; si se le cambió el nombre, el nuevo
 * toma ese mismo nombre.
 */
function portableTarget(currentExe, newAssetName) {
  const dir = path.dirname(currentExe)
  const renamed = !PORTABLE_NAME.test(path.basename(currentExe)) || !PORTABLE_NAME.test(newAssetName)
  const final = renamed ? currentExe : path.join(dir, newAssetName)
  // Mientras la app está abierta, el nuevo espera con otro nombre si va a ocupar el del actual.
  const pending = final.toLowerCase() === currentExe.toLowerCase() ? `${currentExe}.new` : final
  return { final, pending }
}

/** Texto para PowerShell entre comillas simples. */
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`

/**
 * El script que cambia los archivos cuando la app cierra.
 * plan: { kind: 'zip'|'portable', pid, appDir, stage, exe, current, pending, final, version, resultFile, logFile }
 * Con -Relaunch vuelve a abrir la app al terminar.
 */
function buildScript(plan) {
  const common = `param([switch]$Relaunch)
$ErrorActionPreference = 'Stop'
$log = ${psq(plan.logFile)}
$resultFile = ${psq(plan.resultFile)}
function Log($m) { try { Add-Content -LiteralPath $log -Value ('[' + (Get-Date -Format s) + '] ' + $m) -Encoding UTF8 } catch {} }
function Result($ok, $msg) {
  $o = [ordered]@{ ok = $ok; version = ${psq(plan.version)}; kind = ${psq(plan.kind)}; error = $msg; at = (Get-Date).ToString('o') }
  try { [IO.File]::WriteAllText($resultFile, ($o | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false)) } catch {}
}
function Retry([scriptblock]$what, $tries = ${Number(plan.tries) || 40}) {
  for ($i = 1; $i -le $tries; $i++) {
    try { & $what; return } catch { if ($i -eq $tries) { throw }; Start-Sleep -Milliseconds 750 }
  }
}
Log ('Actualizando a ' + ${psq(plan.version)} + ' (' + ${psq(plan.kind)} + ')')
try { Wait-Process -Id ${Number(plan.pid)} -Timeout 90 -ErrorAction SilentlyContinue } catch {}
`
  const waitDir = `
# Que no quede ninguna parte de la app abierta desde esa carpeta.
$dir = ${psq(plan.appDir)}
$prefix = $dir.TrimEnd('\\') + '\\'
for ($i = 0; $i -lt 120; $i++) {
  $open = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) })
  if ($open.Count -eq 0) { break }
  Start-Sleep -Milliseconds 500
}
if ($open.Count -gt 0) { Log 'La app sigue abierta: no se cambia nada.'; Result $false 'La app seguía abierta.'; exit 1 }
`
  const relaunch = (exe) => `if ($Relaunch) { try { Start-Process -FilePath ${psq(exe)} -WorkingDirectory (Split-Path -Parent ${psq(exe)}) } catch { Log ('No se pudo abrir: ' + $_) } }\n`

  if (plan.kind === 'zip') {
    return `${common}${waitDir}
$stage = ${psq(plan.stage)}
$backup = Join-Path (Split-Path -Parent $stage) ('respaldo-' + (Get-Date -Format 'yyyyMMddHHmmss'))
$done = New-Object System.Collections.Generic.List[string]
$hadOld = @{}
$step = ''
try {
  if (-not (Test-Path -LiteralPath $stage)) { throw 'No está la versión nueva preparada.' }
  New-Item -ItemType Directory -Path $backup -Force | Out-Null
  foreach ($it in @(Get-ChildItem -LiteralPath $stage -Force)) {
    $step = $it.Name
    $target = Join-Path $dir $it.Name
    if (Test-Path -LiteralPath $target) {
      Retry { Move-Item -LiteralPath $target -Destination (Join-Path $backup $it.Name) -Force }
      $hadOld[$it.Name] = $true
    }
    $done.Add($it.Name)
    Retry { Move-Item -LiteralPath $it.FullName -Destination $target -Force }
  }
  Log ('Listo: ' + $done.Count + ' elementos cambiados.')
  Result $true $null
  try { Remove-Item -LiteralPath (Split-Path -Parent $stage) -Recurse -Force } catch { Log ('No se pudo borrar la carpeta temporal: ' + $_) }
} catch {
  $err = [string]$_
  Log ('Falló con «' + $step + '»: ' + $err + '. Se vuelve a la versión anterior.')
  foreach ($name in $done) {
    $target = Join-Path $dir $name
    try {
      # Lo nuevo vuelve a la carpeta preparada y lo viejo a su lugar.
      if (Test-Path -LiteralPath $target) { Move-Item -LiteralPath $target -Destination (Join-Path $stage $name) -Force }
      if ($hadOld[$name]) { Move-Item -LiteralPath (Join-Path $backup $name) -Destination $target -Force }
    } catch { Log ('No se pudo devolver ' + $name + ': ' + $_) }
  }
  Result $false $err
}
${relaunch(plan.exe)}`
  }

  // Portable
  return `${common}
$current = ${psq(plan.current)}
$pending = ${psq(plan.pending)}
$final = ${psq(plan.final)}
try {
  if (-not (Test-Path -LiteralPath $pending)) { throw 'No está el archivo nuevo.' }
  if ($final -ne $current) {
    # El nuevo ya tiene su nombre: se borra el viejo cuando Windows lo suelte.
    Retry { if (Test-Path -LiteralPath $current) { Remove-Item -LiteralPath $current -Force } }
  } else {
    $old = $current + '.old'
    Retry { Move-Item -LiteralPath $current -Destination $old -Force }
    try { Move-Item -LiteralPath ($current + '.new') -Destination $current -Force }
    catch { Move-Item -LiteralPath $old -Destination $current -Force; throw }
    Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue
  }
  Log 'Listo.'
  Result $true $null
} catch {
  $err = [string]$_
  Log ('Falló: ' + $err)
  Result $false $err
}
if (Test-Path -LiteralPath $final) { $open = $final } else { $open = $current }
if ($Relaunch) { try { Start-Process -FilePath $open -WorkingDirectory (Split-Path -Parent $open) } catch { Log ('No se pudo abrir: ' + $_) } }
`
}

/** Escribe el script (UTF-8 con BOM, para que PowerShell 5.1 lea bien las rutas con acentos). */
async function writeScript(plan, scriptFile) {
  await fsp.mkdir(path.dirname(scriptFile), { recursive: true })
  await fsp.writeFile(scriptFile, `\uFEFF${buildScript(plan)}`, 'utf8')
  return scriptFile
}

/**
 * Lanza el script aparte, para que siga aunque la app se cierre. Es s\u00EDncrono: sirve tambi\u00E9n al cerrar.
 *
 * Va por \u00ABcmd /c start\u00BB: un proceso aparte (detached) no tiene consola y PowerShell se cierra sin
 * correr nada; \u00ABstart\u00BB le da una consola propia (minimizada, y -WindowStyle Hidden la oculta). Sin
 * detached, Node lo cerrar\u00EDa junto con la app. La l\u00EDnea se arma a mano y entre comillas para que las
 * rutas con espacios o \u00AB&\u00BB lleguen bien.
 */
function launch(scriptFile, { relaunch = false } = {}) {
  if (/["%\r\n]/.test(scriptFile)) throw new Error('Ruta del script no v\u00E1lida.')
  const ps = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${scriptFile}"${relaunch ? ' -Relaunch' : ''}`
  const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"start "" /min ${ps}"`], {
    detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true,
  })
  child.unref()
  return child
}

/** El resultado que dejó el último script (y lo borra para no avisar dos veces). */
async function takeResult(userData) {
  const file = path.join(userData, RESULT_FILE)
  try {
    const r = JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^\uFEFF/, ''))
    await fsp.rm(file, { force: true })
    return r
  } catch {
    return null
  }
}

/** Borra lo que haya quedado de una actualización anterior (carpeta temporal o portable a medias). */
async function cleanup(appDir) {
  await fsp.rm(path.join(appDir, WORK_DIR), { recursive: true, force: true }).catch(() => {})
}

/** Portable: solo los restos de una actualización (.new, .old y descargas .part a medias), nada más. */
async function cleanupPortable(exe) {
  const dir = path.dirname(exe)
  const leftovers = [`${exe}.new`, `${exe}.new.part`, `${exe}.old`]
  try {
    for (const name of await fsp.readdir(dir)) {
      if (/^CapiUploader-Portable-[\w.-]+\.exe\.part$/i.test(name)) leftovers.push(path.join(dir, name))
    }
  } catch {}
  for (const f of leftovers) await fsp.rm(f, { force: true }).catch(() => {})
}

module.exports = {
  WORK_DIR, RESULT_FILE, canWrite, download, unzip, stageZip, portableTarget, buildScript, writeScript, launch, takeResult, cleanup, cleanupPortable, sha256Of, psq,
}
