'use strict'

/* =========================================================
   Ajustes de la app (botón de la barra superior).
   La aceleración gráfica se aplica al reiniciar: Electron solo
   deja cambiarla al arrancar.
   ========================================================= */
const prefs = { gpu: true, gpuActive: true }

function renderPrefs() {
  $('#prefGpu').checked = prefs.gpu
  const pending = prefs.gpu !== prefs.gpuActive
  $('#prefGpuState').className = `hint${pending ? ' warn' : ''}`
  $('#prefGpuState').textContent = pending
    ? `Se ${prefs.gpu ? 'activará' : 'desactivará'} al reiniciar la app.`
    : `Ahora está ${prefs.gpuActive ? 'activada' : 'desactivada'}.`
  $('#prefsRelaunch').hidden = !pending
}

async function openPrefs() {
  const res = await window.capi.settings.get()
  if (!res.ok) return toast('error', 'No se pudieron leer los ajustes', res.error.message)
  prefs.gpu = res.data.hardwareAcceleration
  prefs.gpuActive = res.data.gpu
  renderPrefs()
  $('#prefsModal').hidden = false
}

const closePrefs = () => { $('#prefsModal').hidden = true }

async function setGpu(on) {
  const res = await window.capi.settings.setHardwareAcceleration(on)
  if (!res.ok) return toast('error', 'No se pudo guardar el ajuste', res.error.message)
  prefs.gpu = on
  renderPrefs()
}

async function relaunchApp() {
  const res = await window.capi.settings.relaunch()
  if (!res.ok) toast('warn', 'Todavía no se puede reiniciar', res.error.message, 7000)
}

function initSettings() {
  $('#prefsBtn').addEventListener('click', openPrefs)
  $('#prefsClose').addEventListener('click', closePrefs)
  $('#prefsDone').addEventListener('click', closePrefs)
  $('#prefGpu').addEventListener('change', (e) => setGpu(e.target.checked))
  $('#prefsRelaunch').addEventListener('click', relaunchApp)
  $('#prefsNews').addEventListener('click', () => { closePrefs(); window.capi.settings.openWhatsNew() })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#prefsModal').hidden) closePrefs() })
}
