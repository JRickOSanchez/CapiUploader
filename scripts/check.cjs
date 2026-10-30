// Revisa la sintaxis de todos los scripts de la app (sin ejecutarlos): `npm run check`.
// Se corre antes de `npm run dist` para no empaquetar un archivo roto.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const DIRS = ['src/main', 'src/preload', 'src/renderer/js', 'scripts', 'test']
// El motor de HaruNeko viene compilado: no se revisa.
const SKIP = new Set([path.join(ROOT, 'src', 'scraper', 'engine.js')])

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name)
    if (d.isDirectory()) return d.name === 'node_modules' ? [] : walk(p)
    return /\.(c|m)?js$/.test(d.name) && !SKIP.has(p) ? [p] : []
  })
}

const files = DIRS.flatMap((d) => walk(path.join(ROOT, d)))
let failed = 0
for (const file of files) {
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (res.status !== 0) {
    failed++
    console.error(`✖ ${path.relative(ROOT, file)}\n${res.stderr.trim()}\n`)
  }
}
console.log(failed ? `${failed} de ${files.length} archivos con errores.` : `${files.length} archivos sin errores de sintaxis.`)
process.exit(failed ? 1 : 0)
