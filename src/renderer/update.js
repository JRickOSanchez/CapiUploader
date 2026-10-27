'use strict'

/* =========================================================
   Actualizaciones: botón en la barra superior cuando hay una versión nueva.
   La instalada se baja sola y se instala al cerrar (o al pulsar «Reiniciar»);
   la portable y la del .zip abren la descarga del release.
   ========================================================= */
const upd = { state: null, toldReady: false }

const UPD_HOW = {
  installed: 'Se instala encima de esta y conserva tus scans y ajustes.',
  portable: 'Usas la versión portable: descarga el archivo nuevo y úsalo en lugar de este. Tus scans y ajustes se conservan.',
  zip: 'Usas la versión del .zip: descárgalo y descomprímelo encima de esta carpeta (con la app cerrada). Tus scans y ajustes se conservan.',
}

/** ¿Hay algo en marcha que un reinicio cortaría? */
function updBusyText() {
  const busy = [
    state.uploading ? 'una subida' : '',
    typeof dl !== 'undefined' && dl.running ? 'una descarga' : '',
    typeof im !== 'undefined' && im.running ? 'una importación' : '',
  ].filter(Boolean)
  return busy.length ? `Ojo: hay ${busy.join(' y ')} en curso; si reinicias ahora se cortará.` : ''
}

function renderUpdateChip() {
  const s = upd.state
  const chip = $('#updateChip')
  const show = s && ['available', 'downloading', 'ready'].includes(s.status)
  chip.hidden = !show
  if (!show) return
  chip.classList.toggle('ready', s.status === 'ready')
  $('#updateChipText').textContent = s.status === 'ready'
    ? `Reiniciar para actualizar a ${s.version}`
    : s.status === 'downloading'
      ? `Bajando la ${s.version}${s.percent ? ` · ${s.percent}%` : '…'}`
      : `Ya salió la ${s.version}`
  chip.title = s.name || `CapiUploader ${s.version}`
}

async function openUpdateDialog() {
  const s = upd.state
  if (!s) return
  const news = { value: 'news', label: 'Ver novedades' }
  if (s.status === 'ready') {
    const choice = await ask({
      kind: 'info',
      title: `CapiUploader ${s.version} está lista`,
      text: [
        'Se instala sola cuando cierres el programa. Si reinicias ahora, se cierra unos segundos y vuelve a abrirse con tus scans y ajustes.',
        updBusyText(),
      ].filter(Boolean).join(' '),
      buttons: [{ value: 'later', label: 'Más tarde', cancel: true }, news, { value: 'install', label: 'Reiniciar y actualizar', kind: 'primary' }],
    })
    if (choice === 'install') window.capi.update.install()
    if (choice === 'news') window.capi.system.openExternal(s.url)
    return
  }
  if (s.status === 'downloading') {
    const choice = await ask({
      kind: 'info',
      title: `Bajando CapiUploader ${s.version}`,
      text: 'Se baja en segundo plano; puedes seguir usando el programa. Te avisamos cuando esté lista para instalar.',
      buttons: [{ value: 'ok', label: 'Entendido', cancel: true }, news],
    })
    if (choice === 'news') window.capi.system.openExternal(s.url)
    return
  }
  const choice = await ask({
    kind: 'info',
    title: `Ya salió CapiUploader ${s.version}`,
    text: [
      s.name && s.name !== `v${s.version}` ? `«${s.name}».` : '',
      `Tienes la ${s.currentVersion}.`,
      s.kind === 'installed' ? 'No se pudo bajar sola: descarga el instalador.' : '',
      UPD_HOW[s.kind] || UPD_HOW.installed,
    ].filter(Boolean).join(' '),
    buttons: [{ value: 'later', label: 'Más tarde', cancel: true }, news, { value: 'get', label: 'Descargar', kind: 'primary' }],
  })
  if (choice === 'get') window.capi.system.openExternal(s.download || s.url)
  if (choice === 'news') window.capi.system.openExternal(s.url)
}

function onUpdateState(s) {
  const was = upd.state?.status
  upd.state = s
  renderUpdateChip()
  if (s.status === 'ready' && !upd.toldReady) {
    upd.toldReady = true
    toast('success', `CapiUploader ${s.version} lista para instalar`, 'Se instala al cerrar el programa, o pulsa «Reiniciar para actualizar» arriba.', 10000)
  } else if (s.status === 'available' && was !== 'available' && s.manual) {
    toast('info', `Ya salió CapiUploader ${s.version}`, 'Pulsa el botón de arriba para descargarla.', 8000)
  }
}

function initUpdate() {
  $('#updateChip').addEventListener('click', openUpdateDialog)
  window.capi.update.onState(onUpdateState)
  window.capi.update.state().then((r) => { if (r.ok) onUpdateState(r.data) })
}

initUpdate()
