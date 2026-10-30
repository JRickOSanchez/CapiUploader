// Puente de la ventana oculta del convertidor WebP: recibe trabajos y devuelve los bytes convertidos.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('converter', {
  onJob: (cb) => ipcRenderer.on('webp:job', (_e, job) => cb(job)),
  done: (id, result) => ipcRenderer.send('webp:done', id, result),
})
