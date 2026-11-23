/**
 * Ventana oculta del convertidor WebP: reparte los trabajos que manda el proceso principal entre
 * unos pocos hilos (Web Workers) y devuelve el resultado. Sin acceso a archivos ni a la red.
 */
const workers = []
const idle = []
const queue = []

function spawn() {
  const w = new Worker('js/converter-worker.js')
  w.onmessage = ({ data }) => {
    window.converter.done(data.id, data.ok ? { ok: true, bytes: new Uint8Array(data.bytes), width: data.width, height: data.height, resized: data.resized, srcWidth: data.srcWidth, srcHeight: data.srcHeight } : { ok: false, error: data.error })
    next(w)
  }
  w.onerror = (e) => { e.preventDefault() }
  workers.push(w)
  return w
}

function next(w) {
  const job = queue.shift()
  if (!job) { idle.push(w); return }
  const buf = job.bytes.buffer.byteLength === job.bytes.byteLength ? job.bytes.buffer : job.bytes.slice().buffer
  w.postMessage({ ...job, bytes: buf }, [buf])
}

window.converter.onJob((job) => {
  queue.push(job)
  const w = idle.pop() || (workers.length < job.threads ? spawn() : null)
  if (w) next(w)
})
