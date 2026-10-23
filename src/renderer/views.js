'use strict'

/* =========================================================
   Secciones de la app: Subir, Importar de web y Descargar.
   Cada una tiene su panel y su barra inferior ([data-pane]).
   Una subida o descarga sigue en marcha aunque se cambie de sección.
   ========================================================= */
const VIEWS = ['upload', 'import', 'download']
const viewHooks = { download: () => typeof dlOnShow === 'function' && dlOnShow(), import: () => typeof imOnShow === 'function' && imOnShow() }

function setView(view) {
  if (!VIEWS.includes(view) || !$(`#viewTabs [data-view="${view}"]`)) view = 'upload'
  state.view = view
  localStorage.setItem('view', view)
  document.body.dataset.view = view
  $$('[data-pane]').forEach((n) => { n.hidden = n.dataset.pane !== view })
  $$('#viewTabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === view)))
  viewHooks[view]?.()
}

/** Marca con un punto la pestaña que tiene trabajo en curso mientras se mira otra. */
function setViewBusy(view, busy) {
  const b = $(`#viewTabs [data-view="${view}"]`)
  if (!b) return
  b.querySelector('.busy-dot')?.remove()
  if (busy) b.append(el('span', { class: 'busy-dot', title: 'En curso' }))
}

$$('#viewTabs button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)))
setView(localStorage.getItem('view') || 'upload')
