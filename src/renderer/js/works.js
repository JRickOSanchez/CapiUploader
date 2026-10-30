'use strict'

/* =========================================================
   Obras del scan activo: selector, capítulos de cada obra y extras.
   ========================================================= */

function coverImg(work, cls = 'cover') {
  return work.coverUrl
    ? el('img', { class: cls, src: work.coverUrl, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', onerror: (e) => e.target.replaceWith(el('div', { class: cls })) })
    : el('div', { class: cls })
}

function workMeta(work) {
  // Crimson y Mangation no dan idioma ni total de capítulos: se muestra el último.
  const count = work.chapters != null ? `${formatNumber(work.chapters)} caps.` : work.lastChapter != null ? `último #${work.lastChapter}` : null
  const meta = el('div', { class: 'work-meta' },
    work.language ? el('span', { class: 'tag', text: work.language }) : null,
    count ? el('span', { text: count }) : null,
    count && work.type ? el('span', { class: 'sep' }) : null,
    work.type ? el('span', { text: TYPE_LABEL[work.type] || work.type }) : null,
  )
  if (work.adult) meta.append(el('span', { class: 'tag private', text: '+18' }))
  if (work.inReview) meta.append(el('span', { class: 'tag review', text: 'En revisión' }))
  else if (work.isPublic === false || work.hidden) meta.append(el('span', { class: 'tag private', text: work.hidden ? 'Oculta' : 'Privada' }))
  return meta
}

const lastWorkKey = () => `lastWorkId:${accountKey()}`

async function loadWorks() {
  if (!state.hasKey) return
  const gen = state.scanGen
  state.worksLoading = true
  $('#reloadWorks').classList.add('spin')
  renderWorkTrigger()
  const [meRes, worksRes] = await Promise.all([
    isCapibara() ? window.capi.api.me() : Promise.resolve({ ok: false }),
    platformApi.works(),
  ])
  if (gen !== state.scanGen) return // se cambió de scan o de plataforma mientras cargaba
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

  // La 1.0 guardaba una sola «última obra»; se usa como respaldo la primera vez.
  const remembered = localStorage.getItem(lastWorkKey()) || (isCapibara() ? localStorage.getItem('lastWorkId') : null)
  const keep = state.selectedWork && state.works.find((w) => w.id === state.selectedWork.id)
  const pick = keep || state.works.find((w) => String(w.id) === remembered) || null
  if (pick && !isImportWindow) selectWork(pick, { refreshChapters: !keep })
  else renderWorkTrigger()
  renderWorkList()
  emit('worksLoaded')
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
    v.append(el('span', { class: 'placeholder', text: state.hasKey ? 'Selecciona una obra…' : isCapibara() ? 'Agrega un scan para ver sus obras' : `Inicia sesión en ${plat().full} para ver tus obras` }))
  }
}

function filteredWorks() {
  const q = $('#workSearch').value.trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
  return state.works.filter((w) => {
    if (state.langFilter && w.language && w.language !== state.langFilter) return false
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
  if (work) localStorage.setItem(lastWorkKey(), String(work.id))
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
  if (changed) emit('workSelected', work)
}

/*
 * Extras («Extra N»: arte, ilustraciones, contenido fuera de capítulos). Van numerados aparte de
 * los capítulos: la API los guarda con number = 100000 + N y extraNumber = N, y al crearlos o
 * editarlos con extra: true el number que se manda es N.
 */
const EXTRA_BASE = 100000
const isExtra = (c) => Boolean(c?.extra) || Number(c?.number) >= EXTRA_BASE
const extraNo = (c) => (c.extraNumber != null ? Number(c.extraNumber) : Number(c.number) - EXTRA_BASE)
/** El número con el que se muestra y se compara: N para los extras, number para los capítulos. */
const shownNumber = (c) => (isExtra(c) ? extraNo(c) : Number(c.number))
const regularOnly = (list) => (list || []).filter((c) => !isExtra(c))
const extrasOnly = (list) => (list || []).filter(isExtra)
/** Números ya usados en una lista de capítulos, del tipo pedido (capítulos o extras). */
const usedNumbers = (list, extra) => new Set((extra ? extrasOnly(list) : regularOnly(list)).map(shownNumber))
const chapterLabel = (n, extra) => `${extra ? 'Extra' : 'Cap'} ${n}`

const chaptersInflight = new Map()

/** Capítulos de una obra, con caché. Devuelve null si falló la consulta. */
function ensureChapters(workId, { force = false } = {}) {
  if (!force && state.chaptersByWork.has(workId)) return Promise.resolve(state.chaptersByWork.get(workId))
  // Una petición en camino ya trae la lista al día: no se lanza otra igual.
  if (chaptersInflight.has(workId)) return chaptersInflight.get(workId)
  const gen = state.scanGen
  const pr = platformApi.chapters(workId).then((res) => {
    chaptersInflight.delete(workId)
    if (gen !== state.scanGen) return null
    if (!res.ok) {
      handleApiError(res.error, 'No se pudieron cargar los capítulos')
      return null
    }
    state.chaptersByWork.set(workId, res.data)
    return res.data
  })
  chaptersInflight.set(workId, pr)
  return pr
}

async function loadChapters() {
  const work = state.selectedWork
  if (!work) return
  state.chaptersLoading = true
  renderWorkInfo()
  const data = await ensureChapters(work.id, { force: true })
  if (state.selectedWork?.id !== work.id) return // cambió mientras cargaba
  state.chaptersLoading = false
  state.chapters = data || []
  applyChapterSuggestions()
  renderWorkInfo()
  validate()
}

function latestChapter() {
  return regularOnly(state.chapters).reduce((best, c) => (!best || c.number > best.number ? c : best), null)
}

function latestExtraNumber(list) {
  const nums = extrasOnly(list).map(extraNo)
  return nums.length ? Math.max(...nums) : 0
}

function applyChapterSuggestions() {
  const last = latestChapter()
  if (state.autoNumber) {
    $('#chNumber').value = $('#extraToggle').checked
      ? String(Math.floor(latestExtraNumber(state.chapters)) + 1)
      : last ? String(Math.floor(last.number) + 1) : '1'
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
  const extras = extrasOnly(state.chapters).length
  box.append(
    el('div', { class: 'stat' }, el('div', { class: 'stat-label', text: 'Último cap.' }),
      el('div', { class: 'stat-value', text: last ? `#${last.number}${last.volumeNumber != null ? ` · Vol. ${last.volumeNumber}` : ''}` : '—' })),
    el('div', { class: 'stat' }, el('div', { class: 'stat-label', text: 'Capítulos' }),
      el('div', { class: 'stat-value', text: `${formatNumber(state.chapters.length - extras)}${extras ? ` · ${extras} extra${extras === 1 ? '' : 's'}` : ''}` })),
    el('div', { class: 'stat' }, el('div', { class: 'stat-label', text: 'Programados' }),
      el('div', { class: 'stat-value', text: scheduled ? formatNumber(scheduled) : 'Ninguno' })),
  )
}

const workById = (id) => (id == null ? null : state.works.find((w) => w.id === id) || null)
