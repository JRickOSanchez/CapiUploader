'use strict'

/* =========================================================
   Arranque: se carga al final, cuando ya están definidas todas las
   secciones, y las inicia en el mismo orden de siempre.
   La ventana «Importar de web» usa la misma interfaz con
   ?ventana=importar y solo inicia lo que necesita esa pantalla.
   ========================================================= */

async function boot() {
  document.body.dataset.window = WINDOW_MODE
  initDiagnostics()
  initSync()
  if (isImportWindow) return bootImportWindow()

  initPsdProgress()
  // El tema se pide al proceso principal; mientras tanto se preparan las secciones.
  const themeReady = initTheme()
  const platformsReady = initPlatforms()
  initBatch()
  initDownload()
  initNewWork()
  initAltWork()
  initUpdate()
  initSettings()
  await platformsReady
  initAlso() // necesita saber la plataforma activa
  initViews()
  await themeReady
  initKeyModal()
  initCombo()
  initDropzone()
  initLightbox()
  initForm()
  initUpload()
  renderThumbs()
  renderWorkTrigger()

  const res = await window.capi.profiles.list()
  if (res.ok) applyProfiles(res.data)
  renderScanChip()
  validate()
  if (!state.hasKey) openKeyModal(true)
  else loadWorks()
}

/** Ventana «Importar de web»: su pantalla, el selector de obra, la ficha nueva y las preguntas. */
async function bootImportWindow() {
  document.title = 'Importar de web · CapiUploader'
  await initTheme()
  await initPlatforms()
  initKeyModal()
  initWorkPicker()
  initNewWork()
  initAltWork()
  initImport()
  initViews()
  const res = await window.capi.profiles.list()
  if (res.ok) applyProfiles(res.data)
  renderScanChip()
  if (state.hasKey) loadWorks()
  else if (isCapibara()) toast('warn', 'Falta la API key de tu scan', 'Agrégala en la ventana principal («Mis scans») y vuelve a abrir esta ventana.', 10000)
  else toast('warn', `Falta iniciar sesión en ${plat().full}`, 'Inicia sesión en la ventana principal y las obras aparecerán aquí.', 10000)
}

/** Cambios hechos en la otra ventana de la app: scan activo y obras nuevas. */
function initSync() {
  window.capi.profiles.onChanged((data) => {
    const before = state.activeScanId
    applyProfiles(data)
    renderScanChip()
    // La ventana que hizo el cambio ya recargó todo; la otra lo hace aquí.
    if (data.activeId !== before && isCapibara()) onScanChanged()
  })
  window.capi.works.onChanged((w) => {
    if ((w?.platform || 'capibara') !== state.platform) return
    // Si la creó esta ventana, ya la recargó.
    if (Date.now() - Math.max(nw.createdAt, aw.createdAt) > 4000) loadWorks()
  })
}

boot()
