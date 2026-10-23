/**
 * Compila el motor de sitios de HaruNeko (https://github.com/manga-download/haruneko, Unlicense)
 * en un solo archivo para «Importar de web»: src/scraper/engine.js.
 *
 * Uso: node scripts/build-scraper.mjs <carpeta de HaruNeko>
 *
 * Se usan tal cual los sitios, plantillas y la lógica de red de HaruNeko. Solo se reemplazan los
 * módulos de su aplicación que CapiUploader no necesita (ajustes, almacenamiento, exportadores,
 * idiomas): están en scripts/scraper/shims.
 */
import esbuild from 'esbuild'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const haruneko = path.resolve(process.argv[2] || process.env.HARUNEKO_DIR || '')
const web = path.join(haruneko, 'web', 'src')
const engine = path.join(web, 'engine')
const i18n = path.join(web, 'i18n')
if (!fs.existsSync(path.join(engine, 'websites', '_index.ts'))) {
  console.error('Indica la carpeta de HaruNeko: node scripts/build-scraper.mjs <carpeta>')
  process.exit(1)
}
const shims = path.join(root, 'scripts', 'scraper', 'shims')
const outfile = path.join(root, 'src', 'scraper', 'engine.js')

const norm = (p) => path.normalize(p).toLowerCase()
const replaced = new Map([
  [path.join(engine, 'platform', 'FetchProvider.ts'), 'FetchProvider.ts'],
  [path.join(engine, 'platform', 'RemoteBrowserWindow.ts'), 'RemoteBrowserWindow.ts'],
  [path.join(engine, 'BackgroundTimers.ts'), 'BackgroundTimers.ts'],
  [path.join(engine, 'SettingsGlobal.ts'), 'SettingsGlobal.ts'],
  [path.join(engine, 'StorageController.ts'), 'StorageController.ts'],
  [path.join(engine, 'exporters', 'MangaExporterRegistry.ts'), 'MangaExporterRegistry.ts'],
  [path.join(i18n, 'Localization.ts'), 'Localization.ts'],
].map(([from, to]) => [norm(from), path.join(shims, to)]))

const capiPlugin = {
  name: 'capi-haruneko',
  setup(build) {
    // Alias para los shims: @engine/… y @i18n/…
    build.onResolve({ filter: /^@(engine|i18n)\// }, async (args) => {
      const [, base, rest] = args.path.match(/^@(engine|i18n)\/(.*)$/)
      const res = await build.resolve(`./${rest}`, { resolveDir: base === 'engine' ? engine : i18n, kind: args.kind, pluginData: { capi: true } })
      if (res.errors.length) return { errors: res.errors }
      // Un shim no se reemplaza a sí mismo (p. ej. el de FetchProvider importa el de Electron).
      const shim = replaced.get(norm(res.path))
      return { path: shim && shim !== args.importer ? shim : res.path }
    })
    // Importaciones de Vite: «archivo?raw» se carga como texto.
    build.onResolve({ filter: /\?raw$/ }, (args) => ({ path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, '')), namespace: 'raw' }))
    build.onLoad({ filter: /.*/, namespace: 'raw' }, (args) => ({ contents: fs.readFileSync(args.path, 'utf8'), loader: 'text' }))
    // Módulos de la aplicación de HaruNeko que se reemplazan por shims.
    build.onResolve({ filter: /^\.\.?\// }, async (args) => {
      if (args.pluginData?.capi) return undefined
      const res = await build.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind, importer: args.importer, pluginData: { capi: true } })
      if (res.errors.length) return { errors: res.errors }
      const shim = replaced.get(norm(res.path))
      return { path: shim || res.path }
    })
  },
}

const commit = (() => {
  try { return execFileSync('git', ['-C', haruneko, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } catch { return 'desconocido' }
})()

const result = await esbuild.build({
  entryPoints: [path.join(root, 'scripts', 'scraper', 'entry.ts')],
  outfile,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome140',
  minify: true,
  legalComments: 'none',
  charset: 'utf8',
  nodePaths: [path.join(root, 'node_modules')],
  loader: { '.webp': 'dataurl', '.png': 'dataurl', '.jpg': 'dataurl', '.svg': 'dataurl', '.proto': 'text' },
  tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false, verbatimModuleSyntax: true } },
  banner: { js: `/* Motor de sitios de HaruNeko (Unlicense) · https://github.com/manga-download/haruneko · commit ${commit} */` },
  plugins: [capiPlugin],
  logLevel: 'warning',
  metafile: true,
})

const size = fs.statSync(outfile).size
const sites = fs.readFileSync(path.join(engine, 'websites', '_index.ts'), 'utf8').match(/^export /gm)?.length ?? 0
fs.writeFileSync(path.join(root, 'src', 'scraper', 'engine.json'), JSON.stringify({ commit, sites, builtAt: new Date().toISOString() }, null, 2))
console.log(`src/scraper/engine.js · ${(size / 1024 / 1024).toFixed(1)} MB · ${sites} sitios · HaruNeko ${commit.slice(0, 10)}`)
if (result.warnings.length) console.log(`${result.warnings.length} avisos`)
