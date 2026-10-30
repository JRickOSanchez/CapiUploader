// Puente de la ventana «Novedades»: solo puede pedir sus datos, abrir enlaces https y cerrarse.
const { contextBridge, ipcRenderer } = require('electron')

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args)

contextBridge.exposeInMainWorld('novedades', {
  data: () => invoke('whatsnew:data'),
  openExternal: (url) => invoke('shell:open', url),
  close: () => invoke('whatsnew:close'),
})
