/**
 * Archivos comprimidos como capítulos: zip, cbz, rar, cbr, 7z, cb7, tar, cbt, tar.gz, tar.bz2,
 * tar.xz… Se extraen una vez con 7-Zip (compilado a WASM: paquete 7z-wasm, GNU LGPL con la
 * restricción de unRAR: el código de RAR solo descomprime y no puede usarse para crear un
 * compresor compatible con RAR) a una caché por ruta + tamaño + fecha. El resto de la app ve una
 * carpeta normal.
 *
 * 7-Zip corre en un hilo aparte (worker) para no congelar la ventana. Solo se extraen imágenes y
 * PSD, y antes se mira la lista: un comprimido con contraseña, sin imágenes o demasiado grande se
 * rechaza con un error claro.
 */
const crypto = require('node:crypto')
const path = require('node:path')
const fs = require('node:fs/promises')
const { Worker } = require('node:worker_threads')
const { prepareCache, cancelled } = require('./util')
const diagnostics = require('./diagnostics')

// .gz/.bz2/.xz solos suelen ser un .tar comprimido (7-Zip abre el tar de adentro al listar).
const ARCHIVE_EXTS = new Set(['.zip', '.cbz', '.rar', '.cbr', '.7z', '.cb7', '.tar', '.cbt', '.tgz', '.gz', '.tbz', '.tbz2', '.bz2', '.txz', '.xz'])
const PAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'psd', 'psb']
const MAX_FILES = 5000
const MAX_BYTES = 8 * 1024 ** 3
const DONE_MARK = '.capi-ok'

let cacheDir = null
let ready = null
const inflight = new Map() // carpeta de la caché -> promesa de la extracción

const isArchive = (filePath) => ARCHIVE_EXTS.has(path.extname(filePath).toLowerCase())

/** «Cap 3.cbz» → «Cap 3»; «Obra.tar.gz» → «Obra». */
const archiveTitle = (filePath) => path.basename(filePath).replace(/(\.tar)?\.[a-z0-9]+$/i, '') || path.basename(filePath)

function init(userData) {
  ready = prepareCache(path.join(userData, 'archive-cache')).then((d) => { cacheDir = d })
  return ready
}

/** Para las pruebas: la caché en otra carpeta. */
function useCacheDir(dir) {
  cacheDir = dir
  ready = fs.mkdir(dir, { recursive: true })
  return ready
}

/** El script de 7-Zip fuera del .asar (los hilos no leen dentro del paquete). */
function modulePath() {
  return require.resolve('7z-wasm/7zz.umd.js').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
}

/*
 * El hilo: monta la carpeta del comprimido en /in (solo se lee) y la de salida en /out, corre 7-Zip
 * con los argumentos y devuelve lo que escribió. El avance (-bsp1) llega como «42%» entre retrocesos.
 */
const WORKER_CODE = `
const { parentPort, workerData } = require('node:worker_threads')
const SevenZip = require(workerData.modulePath)
const out = []
let line = []
let lastPct = -1
const flush = () => {
  const s = Buffer.from(line).toString('utf8')
  const m = /(\\d{1,3})%/.exec(s)
  if (m && Number(m[1]) !== lastPct) { lastPct = Number(m[1]); parentPort.postMessage({ type: 'progress', percent: lastPct }) }
  line = []
}
SevenZip({
  stdin: () => null,
  stdout: (c) => { if (c === null) return; out.push(c); if (c === 8 || c === 10 || c === 13) flush(); else line.push(c) },
  stderr: (c) => { if (c !== null) out.push(c) },
  quit: (code) => { parentPort.postMessage({ type: 'exit', code, text: Buffer.from(out).toString('utf8') }) },
}).then((sz) => {
  // Igual que la línea de comandos de 7z-wasm: con tar, 7-Zip pone permisos 000 y luego no puede entrar a las subcarpetas.
  const chmod = sz.FS.chmod
  sz.FS.chmod = (p, mode, dontFollow) => { if (mode) chmod(p, mode, dontFollow) }
  sz.FS.mkdir('/in')
  sz.FS.mount(sz.NODEFS, { root: workerData.inDir }, '/in')
  if (workerData.outDir) { sz.FS.mkdir('/out'); sz.FS.mount(sz.NODEFS, { root: workerData.outDir }, '/out') }
  sz.FS.chdir('/in')
  // callMain devuelve el código de salida; si 7-Zip se cae (p. ej. con un zip cortado), lanza.
  let code = 0
  let crashed = false
  try { const r = sz.callMain(workerData.args); code = typeof r === 'number' ? r : 0 } catch (e) { code = typeof e?.status === 'number' ? e.status : 2; crashed = code !== 0 }
  parentPort.postMessage({ type: 'exit', code, crashed, text: Buffer.from(out).toString('utf8') })
}).catch((e) => parentPort.postMessage({ type: 'exit', code: 2, crashed: true, text: String(e?.message || e) }))
`

/** Corre 7-Zip en un hilo. Devuelve { code, crashed, text }. */
function run7z({ inDir, outDir = null, args, signal, onProgress }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled('Cancelado.'))
    const worker = new Worker(WORKER_CODE, { eval: true, workerData: { modulePath: modulePath(), inDir, outDir, args } })
    let settled = false
    const finish = (fn, v) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      worker.terminate().catch(() => {})
      fn(v)
    }
    const onAbort = () => finish(reject, cancelled('Cancelado.'))
    signal?.addEventListener('abort', onAbort, { once: true })
    worker.on('message', (m) => {
      if (m.type === 'progress') onProgress?.(m.percent)
      else if (m.type === 'exit') finish(resolve, { code: m.code, crashed: Boolean(m.crashed), text: m.text })
    })
    worker.on('error', (err) => finish(reject, err))
    worker.on('exit', (code) => finish(reject, new Error(`7-Zip se cerró (código ${code}).`)))
  })
}

const fail = (message, code) => Object.assign(new Error(message), { code })

/** Explica en español lo que dijo 7-Zip. */
function explain(text, crashed = false) {
  if (/wrong password|encrypted|enter password/i.test(text)) return fail('Tiene contraseña. Descomprímelo tú y agrega la carpeta.', 'archive.password')
  if (/can ?not open .*as archive|is not archive|unsupported/i.test(text)) return fail('No se pudo abrir: el archivo está dañado o no es un comprimido.', 'archive.broken')
  if (/unexpected end|data error|crc failed|headers error/i.test(text)) return fail('Está dañado o incompleto (¿se terminó de descargar?).', 'archive.broken')
  if (/no space|disk full/i.test(text)) return fail('No hay espacio en el disco para descomprimirlo.', 'archive.disk')
  if (crashed) return fail('Está dañado o incompleto (¿se terminó de descargar?).', 'archive.broken')
  return fail('No se pudo descomprimir.', 'archive.failed')
}

const isPage = (name) => PAGE_EXTS.includes(path.extname(name).slice(1).toLowerCase())
const isJunk = (name) => /(^|[\\/])(__MACOSX|\.DS_Store)([\\/]|$)|(^|[\\/])\._/.test(name)

/** Lee la salida de «7z l -slt»: archivos con su tamaño y si están cifrados. */
function parseListing(text) {
  const entries = []
  let cur = null
  for (const raw of text.split(/\r?\n/)) {
    const m = /^([A-Za-z ]+?) = (.*)$/.exec(raw)
    if (!m) continue
    const [, k, v] = m
    if (k === 'Path') { cur = { path: v, size: 0, dir: false, encrypted: false }; entries.push(cur) }
    else if (!cur) continue
    else if (k === 'Size') cur.size = Number(v) || 0
    else if (k === 'Folder') cur.dir = v === '+'
    else if (k === 'Attributes' && /^D/.test(v)) cur.dir = true
    else if (k === 'Encrypted') cur.encrypted = v === '+'
  }
  return entries
}

/** Lo que hay que extraer: solo páginas, sin carpetas de macOS. */
function pagesIn(entries) {
  const pages = entries.filter((e) => !e.dir && isPage(e.path) && !isJunk(e.path))
  return { pages, bytes: pages.reduce((n, e) => n + e.size, 0), encrypted: pages.some((e) => e.encrypted) }
}

async function cacheFor(archivePath) {
  const st = await fs.stat(archivePath)
  if (!st.isFile()) throw fail('No es un archivo.', 'archive.failed')
  const id = crypto.createHash('sha1').update(`${path.resolve(archivePath)}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 20)
  return { dir: path.join(cacheDir, id), size: st.size }
}

/**
 * Extrae las páginas del comprimido (o usa la extracción guardada) y devuelve la carpeta.
 * onProgress recibe { name, percent }.
 */
async function extract(archivePath, { signal, onProgress } = {}) {
  await ready
  if (!cacheDir) throw new Error('La caché de comprimidos no está lista.')
  const { dir } = await cacheFor(archivePath)
  if (!inflight.has(dir)) inflight.set(dir, doExtract(archivePath, dir, { signal, onProgress }).finally(() => inflight.delete(dir)))
  return inflight.get(dir)
}

async function doExtract(archivePath, dir, { signal, onProgress }) {
  const name = path.basename(archivePath)
  // Ya extraído: se toca la fecha para que la limpieza de 3 días cuente desde el último uso.
  if (await fs.stat(path.join(dir, DONE_MARK)).then(() => true, () => false)) {
    const now = new Date()
    await fs.utimes(dir, now, now).catch(() => {})
    return dir
  }
  const started = Date.now()
  const inDir = path.dirname(path.resolve(archivePath))
  // Contraseña falsa: así 7-Zip nunca se queda esperando que se escriba una.
  const common = ['-pcapiuploader', '-sccUTF-8', '-bd']
  const listing = await run7z({ inDir, args: ['l', '-slt', '-ba', ...common, name], signal })
  const entries = parseListing(listing.text)
  if (listing.code !== 0 && !entries.length) throw explain(listing.text, listing.crashed)
  const { pages, bytes, encrypted } = pagesIn(entries)
  if (encrypted) throw fail('Tiene contraseña. Descomprímelo tú y agrega la carpeta.', 'archive.password')
  if (!pages.length) throw fail('No tiene imágenes (JPG, PNG, WEBP, GIF, AVIF o PSD).', 'archive.empty')
  if (pages.length > MAX_FILES) throw fail(`Tiene más de ${MAX_FILES} imágenes.`, 'archive.too_big')
  if (bytes > MAX_BYTES) throw fail('Descomprimido pesaría más de 8 GB.', 'archive.too_big')

  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })
  onProgress?.({ name, percent: 0 })
  const include = PAGE_EXTS.map((e) => `-ir!*.${e}`)
  try {
    const res = await run7z({
      inDir, outDir: dir, signal,
      args: ['x', ...common, '-bsp1', '-y', '-ssc-', '-o/out', ...include, '-xr!__MACOSX', '-xr!._*', name],
      onProgress: (percent) => onProgress?.({ name, percent }),
    })
    if (res.code !== 0) throw explain(res.text, res.crashed)
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    throw err
  }
  await fs.writeFile(path.join(dir, DONE_MARK), '')
  diagnostics.info('comprimidos', `${name}: ${pages.length} páginas extraídas en ${Math.round((Date.now() - started) / 100) / 10} s`)
  onProgress?.({ name, percent: 100 })
  return dir
}

module.exports = { ARCHIVE_EXTS, isArchive, archiveTitle, init, useCacheDir, extract, parseListing, pagesIn, explain }
