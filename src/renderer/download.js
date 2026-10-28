'use strict'

/* =========================================================
   «Descargar»: baja capítulos de las obras del scan activo.
   Usa el estado y las utilidades de app.js y batch.js.
   ========================================================= */
const dl = {
  workId: null,
  selected: new Set(), // ids de capítulo marcados
  rows: new Map(), // id → { status: 'queued' | 'downloading' | 'done' | 'skipped' | 'error', done, total, error }
  loading: false,
  running: false,
  dest: null,
  lastDir: null,
  anchor: null, // última fila marcada, para Mayús + clic
  workIndex: 0,
}

const DL_STATE_LABEL = { scheduled: 'Programado', draft: 'Borrador' }

const dlWork = () => workById(dl.workId)
const dlChapters = () => [...(state.chaptersByWork.get(dl.workId) || [])].sort((a, b) => a.number - b.number || naturalCompare(String(a.title || ''), String(b.title || '')))
const dlChosen = () => dlChapters().filter((c) => dl.selected.has(c.id))

/* ---------- Obras ---------- */

function dlFilteredWorks() {
  const q = normTitle($('#dlWorkSearch').value)
  return state.works.filter((w) => !q || normTitle(`${w.title} ${w.alternativeTitle || ''} ${w.slug}`).includes(q))
}

function renderDlWorks() {
  const list = $('#dlWorkList')
  list.innerHTML = ''
  const works = dlFilteredWorks()
  if (!works.length) {
    const text = !state.hasKey ? 'Agrega un scan para ver sus obras.' : state.worksLoading ? 'Cargando obras…' : state.works.length ? 'No hay obras que coincidan.' : 'Este scan no tiene obras.'
    list.append(el('li', { class: 'empty', text }))
    return
  }
  dl.workIndex = Math.min(dl.workIndex, works.length - 1)
  works.forEach((w, i) => {
    list.append(el('li', {
      role: 'option',
      'aria-selected': String(w.id === dl.workId),
      class: i === dl.workIndex ? 'active' : '',
      onclick: () => dlSelectWork(w),
    }, coverImg(w), el('div', { class: 'work-text' },
      el('span', { class: 'work-title', text: w.title, title: w.title }), workMeta(w))))
  })
}

async function dlSelectWork(work) {
  if (dl.running) return toast('info', 'Espera a que termine la descarga', 'O cancélala para elegir otra obra.')
  if (dl.workId === work.id && !dl.loading) return
  dl.workId = work.id
  dl.selected.clear()
  dl.rows.clear()
  dl.anchor = null
  dl.loading = true
  $('#dlOpenBtn').hidden = true
  renderDlWorks()
  renderDlList()
  const data = await ensureChapters(work.id, { force: true })
  if (dl.workId !== work.id) return
  dl.loading = false
  if (data) for (const c of data) dl.selected.add(c.id)
  renderDlList()
}

/* ---------- Capítulos ---------- */

function dlStatusPill(row) {
  if (!row) return null
  const map = {
    queued: ['', 'En cola'],
    downloading: ['uploading', row.total ? `Descargando ${row.done}/${row.total}` : 'Descargando…'],
    done: ['done', 'Descargado ✓'],
    skipped: ['skipped', 'Ya estaba ✓'],
    error: ['error', 'Error'],
  }
  const [cls, text] = map[row.status] || ['', '']
  return el('span', { class: `ch-status ${cls}`, text, title: row.error || '' })
}

function dlRow(c) {
  const on = dl.selected.has(c.id)
  const row = dl.rows.get(c.id)
  const pct = row?.status === 'downloading' && row.total ? row.done / row.total : row && ['done', 'skipped'].includes(row.status) ? 1 : 0
  const box = el('input', { type: 'checkbox', checked: on, disabled: dl.running, tabindex: '-1' })
  const meta = [c.pages ? `${formatNumber(c.pages)} pág.` : null, DL_STATE_LABEL[c.state]].filter(Boolean).join(' · ')
  return el('li', {
    class: `dl-row${on ? ' on' : ''}`, dataset: { id: c.id, status: row?.status || '' },
    title: row?.error || '',
    onclick: (e) => dlToggle(c, e.shiftKey),
  },
  box,
  el('span', { class: 'dl-num' }, chapterLabel(shownNumber(c), isExtra(c)), c.volumeNumber != null ? el('small', { text: `Vol ${c.volumeNumber}` }) : null),
  el('span', { class: 'dl-title', text: c.title || '' }),
  el('span', { class: 'dl-meta', text: meta }),
  dlStatusPill(row) || el('span'),
  el('div', { class: 'ch-progress' }, el('div', { style: `width:${Math.round(pct * 100)}%` })))
}

function dlToggle(c, range) {
  if (dl.running) return
  const list = dlChapters()
  if (range && dl.anchor != null) {
    const a = list.findIndex((x) => x.id === dl.anchor)
    const b = list.findIndex((x) => x.id === c.id)
    const on = !dl.selected.has(c.id)
    for (const x of list.slice(Math.min(a, b), Math.max(a, b) + 1)) on ? dl.selected.add(x.id) : dl.selected.delete(x.id)
  } else {
    dl.selected.has(c.id) ? dl.selected.delete(c.id) : dl.selected.add(c.id)
  }
  dl.anchor = c.id
  renderDlList()
}

function renderDlList() {
  const work = dlWork()
  const chapters = dlChapters()
  const list = $('#dlList')
  const empty = !work || dl.loading || !chapters.length
  $('#dlEmpty').hidden = !empty
  list.hidden = empty
  $('#dlToolbar').hidden = empty
  $('#dlCount').textContent = String(work && !dl.loading ? chapters.length : 0)
  if (!work) {
    $('#dlEmptyTitle').textContent = 'Elige una obra'
    $('#dlEmptySub').textContent = 'Sus capítulos aparecerán aquí para marcar cuáles descargar.'
    $('#dlListSummary').textContent = 'Elige una obra para ver sus capítulos.'
  } else if (dl.loading) {
    $('#dlEmptyTitle').textContent = 'Cargando capítulos…'
    $('#dlEmptySub').textContent = work.title
    $('#dlListSummary').textContent = work.title
  } else if (!chapters.length) {
    $('#dlEmptyTitle').textContent = 'Esta obra no tiene capítulos'
    $('#dlEmptySub').textContent = 'Cuando subas alguno podrás descargarlo desde aquí.'
    $('#dlListSummary').textContent = work.title
  } else {
    $('#dlListSummary').textContent = `${work.title} — clic para marcar, Mayús + clic para un tramo.`
  }
  list.innerHTML = ''
  if (!empty) chapters.forEach((c) => list.append(dlRow(c)))
  renderDlSummary()
}

function updateDlRow(id) {
  const c = dlChapters().find((x) => x.id === id)
  const old = $(`#dlList .dl-row[data-id="${id}"]`)
  if (c && old) old.replaceWith(dlRow(c))
}

// Capibara solo da las imágenes de las páginas a claves con chapters:write.
const dlNoScope = () => Boolean(state.me && !canWrite(state.me.key))
const DL_SCOPE_TEXT = 'Esta API key no tiene el permiso chapters:write: Capibara solo deja descargar las páginas con ese permiso.'

function renderDlSummary() {
  const work = dlWork()
  const chosen = dlChosen()
  const pages = chosen.reduce((s, c) => s + (c.pages || 0), 0)
  if (!dl.running) {
    $('#dlSummaryMain').textContent = work
      ? chosen.length ? `${work.title} · ${plural(chosen.length, 'capítulo', 'capítulos')}${pages ? ` · ${formatNumber(pages)} pág.` : ''}` : `${work.title} · ningún capítulo marcado`
      : 'Elige una obra y sus capítulos'
    $('#dlSummarySub').className = `summary-sub${dlNoScope() ? ' error' : ''}`
    $('#dlSummarySub').textContent = dlNoScope() ? DL_SCOPE_TEXT : dl.dest ? `En ${dl.dest}` : ''
  }
  $('#dlStartText').textContent = dl.running ? 'Descargando…' : chosen.length > 1 ? `Descargar ${chosen.length} capítulos` : 'Descargar'
  $('#dlStartBtn').disabled = dl.running || !chosen.length || !state.hasKey || dlNoScope()
}

/* ---------- Destino ---------- */

function renderDlDest() {
  $('#dlDest').textContent = dl.dest || '…'
  $('#dlDest').title = dl.dest || ''
}

/* ---------- Descarga ---------- */

function setDlProgress(pct, text) {
  $('#dlProgressBar').style.width = `${Math.max(0, Math.min(100, pct))}%`
  $('#dlProgressPct').textContent = `${Math.round(pct)}%`
  if (text) $('#dlProgressText').textContent = text
}

function setDlRunningUI(on) {
  dl.running = on
  $('#dlProgressWrap').hidden = !on
  $('#dlCancelBtn').hidden = !on
  $('#dlPickDest').disabled = on
  $('#dlFormat').disabled = on
  setViewBusy('download', on)
  renderDlList()
}

async function dlStart() {
  const work = dlWork()
  const chosen = dlChosen()
  if (!work || !chosen.length || dl.running) return
  if (!state.hasKey) return openKeyModal(true)
  if (dlNoScope()) return toast('error', 'No se puede descargar', DL_SCOPE_TEXT, 8000)
  dl.rows.clear()
  for (const c of chosen) dl.rows.set(c.id, { status: 'queued' })
  dl.lastDir = null
  $('#dlOpenBtn').hidden = true
  setDlRunningUI(true)
  setDlProgress(0, 'Preparando…')
  $('#dlSummaryMain').textContent = `Descargando ${plural(chosen.length, 'capítulo', 'capítulos')} de «${work.title}»`
  $('#dlSummarySub').textContent = dl.dest ? `En ${dl.dest}` : ''

  const unsubscribe = window.capi.download.onProgress((p) => {
    const c = chosen.find((x) => x.id === p.chapterId)
    const label = `${p.position + 1}/${p.count} · ${c ? chapterLabel(shownNumber(c), isExtra(c)) : ''}`
    const row = dl.rows.get(p.chapterId) || {}
    if (p.status === 'start' || p.status === 'page') Object.assign(row, { status: 'downloading', done: p.done, total: p.total })
    else if (p.status === 'done') Object.assign(row, { status: 'done', done: p.total, total: p.total })
    else if (p.status === 'skipped') row.status = 'skipped'
    else if (p.status === 'error') Object.assign(row, { status: 'error', error: p.error })
    dl.rows.set(p.chapterId, row)
    if (p.dir) dl.lastDir = p.dir
    updateDlRow(p.chapterId)
    const frac = row.status === 'downloading' && row.total ? row.done / row.total : row.status === 'queued' ? 0 : 1
    setDlProgress(((p.position + frac) / p.count) * 100,
      p.status === 'skipped' ? `${label} · ya estaba descargado` : row.total ? `${label} · páginas ${row.done}/${row.total}` : `${label} · leyendo páginas…`)
  })

  const res = await window.capi.download.start({
    work: { id: work.id, title: work.title },
    chapters: chosen.map((c) => ({
      id: c.id, number: c.number, volumeNumber: c.volumeNumber ?? null, title: c.title || '', pages: c.pages ?? null,
      extra: isExtra(c), extraNumber: isExtra(c) ? extraNo(c) : null,
    })),
    dest: dl.dest,
    format: $('#dlFormat').value,
  })
  unsubscribe()
  for (const [id, row] of dl.rows) if (row.status === 'queued' || row.status === 'downloading') dl.rows.delete(id)
  setDlRunningUI(false)

  if (!res.ok) {
    if (res.error.code === 'cancelled') {
      toast('info', 'Descarga cancelada', 'Lo ya descargado se conserva: al repetir la descarga se salta.')
    } else {
      $('#dlSummarySub').className = 'summary-sub error'
      $('#dlSummarySub').textContent = res.error.message
      handleApiError(res.error, 'No se pudo descargar')
    }
    if (dl.lastDir) $('#dlOpenBtn').hidden = false
    return
  }

  const s = res.data
  dl.lastDir = s.workDir
  $('#dlOpenBtn').hidden = false
  const parts = [
    s.done ? `${plural(s.done, 'capítulo descargado', 'capítulos descargados')} (${formatNumber(s.pages)} pág.)` : null,
    s.skipped ? `${s.skipped} ya estaba${s.skipped === 1 ? '' : 'n'}` : null,
    s.failed.length ? `${s.failed.length} con error: ${s.failed.slice(0, 3).map((f) => { const c = chosen.find((x) => x.id === f.chapterId); return c ? chapterLabel(shownNumber(c), isExtra(c)) : `Cap ${f.number}` }).join(', ')}${s.failed.length > 3 ? '…' : ''}` : null,
  ].filter(Boolean)
  $('#dlSummaryMain').textContent = s.failed.length ? 'Descarga terminada con errores' : '¡Descarga terminada!'
  $('#dlSummarySub').className = `summary-sub${s.failed.length ? ' error' : ''}`
  $('#dlSummarySub').textContent = parts.join(' · ')
  toast(s.failed.length ? 'warn' : 'success', s.failed.length ? 'Descarga terminada con errores' : '¡Descarga terminada!',
    `${parts.join(' · ')}.${s.failed.length ? ' Pasa el ratón sobre la fila para ver el motivo y vuelve a descargar para reintentar.' : ''}`, 9000)
}

/* ---------- Ganchos con app.js ---------- */

async function dlOnShow() {
  renderDlWorks()
  renderDlList()
  if (!dl.dest) {
    const res = await window.capi.download.folder()
    if (res.ok) { dl.dest = res.data; renderDlDest(); renderDlSummary() }
  }
  $('#dlWorkSearch').focus()
}

function dlOnScanChanged() {
  if (dl.running) {
    window.capi.download.cancel()
    toast('info', 'Se canceló la descarga', 'Cambiaste de scan.')
  }
  dl.workId = null
  dl.selected.clear()
  dl.rows.clear()
  renderDlWorks()
  renderDlList()
}

function dlOnWorksLoaded() {
  if (dl.workId != null && !dlWork()) { dl.workId = null; dl.selected.clear() }
  renderDlWorks()
  renderDlList()
}

/* ---------- Inicio ---------- */

function initDownload() {
  $('#dlWorkSearch').addEventListener('input', () => { dl.workIndex = 0; renderDlWorks() })
  $('#dlWorkSearch').addEventListener('keydown', (e) => {
    const works = dlFilteredWorks()
    if (e.key === 'ArrowDown') dl.workIndex = Math.min(works.length - 1, dl.workIndex + 1)
    else if (e.key === 'ArrowUp') dl.workIndex = Math.max(0, dl.workIndex - 1)
    else if (e.key === 'Enter') { if (works[dl.workIndex]) dlSelectWork(works[dl.workIndex]) }
    else return
    e.preventDefault()
    renderDlWorks()
    $$('#dlWorkList li')[dl.workIndex]?.scrollIntoView({ block: 'nearest' })
  })
  $('#dlAll').addEventListener('click', () => { if (!dl.running) { dlChapters().forEach((c) => dl.selected.add(c.id)); renderDlList() } })
  $('#dlNone').addEventListener('click', () => { if (!dl.running) { dl.selected.clear(); renderDlList() } })
  $('#dlRange').addEventListener('click', () => {
    if (dl.running) return
    const from = $('#dlFrom').value.trim() === '' ? -Infinity : Number($('#dlFrom').value)
    const to = $('#dlTo').value.trim() === '' ? Infinity : Number($('#dlTo').value)
    if (from > to) return toast('warn', 'El tramo está al revés', '«Del» debe ser menor o igual que «al».')
    dl.selected.clear()
    for (const c of dlChapters()) if (c.number >= from && c.number <= to) dl.selected.add(c.id)
    renderDlList()
    if (!dl.selected.size) toast('info', 'No hay capítulos en ese tramo')
  })
  $('#dlPickDest').addEventListener('click', async () => {
    const res = await window.capi.download.pickFolder()
    if (res.ok && res.data) { dl.dest = res.data; renderDlDest(); renderDlSummary() }
  })
  $('#dlStartBtn').addEventListener('click', dlStart)
  $('#dlCancelBtn').addEventListener('click', () => {
    $('#dlProgressText').textContent = 'Cancelando…'
    window.capi.download.cancel()
  })
  $('#dlOpenBtn').addEventListener('click', async () => {
    if (!dl.lastDir) return
    const res = await window.capi.download.open(dl.lastDir)
    if (!res.ok) toast('error', 'No se pudo abrir la carpeta', res.error.message)
  })
  $('#dlFormat').value = localStorage.getItem('dlFormat') || 'jpg'
  $('#dlFormat').addEventListener('change', (e) => localStorage.setItem('dlFormat', e.target.value))
  renderDlDest()
}

initDownload()
