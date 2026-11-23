/**
 * Hilo del convertidor: decodifica la imagen, la reduce si pasa el máximo de WebP (16383 px por lado)
 * y la codifica a WebP. Los bytes entran y salen transferidos (sin copias).
 */
const MAX_SIDE = 16383

self.onmessage = async ({ data: job }) => {
  let bitmap = null
  try {
    bitmap = await createImageBitmap(new Blob([job.bytes], { type: job.type }))
    const scale = Math.min(1, MAX_SIDE / bitmap.width, MAX_SIDE / bitmap.height, job.maxWidth ? job.maxWidth / bitmap.width : 1)
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d', { alpha: job.type !== 'image/jpeg' })
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, w, h)
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: job.quality })
    if (blob.type !== 'image/webp') throw new Error('Este equipo no pudo codificar WebP.')
    const out = await blob.arrayBuffer()
    canvas.width = canvas.height = 0
    self.postMessage({ id: job.id, ok: true, bytes: out, width: w, height: h, resized: scale < 1, srcWidth: bitmap.width, srcHeight: bitmap.height }, [out])
  } catch (err) {
    self.postMessage({ id: job.id, ok: false, error: String(err?.message || err) })
  } finally {
    bitmap?.close()
  }
}
