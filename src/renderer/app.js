'use strict'

/* =========================================================
   Utilidades
   ========================================================= */
const $ = (sel) => document.querySelector(sel)
const $$ = (sel) => Array.from(document.querySelectorAll(sel))
const naturalCompare = new Intl.Collator('es', { numeric: true, sensitivity: 'base' }).compare
const MAX_BYTES = 40 * 1024 * 1024
const MAX_PAGES = 500
const LANG_LABEL = { es: 'Español', en: 'English', pt: 'Português' }
const STATUS_LABEL = { ongoing: 'En emisión', completed: 'Finalizada', hiatus: 'En pausa', cancelled: 'Cancelada' }
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

/* =========================================================
   Toasts
   ========================================================= */
function toast(type, title, msg, ms = 5000) {
  const icon = { success: ICONS.check, error: ICONS.error, warn: ICONS.warn, info: ICONS.info }[type]
  const node = el('div', { class: `toast ${type}` },
    el('span', { html: icon }),
    el('div', {}, el('div', { class: 'toast-title', text: title }), msg ? el('div', { class: 'toast-msg', text: msg }) : null),
  )
  $('#toasts').append(node)
  const close = () => { node.classList.add('out'); setTimeout(() => node.remove(), 200) }
  node.addEventListener('click', close)
  setTimeout(close, ms)
}

/* =========================================================
   Estado
   ========================================================= */
const state = {
  hasKey: false,
  me: null,
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
  apply(animate = false) {
    const resolved = this.resolved()
    if (animate) {
      document.body.classList.add('theme-anim')
      setTimeout(() => document.body.classList.remove('theme-anim'), 300)
    }
    document.documentElement.dataset.theme = resolved
    $$('#themeSwitch button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.themeChoice === this.choice)))
    window.capi.settings.setTheme(this.choice, resolved)
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
  $$('#themeSwitch button').forEach((b) => b.addEventListener('click', () => {
    theme.choice = b.dataset.themeChoice
    localStorage.setItem('theme', theme.choice)
    theme.apply(true)
  }))
}

/* =========================================================
   API key
   ========================================================= */
function renderScanChip() {
  const dot = $('#scanDot')
  dot.className = 'dot'
  if (!state.hasKey) {
    $('#scanName').textContent = 'Configurar API key'
    dot.classList.add('err')
  } else if (!state.me) {
    $('#scanName').textContent = 'Conectando…'
  } else {
    $('#scanName').textContent = state.me.scan.name
    dot.classList.add(state.me.key.scopes.includes('chapters:write') ? 'ok' : 'warn')
  }
}

function openKeyModal() {
  const modal = $('#keyModal')
  $('#keyInput').value = ''
  $('#keyInput').type = 'password'
  $('#keyError').textContent = ''
  $('#keyRemove').hidden = !state.hasKey
  $('#keyCancel').hidden = !state.hasKey
  const cur = $('#keyCurrent')
  if (state.me) {
    const { scan, key, usage, limits } = state.me
    cur.innerHTML = ''
    cur.append(
      el('dt', { text: 'Scan' }), el('dd', { text: scan.name }),
      el('dt', { text: 'Clave' }), el('dd', { text: `${key.name} (${key.prefix}…)` }),
      el('dt', { text: 'Permisos' }), el('dd', {}, key.scopes.map((s) => el('span', { class: `badge ${s === 'chapters:write' ? 'success' : ''}`, text: s }))),
      el('dt', { text: 'Uso de hoy' }), el('dd', { text: `${formatNumber(usage.today)} / ${formatNumber(limits.perDay)} peticiones` }),
      el('dt', { text: 'Vence' }), el('dd', { text: key.expiresAt ? formatDate(new Date(key.expiresAt)) : 'Nunca' }),
    )
    cur.hidden = false
    $('#keyInput').placeholder = 'Pega una clave nueva para reemplazarla'
  } else {
    cur.hidden = true
    $('#keyInput').placeholder = 'capi_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
  }
  modal.hidden = false
  setTimeout(() => $('#keyInput').focus(), 50)
}

function closeKeyModal() {
  if (!state.hasKey) return
  $('#keyModal').hidden = true
}

async function saveKey() {
  const btn = $('#keySave')
  const value = $('#keyInput').value.trim()
  if (!value) { $('#keyError').textContent = 'Pega tu API key.'; return }
  btn.disabled = true
  btn.textContent = 'Verificando…'
  const res = await window.capi.settings.setKey(value)
  btn.disabled = false
  btn.textContent = 'Verificar y guardar'
  if (!res.ok) {
    $('#keyError').textContent = res.error.message
    return
  }
  state.hasKey = true
  state.me = res.data
  renderScanChip()
  $('#keyModal').hidden = true
  toast('success', 'Clave guardada', `Conectado a ${res.data.scan.name}.`)
  if (!res.data.key.scopes.includes('chapters:write')) {
    toast('warn', 'Falta un permiso', 'Esta clave no tiene chapters:write: no podrá subir capítulos.', 9000)
  }
  loadWorks()
}

async function removeKey() {
  await window.capi.settings.clearKey()
  state.hasKey = false
  state.me = null
  state.works = []
  selectWork(null)
  renderScanChip()
  renderWorkList()
  openKeyModal()
}

function initKeyModal() {
  $('#settingsBtn').addEventListener('click', openKeyModal)
  $('#scanChip').addEventListener('click', openKeyModal)
  $('#keySave').addEventListener('click', saveKey)
  $('#keyCancel').addEventListener('click', closeKeyModal)
  $('#keyRemove').addEventListener('click', removeKey)
  $('#keyInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveKey() })
  $('#keyReveal').addEventListener('click', () => {
    const i = $('#keyInput')
    i.type = i.type === 'password' ? 'text' : 'password'
  })
  $('#keyModal').addEventListener('mousedown', (e) => { if (e.target.id === 'keyModal') closeKeyModal() })
}

/* =========================================================
   Obras
   ========================================================= */
function coverImg(work, cls = 'cover') {
  return work.coverUrl
    ? el('img', { class: cls, src: work.coverUrl, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' })
    : el('div', { class: cls })
}

function workMeta(work) {
  const meta = el('div', { class: 'work-meta' },
    el('span', { class: 'tag', text: work.language }),
    el('span', { text: `${formatNumber(work.chapters)} caps.` }),
    el('span', { class: 'sep' }),
    el('span', { text: TYPE_LABEL[work.type] || work.type }),
  )
  if (work.inReview) meta.append(el('span', { class: 'tag review', text: 'En revisión' }))
  else if (!work.isPublic) meta.append(el('span', { class: 'tag private', text: 'Privada' }))
  return meta
}

async function loadWorks() {
  if (!state.hasKey) return
  state.worksLoading = true
  $('#reloadWorks').classList.add('spin')
  renderWorkTrigger()
  const [meRes, worksRes] = await Promise.all([window.capi.api.me(), window.capi.api.works()])
  state.worksLoading = false
  $('#reloadWorks').classList.remove('spin')

  if (meRes.ok) { state.me = meRes.data; renderScanChip() }
  if (!worksRes.ok) {
    renderWorkTrigger()
    handleApiError(worksRes.error, 'No se pudieron cargar las obras')
    return
  }
  state.works = worksRes.data.sort((a, b) =>
    (b.lastChapterAt || b.createdAt || '').localeCompare(a.lastChapterAt || a.createdAt || ''))

  const remembered = Number(localStorage.getItem('lastWorkId'))
  const keep = state.selectedWork && state.works.find((w) => w.id === state.selectedWork.id)
  const pick = keep || state.works.find((w) => w.id === remembered) || null
  if (pick) selectWork(pick, { refreshChapters: !keep })
  else renderWorkTrigger()
  renderWorkList()
}

function renderWorkTrigger() {
  const v = $('#workValue')
  v.innerHTML = ''
  const w = state.selectedWork
  if (w) {
    v.append(coverImg(w, 'cover lg'), el('div', { class: 'work-text' },
      el('span', { class: 'work-title', text: w.title, title: w.title }), workMeta(w)))
  } else if (state.worksLoading) {
    v.append(el('div', { class: 'cover lg skeleton' }), el('div', { class: 'work-text', style: 'flex:1' },
      el('div', { class: 'skeleton', style: 'height:12px;width:70%' }),
      el('div', { class: 'skeleton', style: 'height:10px;width:40%' })))
  } else {
    v.append(el('span', { class: 'placeholder', text: state.hasKey ? 'Selecciona una obra…' : 'Configura tu API key para ver tus obras' }))
  }
}

function filteredWorks() {
  const q = $('#workSearch').value.trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
  return state.works.filter((w) => {
    if (state.langFilter && w.language !== state.langFilter) return false
    if (!q) return true
    const hay = `${w.title} ${w.alternativeTitle || ''} ${w.slug}`.toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
    return hay.includes(q)
  })
}

let activeIndex = 0
function renderWorkList() {
  const list = $('#workList')
  list.innerHTML = ''
  const works = filteredWorks()
  activeIndex = Math.min(activeIndex, Math.max(0, works.length - 1))
  if (!works.length) {
    list.append(el('li', { class: 'empty', text: state.worksLoading ? 'Cargando…' : 'No hay obras que coincidan.' }))
    return
  }
  works.forEach((w, i) => {
    list.append(el('li', {
      role: 'option',
      'aria-selected': String(state.selectedWork?.id === w.id),
      class: i === activeIndex ? 'active' : '',
      dataset: { id: w.id },
      onmousemove: () => setActive(i),
      onclick: () => { selectWork(w); closeCombo() },
    }, coverImg(w), el('div', { class: 'work-text' },
      el('span', { class: 'work-title', text: w.title, title: w.title }), workMeta(w))))
  })
}

function setActive(i) {
  if (i === activeIndex) return
  const items = $$('#workList li[role="option"]')
  items[activeIndex]?.classList.remove('active')
  activeIndex = i
  items[i]?.classList.add('active')
}

function openCombo() {
  if (!state.works.length && !state.worksLoading) {
    if (!state.hasKey) openKeyModal()
    return
  }
  $('#workPop').hidden = false
  $('#workTrigger').setAttribute('aria-expanded', 'true')
  $('#workSearch').value = ''
  const idx = filteredWorks().findIndex((w) => w.id === state.selectedWork?.id)
  activeIndex = Math.max(0, idx)
  renderWorkList()
  $('#workSearch').focus()
  $$('#workList li')[activeIndex]?.scrollIntoView({ block: 'nearest' })
}

function closeCombo() {
  $('#workPop').hidden = true
  $('#workTrigger').setAttribute('aria-expanded', 'false')
}

function initCombo() {
  $('#workTrigger').addEventListener('click', () => ($('#workPop').hidden ? openCombo() : closeCombo()))
  $('#reloadWorks').addEventListener('click', () => loadWorks())
  $('#workSearch').addEventListener('input', () => { activeIndex = 0; renderWorkList() })
  $('#workSearch').addEventListener('keydown', (e) => {
    const works = filteredWorks()
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(works.length - 1, activeIndex + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(0, activeIndex - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (works[activeIndex]) { selectWork(works[activeIndex]); closeCombo() } }
    else if (e.key === 'Escape') { closeCombo(); $('#workTrigger').focus() }
    else return
    $$('#workList li')[activeIndex]?.scrollIntoView({ block: 'nearest' })
  })
  $$('#langChips .chip').forEach((c) => c.addEventListener('click', () => {
    state.langFilter = c.dataset.lang
    $$('#langChips .chip').forEach((x) => x.classList.toggle('active', x === c))
    activeIndex = 0
    renderWorkList()
    $('#workSearch').focus()
  }))
  document.addEventListener('mousedown', (e) => {
    if (!$('#workCombo').contains(e.target)) closeCombo()
  })
}

function selectWork(work, { refreshChapters = true } = {}) {
  const changed = state.selectedWork?.id !== work?.id
  state.selectedWork = work
  if (work) localStorage.setItem('lastWorkId', String(work.id))
  $('#workTrigger').classList.remove('invalid')
  renderWorkTrigger()
  if (changed) {
    state.autoNumber = true
    state.autoVolume = true
    state.chapters = []
  }
  if (work && (changed || refreshChapters)) loadChapters()
  renderWorkInfo()
  validate()
}

async function loadChapters() {
  const work = state.selectedWork
  if (!work) return
  state.chaptersLoading = true
  renderWorkInfo()
  const res = await window.capi.api.chapters(work.id)
  if (state.selectedWork?.id !== work.id) return // cambió mientras cargaba
  state.chaptersLoading = false
  if (!res.ok) {
    state.chapters = []
    handleApiError(res.error, 'No se pudieron cargar los capítulos')
  } else {
    state.chapters = res.data
  }
  applyChapterSuggestions()
  renderWorkInfo()
  validate()
}

function latestChapter() {
  return state.chapters.reduce((best, c) => (!best || c.number > best.number ? c : best), null)
}

function applyChapterSuggestions() {
  const last = latestChapter()
  if (state.autoNumber) {
    $('#chNumber').value = last ? String(Math.floor(last.number) + 1) : '1'
  }
  if (state.autoVolume) {
    $('#chVolume').value = last?.volumeNumber != null ? String(last.volumeNumber) : ''
  }
}

function renderWorkInfo() {
  const box = $('#workInfo')
  const w = state.selectedWork
  box.hidden = !w
  if (!w) return
  box.innerHTML = ''
  if (state.chaptersLoading) {
    for (let i = 0; i < 3; i++) box.append(el('div', { class: 'stat' }, el('div', { class: 'skeleton', style: 'height:10px;width:60%' }), el('div', { class: 'skeleton', style: 'height:14px;width:40%;margin-top:6px' })))
    return
  }
  const last = latestChapter()
  const scheduled = state.chapters.filter((c) => c.state === 'scheduled').length
  const early = state.chapters.filter((c) => c.state === 'early_access').length
  box.append(
    el('div', { class: 'stat' }, el('div', { class: 'stat-label', text: 'Último cap.' }),
      el('div', { class: 'stat-value', text: last ? `#${last.number}${last.volumeNumber != null ? ` · Vol. ${last.volumeNumber}` : ''}` : '—' })),
    el('div', { class: 'stat' }, el('div', { class: 'stat-label', text: 'Capítulos' }),
      el('div', { class: 'stat-value', text: formatNumber(state.chapters.length) })),
    el('div', { class: 'stat', title: `${scheduled} programados · ${early} anticipados` }, el('div', { class: 'stat-label', text: 'Pendientes' }),
      el('div', { class: 'stat-value', text: scheduled + early ? `${scheduled} prog. · ${early} ant.` : 'Ninguno' })),
  )
}

/* =========================================================
   Páginas
   ========================================================= */
async function addPaths(paths) {
  if (!paths.length) return
  const res = await window.capi.files.resolve(paths)
  if (!res.ok) return toast('error', 'No se pudieron leer los archivos', res.error.message)
  addResolved(res.data)
}

function addResolved({ files, skipped }) {
  const existing = new Set(state.files.map((f) => f.path))
  const fresh = files.filter((f) => !existing.has(f.path))
  const dupes = files.length - fresh.length
  const wasEmpty = state.files.length === 0
  const room = MAX_PAGES - state.files.length
  const accepted = fresh.slice(0, Math.max(0, room))
  state.files.push(...accepted.map((f) => ({ ...f, id: ++fileSeq, status: null })))
  if (wasEmpty) state.files.sort((a, b) => naturalCompare(a.name, b.name))

  if (skipped.length) toast('warn', `${skipped.length} archivo(s) ignorado(s)`, `Solo se aceptan JPG, PNG, WEBP, GIF y AVIF. ${skipped.slice(0, 3).join(', ')}${skipped.length > 3 ? '…' : ''}`)
  if (dupes) toast('info', `${dupes} imagen(es) ya estaban en la lista`)
  if (fresh.length > accepted.length) toast('warn', 'Límite de páginas', `Un capítulo admite como máximo ${MAX_PAGES} páginas.`)
  if (!files.length && !skipped.length) toast('warn', 'No se encontraron imágenes')
  renderThumbs()
  validate()
}

function removeFile(id) {
  state.files = state.files.filter((f) => f.id !== id)
  renderThumbs()
  validate()
}

function moveFile(from, to) {
  if (from === to || from + 1 === to) return
  const [item] = state.files.splice(from, 1)
  state.files.splice(to > from ? to - 1 : to, 0, item)
  renderThumbs()
  validate()
}

/** Botón «Simple»: la página no se empareja con otra en el modo doble página del lector. */
function singleToggle(f, locked, onChange) {
  const btn = el('button', {
    type: 'button',
    class: `thumb-single${f.single ? ' on' : ''}`,
    'aria-pressed': String(Boolean(f.single)),
    title: f.single ? 'Página simple activada: se muestra sola en doble página. Clic para desactivar.' : 'Página simple desactivada. Clic para que se muestre sola en doble página.',
    disabled: locked,
    html: `${f.single ? ICONS.boxOn : ICONS.boxOff}<span>Simple</span>`,
    onclick: (e) => {
      e.stopPropagation()
      f.single = !f.single
      onChange()
    },
  })
  btn.addEventListener('dblclick', (e) => e.stopPropagation())
  return btn
}

const countSingles = (files) => files.filter((f) => f.single).length

/** Botón ★: página destacada del capítulo (solo una). Volver a pulsarla la desmarca. */
function featuredToggle(f, files, locked, onChange) {
  const btn = el('button', {
    type: 'button',
    class: `thumb-featured${f.featured ? ' on' : ''}`,
    'aria-pressed': String(Boolean(f.featured)),
    title: f.featured
      ? 'Página destacada: sale en grande en los avisos y la vista previa. Clic para quitarla.'
      : 'Marcar como página destacada (sale en grande en los avisos y la vista previa).',
    disabled: locked,
    html: f.featured ? ICONS.starOn : ICONS.star,
    onclick: (e) => {
      e.stopPropagation()
      const was = Boolean(f.featured)
      files.forEach((x) => { x.featured = false })
      f.featured = !was
      onChange()
    },
  })
  btn.addEventListener('dblclick', (e) => e.stopPropagation())
  return btn
}

/** Valor de announcePage para la API: número de página, null (portada) o undefined (default del scan). */
function announcePageFor(files) {
  const i = files.findIndex((f) => f.featured)
  if (i >= 0) return i + 1
  return $('#announceDefault').value === 'cover' ? null : undefined
}

function featuredLabel(files) {
  const i = files.findIndex((f) => f.featured)
  if (i >= 0) return `★ pág. ${i + 1}`
  return $('#announceDefault').value === 'cover' ? '★ portada' : ''
}

function renderThumbs() {
  const list = $('#thumbs')
  const has = state.files.length > 0
  const dz = $('#dropzone')
  dz.classList.toggle('empty', !has)
  dz.classList.toggle('has-files', has)
  $('#dzEmpty').hidden = has
  list.hidden = !has
  $('#pagesToolbar').hidden = !has
  $('#pageCount').textContent = String(state.files.length)

  const total = state.files.reduce((s, f) => s + f.size, 0)
  const singles = countSingles(state.files)
  const featured = state.files.findIndex((f) => f.featured)
  $('#pagesSummary').textContent = has
    ? `${state.files.length} página${state.files.length === 1 ? '' : 's'} · ${formatBytes(total)}${singles ? ` · ${singles} simple${singles === 1 ? '' : 's'}` : ''}${featured >= 0 ? ` · destacada: pág. ${featured + 1}` : ''} — arrastra para reordenar, «Simple» para verla sola en doble página, ★ para destacarla.`
    : 'Arrastra para reordenar. Se suben en este orden de lectura.'

  list.innerHTML = ''
  state.files.forEach((f, i) => {
    const bad = f.size > MAX_BYTES
    const li = el('li', {
      class: `thumb${bad ? ' bad' : ''}${f.single ? ' single' : ''}${f.featured ? ' featured' : ''}`,
      draggable: state.uploading ? 'false' : 'true',
      dataset: { index: i, id: f.id, ...(f.status ? { status: f.status } : {}) },
      title: f.name,
      ondblclick: () => openLightbox(i),
    },
    el('div', { class: 'thumb-img' },
      el('img', { src: f.url, alt: '', loading: 'lazy', decoding: 'async' }),
      el('span', { class: 'thumb-num', text: String(i + 1) }),
      el('button', {
        type: 'button', class: 'thumb-remove', title: 'Quitar', html: ICONS.x,
        onclick: (e) => { e.stopPropagation(); removeFile(f.id) },
      }),
      singleToggle(f, state.uploading, renderThumbs),
      featuredToggle(f, state.files, state.uploading, () => { renderThumbs(); validate() }),
      el('div', { class: 'thumb-status', html: f.status === 'done' ? ICONS.check : f.status === 'error' ? ICONS.x : ICONS.spinner }),
    ),
    el('div', { class: 'thumb-meta' },
      el('span', { class: 'thumb-name', text: f.name }),
      el('span', { class: 'thumb-size', text: bad ? `${formatBytes(f.size)} · supera 40 MB` : formatBytes(f.size) })))
    list.append(li)
  })
  if (has && !state.uploading && state.files.length < MAX_PAGES) {
    list.append(el('li', { class: 'thumb add-tile', title: 'Agregar más imágenes', onclick: () => $('#fileInput').click() },
      el('div', { class: 'thumb-img add-inner', html: ICONS.plus }),
      el('div', { class: 'thumb-meta' }, el('span', { class: 'thumb-name', text: 'Agregar más' }), el('span', { class: 'thumb-size', text: 'Clic o suelta aquí' }))))
  }
}

function setFileStatus(index, status) {
  const f = state.files[index]
  if (!f) return
  f.status = status
  const li = $(`#thumbs li[data-index="${index}"]`)
  if (!li) return
  li.dataset.status = status
  li.querySelector('.thumb-status').innerHTML = status === 'done' ? ICONS.check : status === 'error' ? ICONS.x : ICONS.spinner
}

function initDropzone() {
  const dz = $('#dropzone')
  const input = $('#fileInput')
  let dragDepth = 0
  let dragFrom = null

  const isExternal = (e) => e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')

  dz.addEventListener('click', (e) => {
    if (state.uploading) return
    if (dz.classList.contains('empty') && !e.target.closest('button')) input.click()
  })
  dz.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target === dz && !state.uploading) { e.preventDefault(); input.click() }
  })
  $('#pickFilesBtn').addEventListener('click', (e) => { e.stopPropagation(); input.click() })
  $('#pickFolderBtn').addEventListener('click', async (e) => {
    e.stopPropagation()
    const res = await window.capi.files.pick('folder')
    if (res.ok) addResolved(res.data)
  })
  $('#addMoreBtn').addEventListener('click', () => input.click())
  input.addEventListener('change', () => {
    const paths = Array.from(input.files).map((f) => window.capi.files.pathFor(f)).filter(Boolean)
    input.value = ''
    addPaths(paths)
  })

  // Archivos externos
  dz.addEventListener('dragenter', (e) => {
    if (!isExternal(e) || state.uploading) return
    e.preventDefault()
    dragDepth++
    dz.classList.add('drag-over')
  })
  dz.addEventListener('dragleave', (e) => {
    if (!isExternal(e)) return
    dragDepth = Math.max(0, dragDepth - 1)
    if (!dragDepth) dz.classList.remove('drag-over')
  })
  dz.addEventListener('dragover', (e) => {
    if (isExternal(e) && !state.uploading) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }
  })
  dz.addEventListener('drop', (e) => {
    if (!isExternal(e)) return
    e.preventDefault()
    dragDepth = 0
    dz.classList.remove('drag-over')
    if (state.uploading) return
    const paths = Array.from(e.dataTransfer.files).map((f) => window.capi.files.pathFor(f)).filter(Boolean)
    addPaths(paths)
  })
  // Evita que soltar fuera de la zona abra la imagen en la ventana.
  window.addEventListener('dragover', (e) => e.preventDefault())
  window.addEventListener('drop', (e) => e.preventDefault())

  // Reordenar páginas
  const list = $('#thumbs')
  const clearMarkers = () => $$('.thumb.drop-before, .thumb.drop-after').forEach((t) => t.classList.remove('drop-before', 'drop-after'))
  const targetIndex = (e) => {
    const li = e.target.closest('.thumb')
    if (!li) return null
    if (li.classList.contains('add-tile')) return { li: null, index: state.files.length }
    const rect = li.getBoundingClientRect()
    const after = e.clientX > rect.left + rect.width / 2
    return { li, after, index: Number(li.dataset.index) + (after ? 1 : 0) }
  }

  list.addEventListener('dragstart', (e) => {
    const li = e.target.closest('.thumb')
    if (!li || state.uploading || li.classList.contains('add-tile')) return
    dragFrom = Number(li.dataset.index)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('application/x-capi-page', String(dragFrom))
    requestAnimationFrame(() => li.classList.add('dragging'))
  })
  list.addEventListener('dragend', () => {
    dragFrom = null
    clearMarkers()
    $$('.thumb.dragging').forEach((t) => t.classList.remove('dragging'))
  })
  list.addEventListener('dragover', (e) => {
    if (dragFrom == null) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const t = targetIndex(e)
    clearMarkers()
    if (t?.li) t.li.classList.add(t.after ? 'drop-after' : 'drop-before')
  })
  list.addEventListener('drop', (e) => {
    if (dragFrom == null) return
    e.preventDefault()
    e.stopPropagation()
    const t = targetIndex(e)
    clearMarkers()
    if (t) moveFile(dragFrom, t.index)
    dragFrom = null
  })

  $('#sortBtn').addEventListener('click', () => {
    state.files.sort((a, b) => naturalCompare(a.name, b.name))
    renderThumbs()
  })
  $('#reverseBtn').addEventListener('click', () => {
    state.files.reverse()
    renderThumbs()
  })
  $('#clearBtn').addEventListener('click', () => {
    state.files = []
    renderThumbs()
    validate()
  })
}

/* =========================================================
   Visor
   ========================================================= */
let lbIndex = 0
let lbList = []
function openLightbox(i, list = state.files) {
  lbIndex = i
  lbList = list
  $('#lightbox').hidden = false
  showLightbox()
}
function showLightbox() {
  const f = lbList[lbIndex]
  if (!f) return closeLightbox()
  $('#lbImg').src = f.url
  $('#lbStage').scrollTop = 0
  $('#lbCaption').textContent = `Página ${lbIndex + 1} de ${lbList.length} · ${f.name}`
}
function closeLightbox() { $('#lightbox').hidden = true; $('#lbImg').removeAttribute('src') }
function initLightbox() {
  $('#lbClose').addEventListener('click', closeLightbox)
  $('#lbPrev').addEventListener('click', () => { lbIndex = (lbIndex - 1 + lbList.length) % lbList.length; showLightbox() })
  $('#lbNext').addEventListener('click', () => { lbIndex = (lbIndex + 1) % lbList.length; showLightbox() })
  $('#lightbox').addEventListener('mousedown', (e) => { if (e.target.id === 'lightbox') closeLightbox() })
  document.addEventListener('keydown', (e) => {
    if ($('#lightbox').hidden) return
    // Que Escape solo cierre el visor y no también el modal que haya debajo.
    if (e.key === 'Escape') { closeLightbox(); e.stopImmediatePropagation() }
    if (e.key === 'ArrowLeft') $('#lbPrev').click()
    if (e.key === 'ArrowRight') $('#lbNext').click()
  })
}

/* =========================================================
   Formulario y validación
   ========================================================= */
function readForm() {
  const numRaw = $('#chNumber').value.trim()
  const volRaw = $('#chVolume').value.trim()
  const schedule = $('#scheduleToggle').checked
  const early = $('#earlyToggle').checked
  const publishRaw = $('#publishAt').value
  const releaseRaw = $('#releaseAt').value
  return {
    number: numRaw === '' ? null : Number(numRaw),
    volumeNumber: volRaw === '' ? null : Number(volRaw),
    title: $('#chTitle').value.trim(),
    publishAt: schedule && publishRaw ? new Date(publishRaw) : null,
    schedule,
    earlyAccess: early,
    releaseAt: early && releaseRaw ? new Date(releaseRaw) : null,
    notify: $('#notifyToggle').checked,
  }
}

function setHint(id, text, kind = '') {
  const h = $(id)
  h.textContent = text || ''
  h.className = `hint ${kind}`
}

function validate() {
  if (state.mode === 'batch' && typeof batchValidate === 'function') return batchValidate()
  const form = readForm()
  const errors = {}
  const show = state.attempted

  if (!state.selectedWork) errors.work = 'Selecciona una obra.'

  // Número
  const existing = new Set(state.chapters.map((c) => Number(c.number)))
  if (form.number == null || Number.isNaN(form.number)) errors.number = 'Indica el número del capítulo.'
  else if (form.number < 0) errors.number = 'El número no puede ser negativo.'
  else if (existing.has(form.number)) errors.number = `El capítulo ${form.number} ya existe en esta obra.`
  if (errors.number && (show || existing.has(form.number))) setHint('#chNumberHint', errors.number, 'error')
  else if (form.number != null && state.autoNumber && state.chapters.length) setHint('#chNumberHint', 'Sugerido: siguiente al último publicado.', '')
  else setHint('#chNumberHint', '')
  $('#chNumber').classList.toggle('invalid', Boolean(errors.number) && (show || existing.has(form.number)))

  // Volumen
  if (form.volumeNumber != null && (!Number.isInteger(form.volumeNumber) || form.volumeNumber < 0)) {
    errors.volume = 'El tomo debe ser un número entero.'
  }
  setHint('#chVolumeHint', errors.volume || '', errors.volume ? 'error' : '')
  $('#chVolume').classList.toggle('invalid', Boolean(errors.volume))

  // Fechas
  const now = Date.now()
  const maxPublish = now + 365 * 86400e3
  if (form.schedule) {
    if (!form.publishAt) errors.publish = 'Elige la fecha de publicación.'
    else if (form.publishAt.getTime() <= now + 60e3) errors.publish = 'La fecha debe ser futura.'
    else if (form.publishAt.getTime() > maxPublish) errors.publish = 'Máximo 1 año a futuro.'
  }
  if (errors.publish && (show || form.publishAt)) setHint('#publishHint', errors.publish, 'error')
  else if (form.publishAt) setHint('#publishHint', `Se publicará ${relativeFromNow(form.publishAt)} · ${formatDate(form.publishAt)}`, 'ok')
  else setHint('#publishHint', 'Máximo 1 año a futuro. Hora local de tu equipo.')
  $('#publishAt').classList.toggle('invalid', Boolean(errors.publish) && (show || Boolean(form.publishAt)))

  if (form.earlyAccess && form.releaseAt) {
    const base = form.publishAt ? form.publishAt.getTime() : now
    if (form.releaseAt.getTime() <= now) errors.release = 'La fecha de liberación debe ser futura.'
    else if (form.releaseAt.getTime() <= base) errors.release = 'Debe ser posterior a la fecha de publicación.'
  }
  if (errors.release) setHint('#releaseHint', errors.release, 'error')
  else if (form.releaseAt) setHint('#releaseHint', `Se libera para todos ${relativeFromNow(form.releaseAt)} · ${formatDate(form.releaseAt)}`, 'ok')
  else setHint('#releaseHint', 'Opcional. Si lo dejas vacío, quedará anticipado hasta liberarlo desde el panel.')
  $('#releaseAt').classList.toggle('invalid', Boolean(errors.release))

  // Páginas
  if (!state.files.length) errors.files = 'Agrega las páginas del capítulo.'
  else if (state.files.some((f) => f.size > MAX_BYTES)) errors.files = 'Hay imágenes de más de 40 MB.'

  $('#workTrigger').classList.toggle('invalid', show && Boolean(errors.work))
  $('#titleCounter').textContent = `${$('#chTitle').value.length}/256`

  // Permiso
  if (state.me && !state.me.key.scopes.includes('chapters:write')) errors.scope = 'La clave no tiene el permiso chapters:write.'
  if (!state.hasKey) errors.key = 'Configura tu API key.'

  renderSummary(form, errors)
  const ok = Object.keys(errors).length === 0
  $('#uploadBtn').disabled = state.uploading || (state.attempted && !ok)
  return { ok, form, errors }
}

function renderSummary(form, errors) {
  if (state.uploading) return
  const main = $('#summaryMain')
  const sub = $('#summarySub')
  const w = state.selectedWork
  const parts = []
  if (w) parts.push(w.title)
  if (form.number != null && !Number.isNaN(form.number)) parts.push(`Cap. ${form.number}`)
  if (form.volumeNumber != null) parts.push(`Vol. ${form.volumeNumber}`)
  if (state.files.length) parts.push(`${state.files.length} pág.`)
  const fl = featuredLabel(state.files)
  if (fl) parts.push(fl)
  main.textContent = parts.length ? parts.join(' · ') : 'Completa el formulario para subir'

  const firstError = Object.values(errors)[0]
  if (state.attempted && firstError) {
    sub.textContent = firstError
    sub.className = 'summary-sub error'
    return
  }
  sub.className = 'summary-sub'
  let when = form.publishAt ? `Programado: ${formatDate(form.publishAt)}` : 'Se publica al terminar la subida'
  if (form.earlyAccess) when += form.releaseAt ? ` · Anticipado hasta ${formatDate(form.releaseAt)}` : ' · Anticipado (liberación manual)'
  else if (!form.notify) when += ' · Sin avisos'
  sub.textContent = when
}

function initForm() {
  const schedule = $('#scheduleToggle')
  const early = $('#earlyToggle')
  const notify = $('#notifyToggle')

  const refreshMins = () => {
    const min = toLocalInput(new Date(Date.now() + 2 * 60e3))
    $('#publishAt').min = min
    $('#publishAt').max = toLocalInput(new Date(Date.now() + 364 * 86400e3))
    $('#releaseAt').min = $('#publishAt').value || min
  }

  schedule.addEventListener('change', () => {
    $('#scheduleBox').hidden = !schedule.checked
    refreshMins()
    if (schedule.checked && !$('#publishAt').value) {
      // Por defecto: mañana a la hora en punto siguiente.
      const d = new Date(Date.now() + 86400e3)
      d.setMinutes(0, 0, 0)
      d.setHours(d.getHours() + 1)
      $('#publishAt').value = toLocalInput(d)
    }
    validate()
  })

  early.addEventListener('change', () => {
    $('#earlyBox').hidden = !early.checked
    refreshMins()
    // La API no combina notify:false con earlyAccess (un anticipado siempre avisa).
    notify.disabled = early.checked
    if (early.checked) notify.checked = true
    $('#notifyOption').classList.toggle('disabled', early.checked)
    $('#notifyDesc').textContent = early.checked
      ? 'Los capítulos anticipados siempre avisan a los seguidores.'
      : 'Notificaciones, correos, webhooks y Discord. Apágalo para subir capítulos viejos en silencio.'
    validate()
  })

  $('#chNumber').addEventListener('input', () => { state.autoNumber = false; validate() })
  $('#chVolume').addEventListener('input', () => { state.autoVolume = false; validate() })
  $('#publishAt').addEventListener('input', () => { refreshMins(); validate() })
  ;['#chTitle', '#releaseAt', '#notifyToggle'].forEach((s) => $(s).addEventListener('input', validate))
  $('#notifyToggle').addEventListener('change', validate)
  $('#scheduleToggle').addEventListener('focus', refreshMins)
  $('#resetBtn').addEventListener('click', () => (state.mode === 'batch' ? batchReset() : resetForm(true)))
  setInterval(() => { if (!state.uploading) validate() }, 30e3)
}

function resetForm(full) {
  if (state.uploading) return
  state.files = []
  state.attempted = false
  $('#chTitle').value = ''
  if (full) {
    $('#scheduleToggle').checked = false
    $('#earlyToggle').checked = false
    $('#publishAt').value = ''
    $('#releaseAt').value = ''
    $('#notifyToggle').checked = true
    $('#scheduleToggle').dispatchEvent(new Event('change'))
    $('#earlyToggle').dispatchEvent(new Event('change'))
  }
  state.autoNumber = true
  state.autoVolume = true
  applyChapterSuggestions()
  renderThumbs()
  validate()
}

/* =========================================================
   Subida
   ========================================================= */
function handleApiError(error, title) {
  if (error.code === 'api.key_missing' || error.code === 'api.key_invalid') {
    toast('error', 'API key no válida', error.message, 8000)
    state.me = null
    renderScanChip()
    openKeyModal()
    return
  }
  toast('error', title, error.message, 8000)
}

function setUploadingUI(on) {
  state.uploading = on
  document.body.classList.toggle('uploading', on)
  $('#progressWrap').hidden = !on
  $('#cancelBtn').hidden = !on
  $('#resetBtn').hidden = on
  $('#uploadBtn').disabled = on
  $('#uploadBtnText').textContent = on ? 'Subiendo…' : state.mode === 'batch' ? 'Subir capítulos' : 'Subir capítulo'
  $('.column-form input, .column-form button, .column-form select, #pagesToolbar button, #dropzone button, #batchToolbar button, #batchDrop button, #batchList input, #batchList button').forEach((n) => {
    if (on) { n.dataset.wasDisabled = n.disabled ? '1' : ''; n.disabled = true }
    else { n.disabled = n.dataset.wasDisabled === '1'; delete n.dataset.wasDisabled }
  })
  $('#workTrigger').disabled = on
  if (!on) renderThumbs()
}

function setProgress(pct, text) {
  $('#progressBar').style.width = `${Math.max(0, Math.min(100, pct))}%`
  $('#progressPct').textContent = `${Math.round(pct)}%`
  if (text) $('#progressText').textContent = text
}

async function startUpload() {
  state.attempted = true
  const { ok, form, errors } = validate()
  if (!ok) {
    const first = Object.keys(errors)[0]
    const focusMap = { work: '#workTrigger', number: '#chNumber', volume: '#chVolume', publish: '#publishAt', release: '#releaseAt', files: '#dropzone' }
    if (errors.key) return openKeyModal()
    $(focusMap[first] || '#uploadBtn')?.focus()
    toast('warn', 'Revisa el formulario', errors[first])
    return
  }

  state.files.forEach((f) => { f.status = 'queued' })
  setUploadingUI(true)
  renderThumbs()
  setProgress(0, 'Preparando…')
  $('#summaryMain').textContent = `Subiendo «${state.selectedWork.title}» · Cap. ${form.number}`
  $('#summarySub').className = 'summary-sub'
  $('#summarySub').textContent = `${state.files.length} páginas`

  const unsubscribe = window.capi.upload.onProgress((p) => {
    if (p.phase === 'prepare') setProgress(0, 'Preparando archivos…')
    else if (p.phase === 'sign') $('#progressText').textContent = 'Solicitando URLs de subida…'
    else if (p.phase === 'file') setFileStatus(p.index, p.status)
    else if (p.phase === 'upload') {
      setProgress((p.doneBytes / p.totalBytes) * 95, `Subiendo páginas ${p.done}/${p.total} · ${formatBytes(p.doneBytes)} de ${formatBytes(p.totalBytes)}`)
    } else if (p.phase === 'create') setProgress(97, 'Creando capítulo…')
    else if (p.phase === 'verify') setProgress(99, 'Verificando páginas simples…')
    else if (p.phase === 'done') setProgress(100, 'Listo')
  })

  const work = state.selectedWork
  const res = await window.capi.upload.start({
    workId: work.id,
    files: state.files.map((f) => ({ path: f.path, single: Boolean(f.single) })),
    chapter: {
      number: form.number,
      title: form.title || null,
      volumeNumber: form.volumeNumber,
      publishAt: form.publishAt ? form.publishAt.toISOString() : null,
      earlyAccess: form.earlyAccess,
      releaseAt: form.releaseAt ? form.releaseAt.toISOString() : null,
      notify: form.notify,
      announcePage: announcePageFor(state.files),
    },
  })
  unsubscribe()
  setUploadingUI(false)

  if (!res.ok) {
    state.files.forEach((f) => { if (f.status !== 'done') f.status = null })
    renderThumbs()
    validate()
    if (res.error.code === 'cancelled') {
      toast('info', 'Subida cancelada', 'Las páginas ya subidas se reutilizarán si vuelves a intentarlo pronto.')
      return
    }
    if (res.error.code === 'api.conflict') {
      $('#chNumber').classList.add('invalid')
      setHint('#chNumberHint', res.error.message, 'error')
      $('#chNumber').focus()
    }
    $('#summarySub').className = 'summary-sub error'
    $('#summarySub').textContent = res.error.message
    handleApiError(res.error, 'No se pudo subir el capítulo')
    return
  }

  state.lastResult = res.data
  showDone(res.data, form, work)
  warnSingles(res.data.singleCheck, form.number)
  state.chapters.push({ number: form.number, volumeNumber: form.volumeNumber, state: res.data.state })
  loadChapters()
}

/** Avisa si la comprobación posterior no encontró las páginas simples como se pidieron. */
function warnSingles(check, number) {
  if (!check || check.ok) return
  toast('warn', `Cap. ${number}: revisa las páginas simples`, check.error
    ? `El capítulo se subió, pero no se pudieron comprobar: ${check.error}`
    : `Se pidieron ${check.expected} y quedaron ${check.marked}. Corrígelas desde el panel.`, 10000)
}

function showDone(chapter, form, work) {
  const states = { published: 'Publicado', scheduled: 'Programado', early_access: 'Anticipado' }
  const lines = [`«${work.title}» · Capítulo ${chapter.number ?? form.number}${form.title ? ` — ${form.title}` : ''}`]
  const singles = countSingles(state.files)
  const fl = featuredLabel(state.files)
  lines.push(`${state.files.length} páginas${singles ? ` (${singles} simple${singles === 1 ? '' : 's'})` : ''}${fl ? ` · destacada ${fl.replace('★ ', '')}` : ''} · ${states[chapter.state] || chapter.state || 'Creado'}`)
  if (form.publishAt) lines.push(`Se publica el ${formatDate(form.publishAt)}`)
  if (form.earlyAccess) lines.push(form.releaseAt ? `Libre para todos el ${formatDate(form.releaseAt)}` : 'Anticipado hasta liberarlo desde el panel')
  $('#doneTitle').textContent = form.publishAt ? '¡Capítulo programado!' : '¡Capítulo subido!'
  const text = $('#doneText')
  text.innerHTML = ''
  lines.forEach((l, i) => { if (i) text.append(el('br')); text.append(l) })
  $('#doneOpen').hidden = !chapter.url
  $('#doneModal').hidden = false
}

function initUpload() {
  $('#uploadBtn').addEventListener('click', () => (state.mode === 'batch' ? batchStart() : startUpload()))
  $('#cancelBtn').addEventListener('click', () => {
    $('#progressText').textContent = 'Cancelando…'
    window.capi.upload.cancel()
  })
  $('#doneOpen').addEventListener('click', () => state.lastResult?.url && window.capi.system.openExternal(state.lastResult.url))
  $('#doneNext').addEventListener('click', () => {
    $('#doneModal').hidden = true
    // En modo varios la lista se queda para ver el resultado de cada capítulo.
    if (state.mode !== 'batch') resetForm(false)
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#doneModal').hidden) $('#doneNext').click()
    if (e.key === 'Escape' && !$('#keyModal').hidden) closeKeyModal()
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !state.uploading) $('#uploadBtn').click()
  })
}

/* =========================================================
   Arranque
   ========================================================= */
async function boot() {
  await initTheme()
  initKeyModal()
  initCombo()
  initDropzone()
  initLightbox()
  initForm()
  initUpload()
  renderThumbs()
  renderWorkTrigger()

  const s = await window.capi.settings.get()
  state.hasKey = Boolean(s.ok && s.data.hasKey)
  renderScanChip()
  validate()
  if (!state.hasKey) openKeyModal()
  else loadWorks()
}

boot()
