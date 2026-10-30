/**
 * Conversión de archivos de Photoshop (.psd / .psb) a JPG con psdc
 * (https://github.com/ChoqueCastroLD/psd-compiler-cli, MIT), que se empaqueta junto a la app.
 *
 * Cada PSD se convierte una vez y se guarda en una caché por ruta + tamaño + fecha de
 * modificación: el resto de la app recibe una imagen normal y nunca ve el PSD.
 */
const { app } = require('electron')
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const path = require('node:path')
const fs = require('node:fs/promises')
const { prepareCache } = require('./util')

const PSD_EXTS = new Set(['.psd', '.psb'])
const QUALITY = 92
// Windows limita la línea de comandos a ~32 000 caracteres.
const MAX_ARGS_CHARS = 24000

let cacheDir = null
let ready = null

function isPsd(filePath) {
  return PSD_EXTS.has(path.extname(filePath).toLowerCase())
}

function binaryPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'psdc', 'psdc.exe')
    : path.join(__dirname, '..', '..', 'vendor', 'psdc', 'psdc.exe')
}

function init(userData) {
  ready = prepare(userData)
  return ready
}

async function prepare(userData) {
  cacheDir = await prepareCache(path.join(userData, 'psd-cache'))
}

function cachedPath(src, st) {
  const id = crypto.createHash('sha1').update(`${path.resolve(src)}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 20)
  return path.join(cacheDir, `${id}.jpg`)
}

/** Ejecuta psdc y devuelve stderr (avisos y errores) y el código de salida. */
function run(args, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath(), args, { windowsHide: true })
    let stderr = ''
    let buf = ''
    child.stderr.on('data', (d) => {
      const s = d.toString('utf8')
      stderr += s
      buf += s
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        onLine?.(buf.slice(0, i).trim())
        buf = buf.slice(i + 1)
      }
    })
    child.stdout.resume()
    child.on('error', (err) => {
      reject(err.code === 'ENOENT'
        ? new Error('No se encontró el conversor de PSD (psdc.exe). Reinstala la app.')
        : err)
    })
    child.on('close', (code) => resolve({ code, stderr }))
  })
}

/** Reparte las entradas en llamadas que caben en la línea de comandos y sin nombres repetidos. */
function chunk(jobs) {
  const groups = []
  for (const job of jobs) {
    const stem = path.parse(job.src).name.toLowerCase()
    let g = groups.find((g) => !g.stems.has(stem) && g.chars + job.src.length + 3 < MAX_ARGS_CHARS)
    if (!g) groups.push((g = { jobs: [], stems: new Set(), chars: 0 }))
    g.jobs.push(job)
    g.stems.add(stem)
    g.chars += job.src.length + 3
  }
  return groups.map((g) => g.jobs)
}

/** Avisos de psdc por archivo: «warning: RUTA: mensaje». */
function parseWarnings(stderr, jobs) {
  const byFile = new Map(jobs.map((j) => [j.src, []]))
  for (const line of stderr.split(/\r?\n/)) {
    if (!line.startsWith('warning: ')) continue
    const rest = line.slice(9)
    const job = jobs.find((j) => rest.startsWith(`${j.src}: `))
    if (job) byFile.get(job.src).push(rest.slice(job.src.length + 2))
  }
  return byFile
}

/** Convierte un grupo a una carpeta temporal y mueve cada resultado a su lugar en la caché. */
async function convertGroup(jobs, { keepText, onDone }) {
  const outDir = path.join(cacheDir, `tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`)
  await fs.mkdir(outDir, { recursive: true })
  try {
    const args = ['-F', 'jpg', '-Q', String(QUALITY), '-o', outDir]
    if (keepText) args.push('--keep-text')
    // Con una sola entrada, -o se toma como archivo salvo que la carpeta ya exista (y existe).
    args.push('--', ...jobs.map((j) => j.src))
    const { stderr } = await run(args, (line) => {
      if (line.includes(' -> ') && !line.startsWith('warning: ')) onDone?.()
    })
    const warnings = parseWarnings(stderr, jobs)
    const errors = stderr.split(/\r?\n/).filter((l) => l.startsWith('error: ')).map((l) => l.slice(7))
    const results = []
    for (const job of jobs) {
      const produced = path.join(outDir, `${path.parse(job.src).name}.jpg`)
      try {
        await fs.rename(produced, job.out)
        results.push({ job, ok: true, warnings: warnings.get(job.src) })
      } catch {
        const error = errors.find((e) => e.includes(job.src)) || 'psdc no generó la imagen.'
        results.push({ job, ok: false, error: error.replace(job.src, path.basename(job.src)) })
      }
    }
    return results
  } finally {
    await fs.rm(outDir, { recursive: true, force: true }).catch(() => {})
  }
}

const FONT_MISSING = /font (.+?) not found/

/**
 * Convierte los PSD que aún no estén en caché. Devuelve un Map ruta → { out } | { error },
 * y un resumen con las fuentes que faltan y las páginas que usaron el texto guardado.
 *
 * Si una página usa una fuente que no está instalada, se vuelve a convertir con el texto que
 * Photoshop guardó en el archivo: así se ve como lo dejó el editor y no con otra fuente.
 */
async function convertAll(sources, onProgress) {
  await ready
  const result = new Map()
  const summary = { converted: 0, cached: 0, keptText: [], substituted: 0, missingFonts: new Set(), failed: [] }
  const jobs = []
  for (const src of sources) {
    const st = await fs.stat(src).catch(() => null)
    if (!st?.isFile()) { result.set(src, { error: 'No se pudo leer el archivo.' }); continue }
    const out = cachedPath(src, st)
    if (await fs.stat(out).then((s) => s.size > 0).catch(() => false)) {
      result.set(src, { out })
      summary.cached++
    } else {
      jobs.push({ src, out })
    }
  }
  if (!jobs.length) return { result, summary }

  let done = 0
  const total = jobs.length
  const tick = () => onProgress?.({ done: Math.min(++done, total), total })
  onProgress?.({ done: 0, total })

  const retry = []
  for (const group of chunk(jobs)) {
    for (const r of await convertGroup(group, { keepText: false, onDone: tick })) {
      if (!r.ok) { result.set(r.job.src, { error: r.error }); summary.failed.push(path.basename(r.job.src)); continue }
      const missing = r.warnings.map((w) => w.match(FONT_MISSING)?.[1]).filter(Boolean)
      if (missing.length) {
        missing.forEach((f) => summary.missingFonts.add(f))
        retry.push(r.job)
      } else {
        result.set(r.job.src, { out: r.job.out })
        summary.converted++
      }
    }
  }

  for (const group of chunk(retry)) {
    for (const r of await convertGroup(group, { keepText: true })) {
      // Si falla, se queda la primera conversión (ya en caché). Si vuelve a avisar de fuentes,
      // alguna capa de texto no tenía píxeles guardados y psdc la dibujó con una sustituta.
      // Con otro nombre, para que no se reutilice: si luego se instalan las fuentes, volver a
      // agregar el archivo lo convierte de nuevo.
      const out = r.job.out.replace(/\.jpg$/, '.sin-fuentes.jpg')
      await fs.rename(r.job.out, out)
      result.set(r.job.src, { out })
      summary.converted++
      if (r.ok && !r.warnings.some((w) => FONT_MISSING.test(w))) summary.keptText.push(path.basename(r.job.src))
      else summary.substituted++
    }
  }
  return { result, summary }
}

module.exports = { isPsd, init, convertAll, PSD_EXTS }
