/**
 * Archivos que se arrastran o eligen para subir: describe las imágenes, expande carpetas, detecta
 * los capítulos de «Varios capítulos» (hasta dos niveles de carpetas), abre los comprimidos (zip,
 * cbz, rar, cbr, 7z…: ver archives.js) y convierte los PSD.
 */
const path = require('node:path')
const fs = require('node:fs/promises')
const { pathToFileURL } = require('node:url')
const psd = require('./psd')
const archives = require('./archives')
const { naturalCompare } = require('./util')

const IMAGE_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
}
const IMAGE_EXTS = Object.keys(IMAGE_TYPES).map((e) => e.slice(1))
const MAX_IMAGE_BYTES = 40 * 1024 * 1024

/** Describe una imagen (o null si no lo es). source es el PSD original cuando la imagen es su conversión. */
async function describeFile(filePath, source = null) {
  const ext = path.extname(filePath).toLowerCase()
  const type = IMAGE_TYPES[ext]
  if (!type) return null
  const st = await fs.stat(filePath)
  if (!st.isFile()) return null
  return {
    path: filePath,
    name: path.basename(source || filePath),
    size: st.size,
    mtime: st.mtimeMs,
    type,
    url: pathToFileURL(filePath).href,
    ...(source ? { source } : {}),
  }
}

function isAccepted(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  return Boolean(IMAGE_TYPES[ext]) || psd.PSD_EXTS.has(ext)
}

/** Resumen de la conversión de PSD para la interfaz (null si no había ninguno). */
function psdReport(summary) {
  if (!summary) return null
  return {
    converted: summary.converted,
    cached: summary.cached,
    keptText: summary.keptText,
    missingFonts: [...summary.missingFonts],
    substituted: summary.substituted,
    failed: summary.failed,
  }
}

/**
 * Describe una lista de rutas en orden. Los PSD se convierten todos juntos (psdc los procesa en
 * paralelo) y se describen como su JPG en caché; `onPsd` recibe el avance. Las rutas que no sirven
 * van a skipped.
 */
async function describeMany(paths, onPsd) {
  const psdPaths = paths.filter(psd.isPsd)
  let converted = null
  let summary = null
  if (psdPaths.length) {
    ;({ result: converted, summary } = await psd.convertAll(psdPaths, onPsd))
    onPsd?.({ finished: true })
  }
  const files = []
  const skipped = []
  for (const p of paths) {
    let f = null
    if (psd.isPsd(p)) {
      const c = converted.get(p)
      if (c?.out) f = await describeFile(c.out, p).catch(() => null)
    } else {
      f = await describeFile(p).catch(() => null)
    }
    if (f) files.push(f)
    else skipped.push(path.basename(p))
  }
  return { files, skipped, summary }
}

/** Imágenes y PSD de una carpeta (sin entrar a subcarpetas), en orden natural. */
async function listCandidates(dir) {
  const names = (await fs.readdir(dir)).sort(naturalCompare)
  return names.filter(isAccepted).map((name) => path.join(dir, name))
}

async function listSubdirs(dir) {
  return (await fs.readdir(dir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort(naturalCompare)
}

/** Imágenes y PSD de una carpeta y sus subcarpetas: primero las sueltas, luego cada subcarpeta en orden. */
async function listDeep(dir, depth = 0) {
  const out = await listCandidates(dir)
  if (depth < 4) for (const sub of await listSubdirs(dir)) out.push(...await listDeep(path.join(dir, sub), depth + 1))
  return out
}

/**
 * «Un capítulo»: expande carpetas (un nivel) y comprimidos (todas sus imágenes, en orden) y
 * devuelve solo las imágenes válidas. problems: comprimidos que no se pudieron abrir y por qué.
 */
async function resolvePaths(paths, onPsd, onArchive) {
  const candidates = []
  const skipped = []
  const problems = []
  let opened = false
  for (const p of paths) {
    let st
    try { st = await fs.stat(p) } catch { skipped.push(path.basename(p)); continue }
    if (st.isDirectory()) candidates.push(...await listCandidates(p))
    else if (archives.isArchive(p)) {
      opened = true
      try { candidates.push(...await listDeep(await archives.extract(p, { onProgress: onArchive }))) }
      catch (err) { problems.push({ name: path.basename(p), message: err.message }) }
    }
    else if (isAccepted(p)) candidates.push(p)
    else skipped.push(path.basename(p))
  }
  if (opened) onArchive?.({ finished: true })
  const res = await describeMany(candidates, onPsd)
  return { files: res.files, skipped: [...skipped, ...res.skipped], problems, psd: psdReport(res.summary) }
}

/**
 * Nombres de las carpetas que contienen al capítulo, de la más cercana a la más lejana, hasta la
 * que contiene lo elegido. Sirven para adivinar la obra: «Lote/Choujin X/Vol 1/Cap 3» →
 * ["Vol 1", "Choujin X", "Lote", …].
 */
function ancestorNames(dir, root) {
  const out = []
  const stop = path.dirname(path.resolve(root))
  let cur = path.dirname(path.resolve(dir))
  while (out.length < 4) {
    const name = path.basename(cur)
    if (!name) break
    out.push(name)
    if (cur === stop || path.dirname(cur) === cur) break
    cur = path.dirname(cur)
  }
  return out
}

const listArchives = async (dir) =>
  (await fs.readdir(dir).catch(() => [])).filter(archives.isArchive).sort(naturalCompare).map((n) => path.join(dir, n))

/**
 * Carpetas con imágenes dentro de `root`, hasta dos niveles: «Lote/Kirara/Cap 4» u «Obra/Vol 1/Cap 4».
 * Los comprimidos de esos niveles («Obra/Cap 4.cbz») van como { archive, root } para abrirlos después.
 */
async function findChapterDirs(root, { withArchives = true } = {}) {
  const own = await listCandidates(root)
  if (own.length) return [{ name: path.basename(root), dir: root, root, candidates: own }]
  const found = []
  const addArchives = async (dir) => { if (withArchives) for (const archive of await listArchives(dir)) found.push({ archive, root }) }
  await addArchives(root)
  for (const sub of await listSubdirs(root)) {
    const dir = path.join(root, sub)
    const files = await listCandidates(dir).catch(() => [])
    if (files.length) { found.push({ name: sub, dir, root, candidates: files }); continue }
    await addArchives(dir)
    for (const sub2 of await listSubdirs(dir).catch(() => [])) {
      const dir2 = path.join(dir, sub2)
      const files2 = await listCandidates(dir2).catch(() => [])
      if (files2.length) found.push({ name: sub2, dir: dir2, root, candidates: files2 })
      else await addArchives(dir2)
    }
  }
  return found
}

/**
 * Los capítulos de un comprimido. Si tiene uno solo (imágenes sueltas o en una carpeta), se llama
 * como el archivo («Cap 4.cbz» → «Cap 4»); si tiene varias carpetas, cada una es un capítulo y el
 * nombre del archivo cuenta como la carpeta de la obra («Kirara.zip/Cap 4» → obra «Kirara»).
 */
async function archiveChapters(archivePath, root, onArchive) {
  const base = await archives.extract(archivePath, { onProgress: onArchive })
  const inner = await findChapterDirs(base, { withArchives: false })
  const title = archives.archiveTitle(archivePath)
  const outer = ancestorNames(archivePath, root)
  const archive = path.basename(archivePath)
  if (inner.length === 1) return [{ ...inner[0], name: title, root, archive, ancestors: outer }]
  return inner.map((c) => {
    const within = path.relative(base, path.dirname(c.dir)).split(path.sep).filter((s) => s && s !== '.').reverse()
    return { ...c, root, archive, ancestors: [...within, title, ...outer].slice(0, 4) }
  })
}

/**
 * «Varios capítulos»: cada carpeta con imágenes es un capítulo, y cada comprimido, uno o varios.
 * parent es la carpeta que contiene al capítulo y ancestors todas las que lo contienen; sirven para
 * adivinar la obra. problems: comprimidos que no se pudieron abrir y por qué.
 */
async function resolveChapters(paths, onPsd, onArchive) {
  const found = [] // { name, dir, root, candidates, archive?, ancestors? }
  const skipped = []
  const problems = []
  let looseFiles = 0
  let opened = false
  const open = async (archivePath, root) => {
    opened = true
    try { found.push(...await archiveChapters(archivePath, root, onArchive)) }
    catch (err) { problems.push({ name: path.basename(archivePath), message: err.message }) }
  }
  for (const p of paths) {
    let st
    try { st = await fs.stat(p) } catch { skipped.push(path.basename(p)); continue }
    if (!st.isDirectory()) {
      if (archives.isArchive(p)) await open(p, p)
      else looseFiles++
      continue
    }
    const dirs = await findChapterDirs(p)
    if (!dirs.length) { skipped.push(path.basename(p)); continue }
    for (const d of dirs) {
      if (d.archive) await open(d.archive, d.root)
      else found.push(d)
    }
  }
  if (opened) onArchive?.({ finished: true })

  // Todas las páginas de todos los capítulos de una vez, para convertir los PSD en un solo paso.
  const { files, summary } = await describeMany(found.flatMap((c) => c.candidates), onPsd)
  const byPath = new Map(files.map((f) => [f.source || f.path, f]))
  const chapters = []
  for (const c of found) {
    const chFiles = c.candidates.map((p) => byPath.get(p)).filter(Boolean)
    if (!chFiles.length) { skipped.push(c.name); continue }
    const ancestors = c.ancestors || ancestorNames(c.dir, c.root)
    chapters.push({
      name: c.name, dir: c.dir, parent: ancestors[0] || '', ancestors, files: chFiles,
      // archive: el comprimido de donde salió (la carpeta es la de la caché).
      ...(c.archive ? { archive: c.archive } : {}),
    })
  }
  return { chapters, skipped, looseFiles, problems, psd: psdReport(summary) }
}

const ARCHIVE_EXTS = [...archives.ARCHIVE_EXTS].map((e) => e.slice(1))

module.exports = { IMAGE_TYPES, IMAGE_EXTS, ARCHIVE_EXTS, MAX_IMAGE_BYTES, describeFile, resolvePaths, resolveChapters, ancestorNames }
