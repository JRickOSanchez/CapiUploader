/**
 * Hilo del convertidor: decodifica la imagen y la codifica a WebP (Crimson y Mangation) o a JPG
 * (MangaDex). Los bytes entran y salen transferidos (sin copias).
 *   - WebP: se reduce si pasa el máximo de WebP (16383 px por lado).
 *   - Con `slice` (MangaDex): el ancho se limita a `maxSide` y una tira más alta que `slice` se corta
 *     en varias partes, de arriba abajo, sin reducirla (dibujando trozo por trozo, sin un lienzo enorme).
 *   - JPG no tiene transparencia: se pinta fondo blanco.
 */
const MAX_SIDE = 16383

self.onmessage = async ({ data: job }) => {
  let bitmap = null
  try {
    bitmap = await createImageBitmap(new Blob([job.bytes], { type: job.type }))
    const format = job.format || 'image/webp'
    const maxSide = job.maxSide || MAX_SIDE
    const scale = job.slice
      ? Math.min(1, maxSide / bitmap.width)
      : Math.min(1, maxSide / bitmap.width, maxSide / bitmap.height, job.maxWidth ? job.maxWidth / bitmap.width : 1)
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const sliceH = job.slice && h > job.slice ? job.slice : h
    const parts = []
    for (let y = 0; y < h; y += sliceH) {
      const ph = Math.min(sliceH, h - y)
      const canvas = new OffscreenCanvas(w, ph)
      const ctx = canvas.getContext('2d', { alpha: format !== 'image/jpeg' && job.type !== 'image/jpeg' })
      if (format === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, ph) }
      ctx.imageSmoothingQuality = 'high'
      // Trozo de la imagen original que corresponde a esta parte.
      ctx.drawImage(bitmap, 0, y / scale, bitmap.width, ph / scale, 0, 0, w, ph)
      const blob = await canvas.convertToBlob({ type: format, quality: job.quality })
      if (blob.type !== format) throw new Error(`Este equipo no pudo codificar ${format === 'image/jpeg' ? 'JPG' : 'WebP'}.`)
      parts.push(await blob.arrayBuffer())
      canvas.width = canvas.height = 0
    }
    self.postMessage({ id: job.id, ok: true, bytes: parts[0], parts, width: w, height: h, resized: scale < 1, srcWidth: bitmap.width, srcHeight: bitmap.height }, parts)
  } catch (err) {
    self.postMessage({ id: job.id, ok: false, error: String(err?.message || err) })
  } finally {
    bitmap?.close()
  }
}
