'use strict'

/* =========================================================
   Secciones de la app. La ventana principal tiene Subir y
   Descargar; «Importar de web» se abre en su propia ventana
   (la misma interfaz con ?ventana=importar).
   Cada sección tiene su panel y su barra inferior ([data-pane]).
   Una subida o descarga sigue en marcha aunque se cambie de sección.
   ========================================================= */
const VIEWS = isImportWindow ? ['import'] : ['upload', 'download']

function setView(view) {
  if (!VIEWS.includes(view)) view = VIEWS[0]
  // Descargar es solo para Capibara.
  if (view === 'download' && !hasCap('download')) view = 'upload'
  state.view = view
  // La ventana de importar no guarda nada: comparte el almacenamiento con la principal.
  if (!isImportWindow) localStorage.setItem('view', view)
  document.body.dataset.view = view
  $$('[data-pane]').forEach((n) => { n.hidden = n.dataset.pane !== view })
  $$('#viewTabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === view)))
  emit('viewShown', view)
}

/** Marca con un punto la pestaña que tiene trabajo en curso mientras se mira otra. */
function setViewBusy(view, busy) {
  const b = $(`#viewTabs [data-view="${view}"]`)
  if (!b) return
  b.querySelector('.busy-dot')?.remove()
  if (busy) b.append(el('span', { class: 'busy-dot', title: 'En curso' }))
}

function initViews() {
  $$('#viewTabs button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)))
  setView(localStorage.getItem('view') || 'upload')
}
