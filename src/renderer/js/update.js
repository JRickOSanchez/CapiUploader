'use strict'

/* =========================================================
   Actualizaciones: botón en la barra superior cuando hay una versión nueva.
   Las tres (Setup, portable y .zip) se bajan solas y se instalan al cerrar
   (o al pulsar «Reiniciar»), en el mismo lugar donde está la app. Si no se
   puede, queda la descarga del release a mano.
   ========================================================= */
const upd = { state: null, toldReady: false, toldFailure: false }

// Cuando hay que bajarla a mano: qué hacer según cómo se usa la app.
const UPD_HOW = {
  installed: 'Descarga el instalador: se instala encima de esta y conserva tus scans y ajustes.',
  portable: 'Descarga el archivo nuevo y úsalo en lugar de este. Tus scans y ajustes se conservan.',
  zip: 'Descarga el .zip y descomprímelo encima de esta carpeta (con la app cerrada). Tus scans y ajustes se conservan.',
}
// Por qué no se pudo actualizar sola.
const UPD_WHY = {
  no_write: 'La carpeta donde está la app no deja escribir (por ejemplo, Archivos de programa), así que no se puede actualizar sola.',
  no_digest: 'El release no trae los datos para comprobar la descarga, así que no se instala sola.',
  error: 'No se pudo preparar sola.',
  failed: 'La última vez no se pudo instalar sola.',
}
// Qué se cambia al actualizar, según cómo se usa la app.
const UPD_WHERE = {
  installed: 'Se instala encima de esta.',
  portable: 'Se cambia el archivo portable por el nuevo, en la misma carpeta.',
  zip: 'Se cambian los archivos de la carpeta donde descomprimiste la app.',
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
      ? s.phase === 'unpack' ? `Preparando la ${s.version}…` : `Bajando la ${s.version}${s.percent ? ` · ${s.percent}%` : '…'}`
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
        UPD_WHERE[s.kind] || UPD_WHERE.installed,
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
      s.manual ? UPD_WHY[s.manualReason] || (s.kind === 'installed' ? 'No se pudo bajar sola.' : '') : '',
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
  if (s.lastFailure && !upd.toldFailure) {
    upd.toldFailure = true
    toast('warn', `No se pudo actualizar sola a la ${s.lastFailure.version}`, 'Se dejó la versión que tenías, sin tocar tus scans ni ajustes. Descárgala desde el botón de arriba.', 12000)
  }
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
