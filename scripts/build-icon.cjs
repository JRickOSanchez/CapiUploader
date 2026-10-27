/**
 * Genera los íconos a partir de build/icon.svg (y build/icon-small.svg para 16–32 px):
 *   build/icon.png (512), build/icon.ico (16–256) y src/renderer/assets/icon.png (ventana).
 *
 *   npx electron scripts/build-icon.cjs
 *
 * Usa el canvas de Chromium de una ventana oculta, así no hace falta ninguna dependencia más.
 */
const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow } = require('electron')

const root = path.join(__dirname, '..')
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
const SMALL_MAX = 32

/** ICO con las imágenes en PNG (Windows Vista en adelante). */
function buildIco(pngs) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(pngs.length, 4)
  const entries = []
  let offset = 6 + 16 * pngs.length
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16)
    e.writeUInt8(size >= 256 ? 0 : size, 0)
    e.writeUInt8(size >= 256 ? 0 : size, 1)
    e.writeUInt8(0, 2)
    e.writeUInt8(0, 3)
    e.writeUInt16LE(1, 4)
    e.writeUInt16LE(32, 6)
    e.writeUInt32LE(data.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += data.length
    entries.push(e)
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)])
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  await win.loadURL('data:text/html,<!doctype html><title>icon</title>')
  const render = (svg, size) => win.webContents.executeJavaScript(`(async () => {
    const img = new Image()
    img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg).toString('base64'))}
    await img.decode()
    const c = document.createElement('canvas')
    c.width = c.height = ${size}
    const g = c.getContext('2d')
    g.imageSmoothingQuality = 'high'
    g.drawImage(img, 0, 0, ${size}, ${size})
    return c.toDataURL('image/png').split(',')[1]
  })()`).then((b64) => Buffer.from(b64, 'base64'))

  const big = fs.readFileSync(path.join(root, 'build', 'icon.svg'), 'utf8')
  const small = fs.readFileSync(path.join(root, 'build', 'icon-small.svg'), 'utf8')
  const png512 = await render(big, 512)
  fs.writeFileSync(path.join(root, 'build', 'icon.png'), png512)
  fs.writeFileSync(path.join(root, 'src', 'renderer', 'assets', 'icon.png'), await render(big, 256))
  const pngs = []
  for (const size of ICO_SIZES) pngs.push({ size, data: await render(size <= SMALL_MAX ? small : big, size) })
  fs.writeFileSync(path.join(root, 'build', 'icon.ico'), buildIco(pngs))
  console.log('Íconos generados:', ['build/icon.png', 'build/icon.ico', 'src/renderer/assets/icon.png'].join(', '))
  app.quit()
})
