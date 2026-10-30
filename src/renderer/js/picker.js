'use strict'

/* =========================================================
   Selector flotante de obra (Varios capítulos e Importar de web).
   ========================================================= */

/* ---------- Selector flotante de obra ---------- */

let pickerTargets = []
let pickerIndex = 0
let pickerOnPick = null // otro uso del selector (p. ej. «Importar de web»)

function pickerWorks() {
  const q = normTitle($('#workPickerSearch').value)
  return state.works.filter((w) => !q || normTitle(`${w.title} ${w.alternativeTitle || ''} ${w.slug}`).includes(q))
}

function renderWorkPicker() {
  const list = $('#workPickerList')
  list.innerHTML = ''
  const works = pickerWorks()
  pickerIndex = Math.min(pickerIndex, Math.max(0, works.length - 1))
  const current = new Set(pickerTargets.map((i) => i.workId))
  if (!works.length) {
    list.append(el('li', { class: 'empty', text: state.works.length ? 'No hay obras que coincidan.' : 'Cargando obras…' }))
    return
  }
  works.forEach((w, i) => {
    list.append(el('li', {
      role: 'option',
      'aria-selected': String(current.size === 1 && current.has(w.id)),
      class: i === pickerIndex ? 'active' : '',
      onmousemove: () => { if (pickerIndex !== i) { pickerIndex = i; $$('#workPickerList li').forEach((li, j) => li.classList.toggle('active', j === i)) } },
      onclick: () => choosePickerWork(w),
    }, coverImg(w), el('div', { class: 'work-text' },
      el('span', { class: 'work-title', text: w.title, title: w.title }), workMeta(w))))
  })
}

function openWorkPicker(anchor, items, onPick = null) {
  if (state.uploading && !onPick) return
  pickerTargets = items
  pickerOnPick = onPick
  pickerIndex = 0
  const pop = $('#workPicker')
  $('#workPickerSearch').value = ''
  renderWorkPicker()
  pop.hidden = false
  // Se abre junto al botón, sin salirse de la ventana.
  const r = anchor.getBoundingClientRect()
  const w = pop.offsetWidth
  const h = pop.offsetHeight
  const left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8)
  const below = r.bottom + 6 + h < window.innerHeight - 8
  pop.style.left = `${left}px`
  pop.style.top = `${below ? r.bottom + 6 : Math.max(8, r.top - h - 6)}px`
  $('#workPickerSearch').focus()
}

function closeWorkPicker() {
  $('#workPicker').hidden = true
  pickerTargets = []
  pickerOnPick = null
}

async function choosePickerWork(work) {
  const items = pickerTargets
  const onPick = pickerOnPick
  closeWorkPicker()
  if (onPick) return onPick(work)
  const moved = items.filter((i) => i.status !== 'done' && i.workId !== work.id).length
  await assignWork(items, work)
  if (moved) toast('success', `${plural(moved, 'capítulo', 'capítulos')} en «${work.title}»`)
}

function initWorkPicker() {
  $('#workPickerSearch').addEventListener('input', () => { pickerIndex = 0; renderWorkPicker() })
  $('#workPickerSearch').addEventListener('keydown', (e) => {
    const works = pickerWorks()
    if (e.key === 'ArrowDown') { e.preventDefault(); pickerIndex = Math.min(works.length - 1, pickerIndex + 1); renderWorkPicker() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); pickerIndex = Math.max(0, pickerIndex - 1); renderWorkPicker() }
    else if (e.key === 'Enter') { e.preventDefault(); if (works[pickerIndex]) choosePickerWork(works[pickerIndex]) }
    else if (e.key === 'Escape') { e.stopPropagation(); closeWorkPicker() }
    else return
    $$('#workPickerList li')[pickerIndex]?.scrollIntoView({ block: 'nearest' })
  })
  document.addEventListener('mousedown', (e) => {
    if (!$('#workPicker').hidden && !$('#workPicker').contains(e.target)) closeWorkPicker()
  })
  window.addEventListener('resize', closeWorkPicker)
  $('#batchList').addEventListener('scroll', closeWorkPicker, { passive: true })
}
