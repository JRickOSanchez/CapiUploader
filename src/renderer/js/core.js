'use strict'

/* =========================================================
   Utilidades
   ========================================================= */
const $ = (sel) => document.querySelector(sel)
const $$ = (sel) => Array.from(document.querySelectorAll(sel))
const naturalCompare = new Intl.Collator('es', { numeric: true, sensitivity: 'base' }).compare
const MAX_BYTES = 40 * 1024 * 1024
const MAX_PAGES = 500
const TYPE_LABEL = { manga: 'Manga', manhwa: 'Manhwa', manhua: 'Manhua', novel: 'Novela', comic: 'Cómic' }

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue
    if (k === 'class') node.className = v
    else if (k === 'text') node.textContent = v
    else if (k === 'html') node.innerHTML = v
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v)
    else if (k === 'dataset') Object.assign(node.dataset, v)
    else if (k === 'style') node.style.cssText = v
    else node.setAttribute(k, v === true ? '' : v)
  }
  for (const c of children.flat()) if (c != null) node.append(c)
  return node
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 2 : 1)} MB`
}

function formatNumber(n) {
  return new Intl.NumberFormat('es').format(n)
}

function formatDate(d, withTime = true) {
  return new Intl.DateTimeFormat('es', withTime
    ? { dateStyle: 'medium', timeStyle: 'short' }
    : { dateStyle: 'medium' }).format(d)
}

function toLocalInput(date) {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`
}

function relativeFromNow(date) {
  const diff = date.getTime() - Date.now()
  const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' })
  const abs = Math.abs(diff)
  if (abs < 3600e3) return rtf.format(Math.round(diff / 60e3), 'minute')
  if (abs < 86400e3) return rtf.format(Math.round(diff / 3600e3), 'hour')
  return rtf.format(Math.round(diff / 86400e3), 'day')
}

const ICONS = {
  check: '<svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  spinner: '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-6.2-8.6"/></svg>',
  warn: '<svg viewBox="0 0 24 24"><path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>',
  info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  error: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m15 9-6 6m0-6 6 6"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5Z"/></svg>',
  starOn: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5Z"/></svg>',
  boxOff: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="4"/></svg>',
  boxOn: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="4" fill="currentColor"/><path d="m8.5 12.5 2.5 2.5 4.5-5.5" stroke="var(--accent)" stroke-width="2.6"/></svg>',
}

/** Llama a fn cuando pasan ms sin nuevas llamadas (búsquedas mientras se escribe). */
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) } }

/* =========================================================
   Toasts
   ========================================================= */
function toast(type, title, msg, ms = 5000) {
  const icon = { success: ICONS.check, error: ICONS.error, warn: ICONS.warn, info: ICONS.info }[type]
  const node = el('div', { class: `toast ${type}` },
    el('span', { html: icon }),
    el('div', {}, el('div', { class: 'toast-title', text: title }), msg ? el('div', { class: 'toast-msg', text: msg }) : null),
  )
  const box = $('#toasts')
  // Máximo 3 avisos a la vez para no tapar la lista: se va el más viejo.
  const shown = [...box.querySelectorAll('.toast:not(.out)')]
  shown.slice(0, Math.max(0, shown.length - 2)).forEach((t) => { t.classList.add('out'); setTimeout(() => t.remove(), 200) })
  box.append(node)
  const close = () => { node.classList.add('out'); setTimeout(() => node.remove(), 200) }
  node.addEventListener('click', close)
  setTimeout(close, ms)
}

/* =========================================================
   PSD: avance de la conversión y resumen
   ========================================================= */
let psdBusy = null
function initPsdProgress() {
  window.capi.files.onPsdProgress((p) => {
    if (p.finished) {
      if (psdBusy) { psdBusy.classList.add('out'); const n = psdBusy; setTimeout(() => n.remove(), 200); psdBusy = null }
      return
    }
    if (!psdBusy) {
      psdBusy = el('div', { class: 'toast info psd-busy' },
        el('span', { html: ICONS.spinner }),
        el('div', {}, el('div', { class: 'toast-title', text: 'Convirtiendo archivos PSD…' }), el('div', { class: 'toast-msg' })),
      )
      $('#toasts').append(psdBusy)
    }
    psdBusy.querySelector('.toast-msg').textContent = `${formatNumber(p.done)} de ${formatNumber(p.total)}`
  })
}

/** Avisa de lo que pasó al convertir PSD: fuentes que faltan y archivos que no se pudieron leer. */
function reportPsd(report) {
  if (!report) return
  if (report.failed.length) {
    toast('error', `No se pudieron convertir ${report.failed.length} PSD`, `${report.failed.slice(0, 3).join(', ')}${report.failed.length > 3 ? '…' : ''}. Puede que estén dañados o se hayan guardado con otra versión del formato.`, 9000)
  }
  if (report.missingFonts.length) {
    const fonts = report.missingFonts.slice(0, 4).join(', ') + (report.missingFonts.length > 4 ? '…' : '')
    const kept = report.keptText.length
    const subst = report.substituted
    toast('warn', `Faltan fuentes en este equipo: ${fonts}`,
      (kept ? `${kept === 1 ? '1 página usa' : `${kept} páginas usan`} el texto tal como lo guardó Photoshop. ` : '')
      + (subst ? `${subst === 1 ? '1 página se dibujó' : `${subst} páginas se dibujaron`} con una fuente parecida: revísalas. ` : '')
      + 'Para usar las fuentes originales, instálalas y vuelve a agregar los archivos.', 12000)
  }
}

/* =========================================================
   Estado
   ========================================================= */
/**
 * Qué ventana es esta: la principal o la de «Importar de web» (la misma interfaz abierta con
 * ?ventana=importar, que solo muestra esa pantalla).
 */
const WINDOW_MODE = new URLSearchParams(location.search).get('ventana') === 'importar' ? 'import' : 'main'
const isImportWindow = WINDOW_MODE === 'import'

const state = {
  platform: 'capibara', // 'capibara' | 'crimson' | 'mangation' (ver platforms.js)
  sessions: {}, // sesiones de Crimson y Mangation: { loggedIn, user, expiresAt }
  platformInfo: null, // opciones de sus formularios (tipos, estados, géneros…)
  hasKey: false, // hay con qué subir a la plataforma activa (API key o sesión)
  profiles: [], // scans registrados (sin claves)
  activeScanId: null,
  scanGen: 0, // cambia con cada cambio de scan para descartar respuestas viejas
  me: null,
  chaptersByWork: new Map(), // workId → capítulos (también para «Varios capítulos»)
  works: [],
  worksLoading: false,
  selectedWork: null,
  chapters: [],
  chaptersLoading: false,
  langFilter: '',
  files: [], // { id, path, name, size, type, url, status }
  autoNumber: true,
  autoVolume: true,
  uploading: false,
  attempted: false,
  lastResult: null,
  mode: 'single', // 'single' | 'batch' (ver batch.js)
  view: 'upload', // 'upload' | 'import' | 'download' (ver views.js)
}
let fileSeq = 0

/* =========================================================
   Tema
   ========================================================= */
const theme = {
  choice: localStorage.getItem('theme') || 'system',
  systemDark: false,
  resolved() {
    return this.choice === 'system' ? (this.systemDark ? 'dark' : 'light') : this.choice
  },
  /** silent: el cambio vino de otra ventana; se aplica sin volver a avisar al proceso principal. */
  apply(animate = false, { silent = false } = {}) {
    const resolved = this.resolved()
    if (animate) {
      document.body.classList.add('theme-anim')
      setTimeout(() => document.body.classList.remove('theme-anim'), 300)
    }
    document.documentElement.dataset.theme = resolved
    $$('#themeSwitch button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.themeChoice === this.choice)))
    if (!silent) window.capi.settings.setTheme(this.choice, resolved)
  },
}

async function initTheme() {
  const r = await window.capi.system.prefersDark()
  theme.systemDark = Boolean(r.ok && r.data)
  theme.apply()
  window.capi.system.onThemeChanged((dark) => {
    theme.systemDark = dark
    if (theme.choice === 'system') theme.apply(true)
  })
  // Elegido en la otra ventana de la app.
  window.capi.settings.onThemeChanged(({ theme: choice }) => {
    if (!choice || choice === theme.choice) return
    theme.choice = choice
    theme.apply(true, { silent: true })
  })
  $$('#themeSwitch button').forEach((b) => b.addEventListener('click', () => {
    theme.choice = b.dataset.themeChoice
    localStorage.setItem('theme', theme.choice)
    theme.apply(true)
  }))
}

/* =========================================================
   Textos
   ========================================================= */
const UNIT_TEXT = {
  minutes: ['minuto', 'minutos'], hours: ['hora', 'horas'], days: ['día', 'días'], weeks: ['semana', 'semanas'],
}
/** «1 día», «3 días», «cada día» en vez de «cada 1 días». */
const amount = (n, unit) => `${n} ${UNIT_TEXT[unit][n === 1 ? 0 : 1]}`
const every = (n, unit) => (n === 1 ? `cada ${UNIT_TEXT[unit][0]}` : `cada ${amount(n, unit)}`)
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

/* =========================================================
   Errores de la API
   ========================================================= */
function handleApiError(error, title) {
  if (/^(crimson|mangation)\.session_expired$/.test(error.code || '')) return onSessionExpired(error)
  if (error.code === 'api.key_missing' || error.code === 'api.key_invalid') {
    toast('error', `${activeProfile()?.name || 'Scan'}: API key no válida`, error.message, 8000)
    state.me = null
    window.capi.profiles.list().then((r) => {
      if (r.ok) applyProfiles(r.data)
      renderScanChip()
      openKeyModal(true)
    })
    return
  }
  toast('error', title, withTrace(error), 8000)
}

/** Mensaje con el código de rastreo de Capibara, para mandarlo a soporte si el error no queda claro. */
const withTrace = (error) => (error.traceId ? `${error.message} (código ${error.traceId})` : error.message)

/* =========================================================
   Preguntas (modal con botones, en cola)
   ========================================================= */

let askChain = Promise.resolve()

/**
 * Muestra una pregunta y resuelve con el `value` del botón elegido.
 * Escape o un clic fuera eligen el botón marcado con `cancel`. Las preguntas se encolan.
 * Con `input` ({ label, value, type }) muestra un campo y resuelve con { value, input }; Enter
 * en el campo elige el botón principal.
 */
function ask({ kind = 'warn', title, text = '', list = [], more = 0, buttons, input = null }) {
  const run = () => new Promise((resolve) => {
    const modal = $('#askModal')
    const cancel = buttons.find((b) => b.cancel) || buttons[0]
    $('#askIcon').innerHTML = kind === 'info' ? ICONS.info : ICONS.warn
    $('#askIcon').className = `modal-icon ${kind}`
    $('#askTitle').textContent = title
    $('#askText').textContent = text
    const ul = $('#askList')
    ul.innerHTML = ''
    list.forEach((line) => ul.append(el('li', { text: line })))
    if (more > 0) ul.append(el('li', { class: 'more', text: `…y ${more} más` }))
    ul.hidden = !list.length
    const field = $('#askInput')
    $('#askInputWrap').hidden = !input
    if (input) {
      $('#askInputLabel').textContent = input.label || ''
      field.type = input.type || 'text'
      field.value = input.value ?? ''
    }
    const actions = $('#askActions')
    actions.innerHTML = ''
    const done = (value) => {
      modal.hidden = true
      document.removeEventListener('keydown', onKey, true)
      modal.removeEventListener('mousedown', onBackdrop)
      field.onkeydown = null
      resolve(input ? { value, input: field.value.trim() } : value)
    }
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(cancel.value) } }
    const onBackdrop = (e) => { if (e.target === modal) done(cancel.value) }
    buttons.forEach((b, i) => {
      if (i === 1 && buttons.length > 2) actions.append(el('span', { class: 'spacer' }))
      actions.append(el('button', { type: 'button', class: `btn ${b.kind || 'secondary'}`, onclick: () => done(b.value) }, b.label))
    })
    if (buttons.length <= 2) actions.prepend(el('span', { class: 'spacer' }))
    document.addEventListener('keydown', onKey, true)
    modal.addEventListener('mousedown', onBackdrop)
    modal.hidden = false
    // El foco va al botón marcado con focus, si no a la opción recomendada y si no a la de cancelar
    // (nunca a una peligrosa).
    const target = buttons.find((b) => b.focus) || buttons.find((b) => b.kind === 'primary') || cancel
    if (input) {
      const primary = buttons.find((b) => b.kind === 'primary')
      field.onkeydown = (e) => { if (e.key === 'Enter' && primary) { e.preventDefault(); done(primary.value) } }
      field.focus()
      field.select()
    } else {
      ;[...actions.querySelectorAll('button')][buttons.indexOf(target)]?.focus()
    }
  })
  const p = askChain.then(run)
  askChain = p.catch(() => {})
  return p
}

/* =========================================================
   Eventos entre pantallas
   Cada sección se suscribe en su init: así app no tiene que conocerlas.
   scanChanged · worksLoaded · workSelected(work, changed) · viewShown(view)
   ========================================================= */
const hooks = new Map()
function on(event, fn) {
  if (!hooks.has(event)) hooks.set(event, [])
  hooks.get(event).push(fn)
}
function emit(event, ...args) {
  for (const fn of hooks.get(event) || []) fn(...args)
}
