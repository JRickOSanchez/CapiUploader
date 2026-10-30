/**
 * Genera las imágenes del instalador (NSIS) a partir de build/icon.svg:
 *   build/installerSidebar.bmp    164×314  bienvenida y final del instalador
 *   build/uninstallerSidebar.bmp  164×314  bienvenida y final del desinstalador
 *   build/installerHeader.bmp     150×57   encabezado de las páginas intermedias
 *
 *   npm run installer-art
 *
 * Se dibujan con el canvas de Chromium (como build-icon.cjs) al doble de tamaño y se reducen, para
 * que los bordes y el texto queden suaves. NSIS solo acepta BMP de 24 bits sin transparencia.
 * Con PREVIEW=carpeta guarda además una vista previa (PNG) de las páginas del instalador.
 */
const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow } = require('electron')

const root = path.join(__dirname, '..')
const SCALE = 2
const iconSvg = fs.readFileSync(path.join(root, 'build', 'icon.svg'), 'utf8')
const iconHref = `data:image/svg+xml;base64,${Buffer.from(iconSvg).toString('base64')}`
const FONT = "'Segoe UI Variable Display', 'Segoe UI', sans-serif"
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')

/* ---------- Diseños ---------- */

/** Barra lateral oscura con el ícono, el nombre y debajo `lines` (o una lista con checks). */
function sidebar({ tagline, items = [], footer = '' }) {
  const check = (y) => `<path d="M24 ${y - 3}l3 3 6-6" fill="none" stroke="#3cc8e8" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="164" height="314" viewBox="0 0 164 314">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2=".35" y2="1">
      <stop offset="0" stop-color="#141925"/><stop offset=".55" stop-color="#0d1016"/><stop offset="1" stop-color="#08090c"/>
    </linearGradient>
    <radialGradient id="glow" cx=".5" cy=".5" r=".5">
      <stop offset="0" stop-color="#12b5d9" stop-opacity=".42"/><stop offset="1" stop-color="#12b5d9" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="line" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#3cc8e8"/><stop offset="1" stop-color="#3cc8e8" stop-opacity="0"/>
    </linearGradient>
    <pattern id="dots" width="10" height="10" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".7" fill="#ffffff" fill-opacity=".05"/></pattern>
  </defs>
  <rect width="164" height="314" fill="url(#bg)"/>
  <rect y="214" width="164" height="100" fill="url(#dots)"/>
  <circle cx="82" cy="78" r="88" fill="url(#glow)"/>
  <path d="M-20 300 L190 205" stroke="#3cc8e8" stroke-opacity=".07" stroke-width="22"/>
  <path d="M-20 330 L190 235" stroke="#3cc8e8" stroke-opacity=".04" stroke-width="12"/>
  <image href="${iconHref}" x="44" y="40" width="76" height="76"/>
  <text x="82" y="146" text-anchor="middle" font-family="${FONT}" font-size="18.5" font-weight="800" font-style="italic" letter-spacing="-.2">
    <tspan fill="#f3f4f6">Capi</tspan><tspan fill="#3cc8e8">Uploader</tspan>
  </text>
  <text x="82" y="161" text-anchor="middle" font-family="${FONT}" font-size="7.2" font-weight="700" letter-spacing="1.9" fill="#7c818c">CAPIBARA TRADUCTOR</text>
  <rect x="68" y="173" width="28" height="2" rx="1" fill="url(#line)"/>
  ${tagline.map((t, i) => `<text x="82" y="${193 + i * 13.5}" text-anchor="middle" font-family="${FONT}" font-size="10.4" fill="#c5c9d1">${esc(t)}</text>`).join('\n  ')}
  ${items.map((t, i) => `${check(236 + i * 17)}<text x="39" y="${239 + i * 17}" font-family="${FONT}" font-size="9.6" font-weight="600" fill="#e6e8ee">${esc(t)}</text>`).join('\n  ')}
  ${footer ? `<text x="82" y="302" text-anchor="middle" font-family="${FONT}" font-size="8" fill="#6b707b">${esc(footer)}</text>` : ''}
</svg>`
}

/** Encabezado claro (las páginas intermedias de NSIS tienen fondo blanco): nombre y ícono a la derecha. */
const header = () => `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="57" viewBox="0 0 150 57">
  <rect width="150" height="57" fill="#ffffff"/>
  <text x="104" y="29" text-anchor="end" font-family="${FONT}" font-size="13.5" font-weight="800" font-style="italic" letter-spacing="-.2">
    <tspan fill="#11141b">Capi</tspan><tspan fill="#0aa8cc">Uploader</tspan>
  </text>
  <text x="104" y="40" text-anchor="end" font-family="${FONT}" font-size="5.6" font-weight="700" letter-spacing="1.3" fill="#8a909c">CAPIBARA TRADUCTOR</text>
  <image href="${iconHref}" x="110" y="10" width="37" height="37"/>
</svg>`

const DESIGNS = {
  installerSidebar: sidebar({
    tagline: ['Sube capítulos a Capibara', 'desde tu escritorio'],
    items: ['Uno o muchos a la vez', 'Importa de otras webs', 'Se actualiza sola'],
  }),
  uninstallerSidebar: sidebar({
    tagline: ['Gracias por usarla.', 'Tus scans y ajustes', 'quedan guardados.'],
  }),
  installerHeader: header(),
}

/* ---------- BMP de 24 bits ---------- */

/** RGBA (de arriba abajo) → BMP de 24 bits (de abajo arriba, filas alineadas a 4 bytes). */
function toBmp(width, height, rgba) {
  const row = Math.ceil((width * 3) / 4) * 4
  const size = 54 + row * height
  const out = Buffer.alloc(size)
  out.write('BM', 0, 'latin1')
  out.writeUInt32LE(size, 2)
  out.writeUInt32LE(54, 10)
  out.writeUInt32LE(40, 14)
  out.writeInt32LE(width, 18)
  out.writeInt32LE(height, 22)
  out.writeUInt16LE(1, 26)
  out.writeUInt16LE(24, 28)
  out.writeUInt32LE(row * height, 34)
  out.writeInt32LE(2835, 38) // 72 ppp
  out.writeInt32LE(2835, 42)
  for (let y = 0; y < height; y++) {
    const dst = 54 + (height - 1 - y) * row
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4
      out[dst + x * 3] = rgba[src + 2]
      out[dst + x * 3 + 1] = rgba[src + 1]
      out[dst + x * 3 + 2] = rgba[src]
    }
  }
  return out
}

/* ---------- Dibujo ---------- */

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  await win.loadURL('data:text/html,<!doctype html><title>art</title>')

  /** Dibuja el SVG al doble y lo reduce. Devuelve { rgba (base64), png (base64) }. */
  const render = (svg, w, h) => win.webContents.executeJavaScript(`(async () => {
    const img = new Image()
    img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg).toString('base64'))}
    await img.decode()
    const big = new OffscreenCanvas(${w * SCALE}, ${h * SCALE})
    big.getContext('2d').drawImage(img, 0, 0, ${w * SCALE}, ${h * SCALE})
    const c = document.createElement('canvas')
    c.width = ${w}; c.height = ${h}
    const g = c.getContext('2d')
    g.imageSmoothingQuality = 'high'
    g.drawImage(big, 0, 0, ${w}, ${h})
    const data = g.getImageData(0, 0, ${w}, ${h}).data
    let s = ''
    for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode.apply(null, data.subarray(i, i + 0x8000))
    return { rgba: btoa(s), png: c.toDataURL('image/png').split(',')[1] }
  })()`)

  const sizes = { installerSidebar: [164, 314], uninstallerSidebar: [164, 314], installerHeader: [150, 57] }
  const pngs = {}
  for (const [name, svg] of Object.entries(DESIGNS)) {
    const [w, h] = sizes[name]
    const { rgba, png } = await render(svg, w, h)
    fs.writeFileSync(path.join(root, 'build', `${name}.bmp`), toBmp(w, h, Buffer.from(rgba, 'base64')))
    pngs[name] = png
  }
  console.log('Imágenes del instalador:', Object.keys(DESIGNS).map((n) => `build/${n}.bmp`).join(', '))

  if (process.env.PREVIEW) await preview(win, pngs, process.env.PREVIEW)
  app.quit()
})

/** Vista previa aproximada de las páginas del asistente (tamaño real de NSIS: 497×360 a 100 %). */
async function preview(win, pngs, dir) {
  fs.mkdirSync(dir, { recursive: true })
  const page = (body) => `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;width:497px;height:360px;font:12px 'Segoe UI',sans-serif;background:#f0f0f0;overflow:hidden}
    .side{position:absolute;left:0;top:0;width:164px;height:314px}
    .pane{position:absolute;left:164px;top:0;width:333px;height:314px;background:#fff;padding:14px 18px;box-sizing:border-box}
    h1{font:600 15px 'Segoe UI';margin:6px 0 14px} p{margin:0 0 10px;line-height:1.4}
    .bar{position:absolute;left:0;right:0;top:314px;height:46px;border-top:1px solid #dfdfdf;display:flex;gap:8px;align-items:center;justify-content:flex-end;padding:0 12px}
    .btn{border:1px solid #adadad;background:#e1e1e1;padding:3px 0;width:75px;text-align:center}
    .btn.def{border-color:#0078d7}
    .head{position:absolute;left:0;right:0;top:0;height:57px;background:#fff;border-bottom:1px solid #dfdfdf}
    .head img{position:absolute;right:0;top:0} .head b{position:absolute;left:14px;top:10px} .head span{position:absolute;left:24px;top:30px;color:#444}
    .inner{position:absolute;top:70px;left:24px;right:24px}
  </style>${body}`
  const shots = {
    bienvenida: page(`<img class="side" src="data:image/png;base64,${pngs.installerSidebar}"><div class="pane"><h1>Te damos la bienvenida a CapiUploader</h1><p>Sube capítulos a Capibara Traductor desde tu escritorio: uno o muchos a la vez, desde carpetas o archivos de Photoshop, o importados de otras webs.</p><p>Si ya la tenías, tus scans y ajustes se conservan.</p><p>Cierra CapiUploader si está abierto y pulsa «Siguiente».</p></div><div class="bar"><span class="btn def">Siguiente &gt;</span><span class="btn">Cancelar</span></div>`),
    carpeta: page(`<div class="head"><b>Elegir lugar de instalación</b><span>Elija el directorio para instalar CapiUploader.</span><img src="data:image/png;base64,${pngs.installerHeader}"></div><div class="inner"><p>El programa de instalación instalará CapiUploader en el siguiente directorio…</p></div><div class="bar"><span class="btn">&lt; Atrás</span><span class="btn def">Instalar</span><span class="btn">Cancelar</span></div>`),
    final: page(`<img class="side" src="data:image/png;base64,${pngs.installerSidebar}"><div class="pane"><h1>CapiUploader está listo</h1><p>Ya puedes subir tus capítulos. Cuando salga una versión nueva, la app se actualiza sola.</p><p>☑ Abrir CapiUploader</p></div><div class="bar"><span class="btn def">Terminar</span></div>`),
  }
  for (const [name, html] of Object.entries(shots)) {
    await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`)
    win.setContentSize(497, 360)
    await new Promise((r) => setTimeout(r, 300))
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: 497, height: 360 })
    fs.writeFileSync(path.join(dir, `${name}.png`), img.toPNG())
  }
  console.log('Vista previa en', dir)
}
