'use strict'

/* =========================================================
   Registro de diagnóstico (Ajustes → Diagnóstico).
   El registro vive en el proceso principal; aquí solo se
   muestra, se copia para soporte y se anotan los errores de
   la interfaz que nadie atrapó.
   ========================================================= */
const diag = { level: 'info' }
const DIAG_LEVEL = { info: 'Info', warn: 'Aviso', error: 'Error' }

function diagRow(e) {
  const time = new Date(e.at).toLocaleString('es', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return el('li', { class: `diag-row ${e.level}` },
    el('span', { class: 'diag-time', text: time }),
    el('span', { class: 'diag-level', text: DIAG_LEVEL[e.level] || e.level }),
    el('span', { class: 'diag-area', text: e.area }),
    el('span', { class: 'diag-msg', text: e.message }),
    e.detail ? el('pre', { class: 'diag-detail', text: e.detail }) : null)
}

async function renderDiag() {
  const res = await window.capi.diagnostics.list(diag.level)
  if (!res.ok) return toast('error', 'No se pudo leer el registro', res.error.message)
  const { entries, folder } = res.data
  const list = $('#diagList')
  list.innerHTML = ''
  // Lo más nuevo arriba: es lo que se busca al revisar un error.
  for (let i = entries.length - 1; i >= 0; i--) list.append(diagRow(entries[i]))
  if (!entries.length) list.append(el('li', { class: 'diag-empty', text: diag.level === 'warn' ? 'Sin avisos ni errores. Todo en orden.' : 'Todavía no hay nada registrado.' }))
  $('#diagCount').textContent = plural(entries.length, 'entrada', 'entradas')
  $('#diagFolder').disabled = !folder
  $$('#diagLevel button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.level === diag.level)))
}

async function openDiag() {
  $('#prefsModal').hidden = true
  $('#diagModal').hidden = false
  await renderDiag()
}

const closeDiag = () => { $('#diagModal').hidden = true }

async function copyDiag() {
  const res = await window.capi.diagnostics.copy(diag.level)
  if (res.ok) toast('success', 'Registro copiado', 'Pégalo en el mensaje a soporte. No incluye claves ni contraseñas.')
  else toast('error', 'No se pudo copiar', res.error.message)
}

async function clearDiag() {
  const choice = await ask({
    kind: 'warn', title: '¿Vaciar el registro?', text: 'Se borran las entradas que muestra esta ventana. El archivo en disco se conserva.',
    buttons: [{ label: 'Cancelar', value: false, cancel: true }, { label: 'Vaciar', value: true, kind: 'danger-solid' }],
  })
  if (!choice) return
  await window.capi.diagnostics.clear()
  renderDiag()
}

/** Errores de la interfaz que nadie atrapó: al registro (el proceso principal limita cuántos por minuto). */
function initDiagnostics() {
  const report = (message, stack) => window.capi.diagnostics.reportError({ message, stack }).catch(() => {})
  window.addEventListener('error', (e) => report(e.message, e.error?.stack))
  window.addEventListener('unhandledrejection', (e) => report(e.reason?.message || String(e.reason), e.reason?.stack))

  $('#prefsDiag').addEventListener('click', openDiag)
  $('#diagClose').addEventListener('click', closeDiag)
  $('#diagCopy').addEventListener('click', copyDiag)
  $('#diagClear').addEventListener('click', clearDiag)
  $('#diagFolder').addEventListener('click', async () => {
    const res = await window.capi.diagnostics.openFolder()
    if (!res.ok) toast('error', 'No se pudo abrir la carpeta', res.error.message)
  })
  $$('#diagLevel button').forEach((b) => b.addEventListener('click', () => { diag.level = b.dataset.level; renderDiag() }))
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#diagModal').hidden) closeDiag() })
}
