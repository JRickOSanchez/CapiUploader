/**
 * ZIP sin compresión («store») para guardar los capítulos descargados como .zip o .cbz. Las páginas
 * ya vienen comprimidas (JPG, PNG, WEBP), así que comprimirlas otra vez solo gastaría tiempo. Sin
 * dependencias: cabeceras locales, directorio central y el registro final (hasta 4 GB, sin ZIP64).
 */
const path = require('node:path')
const fs = require('node:fs/promises')
const zlib = require('node:zlib')

const LIMIT = 0xffffffff

/** Fecha y hora en el formato de MS-DOS que usa ZIP. */
function dosTime(d = new Date()) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

/**
 * Escribe `file` con los archivos `names` de `dir`, en ese orden y en la raíz del ZIP. Primero a un
 * `.part` que se renombra al final: si el archivo existe, está completo.
 */
async function writeZip(file, dir, names) {
  const tmp = `${file}.part`
  const { time, date } = dosTime()
  const central = []
  let offset = 0
  const fh = await fs.open(tmp, 'w')
  try {
    for (const name of names) {
      const data = await fs.readFile(path.join(dir, name))
      const nameBuf = Buffer.from(name, 'utf8')
      const crc = zlib.crc32(data)
      if (offset + 30 + nameBuf.length + data.length > LIMIT) throw new Error('El capítulo pesa más de 4 GB: no cabe en un ZIP.')
      const h = Buffer.alloc(30)
      h.writeUInt32LE(0x04034b50, 0)
      h.writeUInt16LE(20, 4) // versión necesaria
      h.writeUInt16LE(0x0800, 6) // nombres en UTF-8
      h.writeUInt16LE(0, 8) // sin compresión
      h.writeUInt16LE(time, 10)
      h.writeUInt16LE(date, 12)
      h.writeUInt32LE(crc, 14)
      h.writeUInt32LE(data.length, 18)
      h.writeUInt32LE(data.length, 22)
      h.writeUInt16LE(nameBuf.length, 26)
      h.writeUInt16LE(0, 28)
      await fh.write(h)
      await fh.write(nameBuf)
      await fh.write(data)
      central.push({ nameBuf, crc, size: data.length, offset })
      offset += 30 + nameBuf.length + data.length
    }
    const cdStart = offset
    for (const e of central) {
      const c = Buffer.alloc(46)
      c.writeUInt32LE(0x02014b50, 0)
      c.writeUInt16LE(20, 4) // hecho con
      c.writeUInt16LE(20, 6) // versión necesaria
      c.writeUInt16LE(0x0800, 8)
      c.writeUInt16LE(0, 10)
      c.writeUInt16LE(time, 12)
      c.writeUInt16LE(date, 14)
      c.writeUInt32LE(e.crc, 16)
      c.writeUInt32LE(e.size, 20)
      c.writeUInt32LE(e.size, 24)
      c.writeUInt16LE(e.nameBuf.length, 28)
      // extra, comentario, disco y atributos en 0
      c.writeUInt32LE(e.offset, 42)
      await fh.write(c)
      await fh.write(e.nameBuf)
      offset += 46 + e.nameBuf.length
    }
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(central.length, 8)
    end.writeUInt16LE(central.length, 10)
    end.writeUInt32LE(offset - cdStart, 12)
    end.writeUInt32LE(cdStart, 16)
    await fh.write(end)
  } catch (err) {
    await fh.close().catch(() => {})
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
  await fh.close()
  await fs.rename(tmp, file)
  return file
}

/** Los archivos de un ZIP ({ name, size }) leyendo su directorio central, o null si no es un ZIP válido. */
async function zipEntries(file) {
  let fh
  try {
    fh = await fs.open(file, 'r')
    const { size } = await fh.stat()
    if (size < 22) return null
    const tailLen = Math.min(size, 22 + 0xffff)
    const tail = Buffer.alloc(tailLen)
    await fh.read(tail, 0, tailLen, size - tailLen)
    const at = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    if (at < 0 || at + 22 > tailLen) return null
    const count = tail.readUInt16LE(at + 10)
    const cdSize = tail.readUInt32LE(at + 12)
    const cdOffset = tail.readUInt32LE(at + 16)
    if (cdOffset + cdSize > size) return null
    const cd = Buffer.alloc(cdSize)
    await fh.read(cd, 0, cdSize, cdOffset)
    const out = []
    let p = 0
    for (let i = 0; i < count; i++) {
      if (p + 46 > cdSize || cd.readUInt32LE(p) !== 0x02014b50) return null
      const n = cd.readUInt16LE(p + 28)
      const e = cd.readUInt16LE(p + 30)
      const c = cd.readUInt16LE(p + 32)
      out.push({ name: cd.toString('utf8', p + 46, p + 46 + n), size: cd.readUInt32LE(p + 24) })
      p += 46 + n + e + c
    }
    return out
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => {})
  }
}

module.exports = { writeZip, zipEntries }
