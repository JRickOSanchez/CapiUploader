// Puente de la ventana «Novedades» (y de la guía de la versión de prueba): solo puede pedir sus datos,
// abrir enlaces https y cerrarse.
const { contextBridge, ipcRenderer } = require('electron')

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args)

contextBridge.exposeInMainWorld('novedades', {
  data: (mode) => invoke('whatsnew:data', mode),
  openExternal: (url) => invoke('shell:open', url),
  close: () => invoke('whatsnew:close'),
})
