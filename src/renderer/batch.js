'use strict'

/* =========================================================
   Modo «Varios capítulos»
   Usa las utilidades y el estado globales de app.js.
   ========================================================= */
const batch = {
  items: [], // { id, name, dir, files, number, volume, volumeAuto, title, status, progress, error, result, refs }
  seq: 0,
  volumeAuto: true,
  cancelled: false,
  pmItem: null,
}

const UNIT_MS = { minutes: 60e3, hours: 3600e3, days: 864e5, weeks: 7 * 864e5 }
const LIMIT_CHAPTERS_PER_HOUR = 60
const LIMIT_IMAGES_PER_HOUR = 3000
const ICON_GRIP = '<svg viewBox="0 0 24 24"><circle cx="9" cy="6" r=".8"/><circle cx="15" cy="6" r=".8"/><circle cx="9" cy="12" r=".8"/><circle cx="15" cy="12" r=".8"/><circle cx="9" cy="18" r=".8"/><circle cx="15" cy="18" r=".8"/></svg>'
const ICON_PAGES = '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-4.5-4.5L6 21"/></svg>'

const sumSize = (files) => files.reduce((s, f) => s + f.size, 0)
const UNIT_TEXT = {
  minutes: ['minuto', 'minutos'], hours: ['hora', 'horas'], days: ['día', 'días'], weeks: ['semana', 'semanas'],
}
/** «1 día», «3 días», «cada día» en vez de «cada 1 días». */
const amount = (n, unit) => `${n} ${UNIT_TEXT[unit][n === 1 ? 0 : 1]}`
const every = (n, unit) => (n === 1 ? `cada ${UNIT_TEXT[unit][0]}` : `cada ${amount(n, unit)}`)

/* ---------- Detección de número, tomo y título ---------- */

/**
 * Interpreta nombres de carpeta como «Cap 12», «Capítulo 12.5 - El regreso»,
 * «Vol 3 Ch 20», «[Scan] Kirara 015» o «013».
 */
function parseChapterName(raw) {
  const name = raw.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim()
  const clean = name.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()
  const volRe = /\b(?:vol(?:umen|ume)?|tomo|v)\s*[.#:-]?\s*(\d+)\b/i
  const capRe = /\b(?:cap(?:[ií]tulo|itulo)?|chapter|chap|ch|ep(?:isodio|isode)?|c)\s*[.#:-]?\s*(\d+(?:[.,]\d+)?)/i
  const titleAfter = (rest) => {
    const m = rest.match(/^\s*[-–—:|]\s*(.+)$/)
    return m ? m[1].trim().slice(0, 256) : ''
  }

  const vol = clean.match(volRe)
  const cap = clean.match(capRe)
  let number = null
  let title = ''
  if (cap) {
    number = parseFloat(cap[1].replace(',', '.'))
    title = titleAfter(clean.slice(cap.index + cap[0].length))
  } else {
    const withoutVol = vol ? clean.replace(vol[0], ' ') : clean
    const nums = [...withoutVol.matchAll(/\d+(?:[.,]\d+)?/g)]
    if (nums.length) {
      // Si el nombre empieza con número («013 - Título») se usa ese; si no, el último.
      const pick = /^\s*\d/.test(withoutVol) ? nums[0] : nums[nums.length - 1]
      number = parseFloat(pick[0].replace(',', '.'))
      title = titleAfter(withoutVol.slice(pick.index + pick[0].length))
    }
  }
  return { number, volume: vol ? parseInt(vol[1], 10) : null, title }
}

function makeNumberAllocator(extra = []) {
  const taken = new Set([
    ...state.chapters.map((c) => Number(c.number)),
    ...batch.items.map((i) => i.number),
    ...extra,
  ].filter((n) => n != null && !Number.isNaN(n)))
  let n = Math.floor(Math.max(0, ...taken)) + 1
  return () => {
    while (taken.has(n)) n++
    taken.add(n)
    return n++
  }
}

function readDefaultVolume() {
  const v = $('#batchVolume').value.trim()
  return v === '' ? null : Number(v)
}

/* ---------- Agregar / quitar ---------- */

async function pickChapters() {
  if (state.uploading) return
  const res = await window.capi.files.pickChapters()
  if (res.ok) addChapters(res.data)
}

async function addChapterPaths(paths) {
  if (!paths.length) return
  const res = await window.capi.files.resolveChapters(paths)
  if (!res.ok) return toast('error', 'No se pudieron leer las carpetas', res.error.message)
  addChapters(res.data)
}

function addChapters({ chapters, skipped, looseFiles }) {
  const known = new Set(batch.items.map((i) => i.dir))
  const fresh = chapters.filter((c) => !known.has(c.dir))
  const dupes = chapters.length - fresh.length
  const defVol = readDefaultVolume()

  const items = fresh.map((c) => {
    const p = parseChapterName(c.name)
    return {
      id: ++batch.seq,
      name: c.name,
      dir: c.dir,
      files: c.files.map((f) => ({ ...f, id: ++fileSeq, status: null })),
      number: p.number,
      volume: p.volume ?? defVol,
      volumeAuto: p.volume == null,
      title: p.title,
      status: 'pending',
      progress: 0,
      error: '',
      result: null,
    }
  })
  items.sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity) || naturalCompare(a.name, b.name))
  const next = makeNumberAllocator(items.map((i) => i.number))
  let guessed = 0
  for (const it of items) if (it.number == null) { it.number = next(); guessed++ }
  batch.items.push(...items)

  if (items.length) toast('success', `${items.length} capítulo${items.length === 1 ? '' : 's'} agregado${items.length === 1 ? '' : 's'}`,
    guessed ? `${guessed} sin número en el nombre: se les asignó el siguiente libre. Revísalos.` : null)
  if (dupes) toast('info', `${dupes} carpeta(s) ya estaban en la lista`)
  if (looseFiles) toast('warn', 'Se ignoraron imágenes sueltas', 'En este modo cada capítulo debe ser una carpeta. Para un solo capítulo usa «Un capítulo».', 7000)
  if (skipped.length) toast('warn', `${skipped.length} carpeta(s) sin imágenes`, skipped.slice(0, 3).join(', ') + (skipped.length > 3 ? '…' : ''))
  if (!chapters.length && !looseFiles && !skipped.length) toast('warn', 'No se encontraron capítulos')

  renderBatch()
  batchValidate()
}

function removeChapter(id) {
  batch.items = batch.items.filter((i) => i.id !== id)
  renderBatch()
  batchValidate()
}

function moveChapter(from, to) {
  if (from === to || from + 1 === to) return
  const [it] = batch.items.splice(from, 1)
  batch.items.splice(to > from ? to - 1 : to, 0, it)
  renderBatch()
  batchValidate()
}

function batchReset() {
  if (state.uploading) return
  batch.items = []
  state.attempted = false
  renderBatch()
  batchValidate()
}

/* ---------- Programación ---------- */

function schedulePlan() {
  const schedule = $('#scheduleToggle').checked
  const base = schedule && $('#publishAt').value ? new Date($('#publishAt').value) : null
  const intervalVal = Math.max(0, Number($('#batchInterval').value) || 0)
  const step = intervalVal * UNIT_MS[$('#batchIntervalUnit').value]
  const early = $('#earlyToggle').checked
  const relRaw = $('#batchReleaseVal').value.trim()
  const relVal = relRaw === '' ? null : Number(relRaw)
  const releaseOffset = early && relVal > 0 ? relVal * UNIT_MS[$('#batchReleaseUnit').value] : null
  const queue = batch.items.filter((i) => i.status !== 'done')
  const map = new Map()
  queue.forEach((it, k) => {
    const publishAt = base ? new Date(base.getTime() + k * step) : null
    map.set(it.id, { publishAt, releaseAt: publishAt && releaseOffset ? new Date(publishAt.getTime() + releaseOffset) : null })
  })
  return {
    schedule, base, step, intervalVal, early, relVal, releaseOffset, queue, map,
    notify: $('#notifyToggle').checked,
    unit: $('#batchIntervalUnit').value,
    relUnit: $('#batchReleaseUnit').value,
  }
}

function whenText(it, plan) {
  if (it.status === 'done') return ''
  const s = plan.map.get(it.id)
  if (!s) return ''
  let t = s.publishAt ? `Publica ${formatDate(s.publishAt)}` : 'Publica al subirse'
  if (plan.early) {
    if (s.releaseAt) t += ` · libre ${formatDate(s.releaseAt)}`
    else if (plan.releaseOffset) t += ` · libre ${amount(plan.relVal, plan.relUnit)} después`
    else t += ' · anticipado'
  }
  return t
}

/* ---------- Validación ---------- */

function syncDefaultVolume() {
  if (batch.volumeAuto && !state.chaptersLoading) {
    const last = latestChapter()
    const v = last?.volumeNumber != null ? String(last.volumeNumber) : ''
    if ($('#batchVolume').value !== v) $('#batchVolume').value = v
  }
  const def = readDefaultVolume()
  for (const it of batch.items) {
    if (it.volumeAuto && it.status !== 'done' && it.volume !== def) {
      it.volume = def
      if (it.refs) it.refs.vol.value = def ?? ''
    }
  }
}

function batchValidate() {
  syncDefaultVolume()
  const show = state.attempted
  const plan = schedulePlan()
  const queue = plan.queue
  const errors = {}

  if (!state.selectedWork) errors.work = 'Selecciona una obra.'
  if (!batch.items.length) errors.files = 'Agrega las carpetas de los capítulos.'
  else if (!queue.length) errors.files = 'Todos los capítulos de la lista ya se subieron.'

  const existing = new Set(state.chapters.map((c) => Number(c.number)))
  const counts = new Map()
  queue.forEach((i) => { if (i.number != null) counts.set(i.number, (counts.get(i.number) || 0) + 1) })

  let bad = 0
  for (const it of batch.items) {
    let err = ''
    let always = false // errores que se muestran aunque aún no se intente subir
    if (it.status !== 'done') {
      if (it.number == null || Number.isNaN(it.number)) err = 'Falta el número del capítulo.'
      else if (it.number < 0) err = 'El número no puede ser negativo.'
      else if (existing.has(it.number)) { err = `El capítulo ${it.number} ya existe en esta obra.`; always = true }
      else if (counts.get(it.number) > 1) { err = `El número ${it.number} está repetido en la lista.`; always = true }
      else if (it.volume != null && (!Number.isInteger(it.volume) || it.volume < 0)) { err = 'El tomo debe ser un número entero.'; always = true }
      else if (it.files.length > MAX_PAGES) { err = `Tiene ${it.files.length} páginas (máximo ${MAX_PAGES}).`; always = true }
      else if (it.files.some((f) => f.size > MAX_BYTES)) { err = 'Tiene imágenes de más de 40 MB.'; always = true }
    }
    if (err) bad++
    if (it.refs) {
      const visible = err && (show || always)
      it.refs.row.classList.toggle('invalid', Boolean(visible))
      it.refs.error.textContent = visible ? err : it.status === 'error' ? it.error : ''
      it.refs.when.textContent = whenText(it, plan)
    }
  }
  if (bad) errors.rows = bad === 1 ? 'Un capítulo tiene datos por corregir.' : `${bad} capítulos tienen datos por corregir.`

  // Fechas
  const now = Date.now()
  let publishMsg = ''
  if (plan.schedule) {
    const last = plan.base ? plan.base.getTime() + Math.max(0, queue.length - 1) * plan.step : null
    if (!plan.base) errors.publish = 'Elige la fecha del primer capítulo.'
    else if (plan.base.getTime() <= now + 60e3) errors.publish = 'La fecha debe ser futura.'
    else if (last > now + 365 * 864e5) errors.publish = 'El último capítulo quedaría a más de 1 año (máximo de la API).'
    else if (queue.length > 1 && plan.step) publishMsg = `Del ${formatDate(plan.base)} al ${formatDate(new Date(last))}`
    else publishMsg = `${queue.length > 1 ? 'Todos se publican' : 'Se publica'} ${relativeFromNow(plan.base)} · ${formatDate(plan.base)}`
  }
  setHint('#publishHint', errors.publish || publishMsg || 'Máximo 1 año a futuro. Hora local de tu equipo.',
    errors.publish ? 'error' : publishMsg ? 'ok' : '')
  $('#publishAt').classList.toggle('invalid', Boolean(errors.publish) && (show || Boolean(plan.base)))

  if (plan.early && plan.relVal != null && !(plan.relVal > 0)) errors.release = 'El tiempo para liberar debe ser mayor que 0.'
  setHint('#batchReleaseHint', errors.release ||
    (plan.releaseOffset ? `Cada capítulo se libera ${amount(plan.relVal, plan.relUnit)} después de publicarse.` : 'Vacío = quedan anticipados hasta liberarlos desde el panel.'),
  errors.release ? 'error' : plan.releaseOffset ? 'ok' : '')
  $('#batchReleaseVal').classList.toggle('invalid', Boolean(errors.release))

  if (state.me && !state.me.key.scopes.includes('chapters:write')) errors.scope = 'La clave no tiene el permiso chapters:write.'
  if (!state.hasKey) errors.key = 'Configura tu API key.'
  $('#workTrigger').classList.toggle('invalid', show && Boolean(errors.work))

  renderBatchSummary(plan, errors)
  const ok = Object.keys(errors).length === 0
  $('#uploadBtn').disabled = state.uploading || (state.attempted && !ok)
  return { ok, errors, plan, queue }
}

function renderBatchSummary(plan, errors) {
  const queue = plan.queue
  const pages = queue.reduce((s, it) => s + it.files.length, 0)
  const allPages = batch.items.reduce((s, it) => s + it.files.length, 0)
  $('#batchCount').textContent = String(batch.items.length)
  $('#batchSummary').textContent = batch.items.length
    ? `${batch.items.length} capítulo${batch.items.length === 1 ? '' : 's'} · ${formatNumber(allPages)} páginas · ${formatBytes(batch.items.reduce((s, it) => s + sumSize(it.files), 0))} — arrastra ⠿ para reordenar.`
    : 'Una carpeta por capítulo. Se suben en el orden de la lista.'
  if (state.uploading) return

  const main = $('#summaryMain')
  const sub = $('#summarySub')
  const parts = []
  if (state.selectedWork) parts.push(state.selectedWork.title)
  if (queue.length) {
    const nums = queue.map((i) => i.number).filter((n) => n != null && !Number.isNaN(n))
    const range = nums.length ? ` (${Math.min(...nums)}–${Math.max(...nums)})` : ''
    parts.push(`${queue.length} capítulo${queue.length === 1 ? '' : 's'}${queue.length > 1 ? range : nums.length ? ` (#${nums[0]})` : ''}`)
    parts.push(`${formatNumber(pages)} pág.`)
  }
  main.textContent = parts.length ? parts.join(' · ') : 'Agrega las carpetas de los capítulos'

  const firstError = Object.values(errors)[0]
  if (state.attempted && firstError) {
    sub.textContent = firstError
    sub.className = 'summary-sub error'
    return
  }
  sub.className = 'summary-sub'
  let t = plan.schedule && plan.base
    ? `Programados desde ${formatDate(plan.base)}${queue.length > 1 ? (plan.step ? ` · uno ${every(plan.intervalVal, plan.unit)}` : ' · todos a la vez') : ''}`
    : 'Se publican conforme terminan de subirse'
  if (plan.early) t += plan.releaseOffset ? ` · Anticipados ${amount(plan.relVal, plan.relUnit)}` : ' · Anticipados (liberación manual)'
  else if (!plan.notify) t += ' · Sin avisos'
  if (queue.length > LIMIT_CHAPTERS_PER_HOUR || pages > LIMIT_IMAGES_PER_HOUR) {
    t += ` · Ojo: supera el límite por hora (${LIMIT_CHAPTERS_PER_HOUR} capítulos / ${formatNumber(LIMIT_IMAGES_PER_HOUR)} imágenes)`
  }
  sub.textContent = t
}

/* ---------- Render ---------- */

function statusInfo(it) {
  switch (it.status) {
    case 'uploading': return { cls: 'uploading', text: `Subiendo ${Math.round((it.progress || 0) * 100)}%` }
    case 'done': return { cls: 'done', text: 'Subido ✓' }
    case 'error': return { cls: 'error', text: 'Error' }
    default: return { cls: '', text: 'Pendiente' }
  }
}

function updateRowStatus(it) {
  if (!it.refs) return
  const s = statusInfo(it)
  it.refs.row.dataset.status = it.status
  it.refs.status.className = `ch-status ${s.cls}${it.status === 'done' && it.result?.url ? ' link' : ''}`
  it.refs.status.textContent = s.text
  it.refs.status.title = it.status === 'done' && it.result?.url ? 'Abrir en Capibara' : it.status === 'error' ? it.error : ''
  it.refs.progress.style.width = `${it.status === 'done' ? 100 : Math.round((it.progress || 0) * 100)}%`
  if (it.status === 'error') it.refs.error.textContent = it.error
}

function chapterRow(it) {
  const locked = state.uploading || it.status === 'done'
  const total = sumSize(it.files)
  const tooBig = it.files.filter((f) => f.size > MAX_BYTES).length

  const num = el('input', {
    type: 'number', step: 'any', min: '0', placeholder: '—', value: it.number ?? '', disabled: locked, title: 'Número de capítulo',
    oninput: (e) => { it.number = e.target.value === '' ? null : Number(e.target.value); batchValidate() },
  })
  const vol = el('input', {
    type: 'number', step: '1', min: '0', placeholder: '—', value: it.volume ?? '', disabled: locked, title: 'Tomo',
    oninput: (e) => { it.volume = e.target.value === '' ? null : Number(e.target.value); it.volumeAuto = false; batchValidate() },
  })
  const title = el('input', {
    type: 'text', maxlength: '256', placeholder: 'Título (opcional)', value: it.title, disabled: locked,
    oninput: (e) => { it.title = e.target.value.trim() },
  })
  const when = el('span', { class: 'when' })
  const error = el('div', { class: 'ch-error' })
  const status = el('span', {
    class: 'ch-status',
    onclick: () => { if (it.status === 'done' && it.result?.url) window.capi.system.openExternal(it.result.url) },
  })
  const progress = el('div')
  const handle = el('div', { class: 'ch-handle', html: ICON_GRIP, title: 'Arrastra para reordenar' })

  const row = el('li', { class: 'chrow', dataset: { id: it.id, status: it.status } },
    handle,
    el('div', { class: 'ch-cover', title: 'Ver páginas', onclick: () => openPagesModal(it) },
      it.files[0] ? el('img', { src: it.files[0].url, alt: '', loading: 'lazy', decoding: 'async' }) : null,
      el('span', { class: 'thumb-num', text: String(it.files.length) })),
    el('div', { class: 'ch-body' },
      el('div', { class: 'ch-fields' },
        el('label', { class: 'ch-field' }, el('span', { class: 'pre', text: 'Cap' }), num),
        el('label', { class: 'ch-field' }, el('span', { class: 'pre', text: 'Vol' }), vol),
        title),
      el('div', { class: 'ch-meta' },
        el('span', { class: 'folder', text: `📁 ${it.name}`, title: it.dir }),
        el('span', { class: 'sep' }),
        el('span', { text: `${it.files.length} pág. · ${formatBytes(total)}` }),
        countSingles(it.files) ? el('span', { class: 'singles', text: `${countSingles(it.files)} simple${countSingles(it.files) === 1 ? '' : 's'}` }) : null,
        featuredLabel(it.files) ? el('span', { class: 'featured', text: featuredLabel(it.files) }) : null,
        tooBig ? el('span', { class: 'bad', text: `${tooBig} > 40 MB` }) : null,
        el('span', { class: 'sep' }),
        when),
      error),
    el('div', { class: 'ch-side' },
      status,
      el('button', { type: 'button', class: 'icon-btn small ghost', title: 'Ver y ordenar páginas', html: ICON_PAGES, onclick: () => openPagesModal(it) }),
      el('button', { type: 'button', class: 'icon-btn small ghost', title: 'Quitar de la lista', html: ICONS.x, disabled: state.uploading, onclick: () => removeChapter(it.id) })),
    el('div', { class: 'ch-progress' }, progress),
  )

  // Solo se arrastra desde el asa, para no interferir con los campos de texto.
  handle.addEventListener('mousedown', () => { if (!locked) row.draggable = true })
  row.addEventListener('dragend', () => { row.draggable = false })

  it.refs = { row, num, vol, when, error, status, progress }
  updateRowStatus(it)
  return row
}

function renderBatch() {
  const list = $('#batchList')
  const has = batch.items.length > 0
  const dz = $('#batchDrop')
  dz.classList.toggle('empty', !has)
  dz.classList.toggle('has-files', has)
  $('#batchEmpty').hidden = has
  list.hidden = !has
  $('#batchToolbar').hidden = !has
  $('#batchClearDoneBtn').hidden = !batch.items.some((i) => i.status === 'done')

  list.innerHTML = ''
  batch.items.forEach((it) => list.append(chapterRow(it)))
  if (has && !state.uploading) {
    list.append(el('li', { class: 'add-row', onclick: pickChapters, html: `${ICONS.plus}<span>Agregar más carpetas</span>` }))
  }
}

/* ---------- Modal de páginas ---------- */

function openPagesModal(it) {
  batch.pmItem = it
  renderPm()
  $('#pagesModal').hidden = false
}

function closePagesModal() {
  if ($('#pagesModal').hidden) return
  $('#pagesModal').hidden = true
  batch.pmItem = null
  renderBatch()
  batchValidate()
}

function renderPm() {
  const it = batch.pmItem
  if (!it) return
  const locked = state.uploading || it.status === 'done'
  $('#pmTitle').textContent = `Capítulo ${it.number ?? '—'} · ${it.files.length} página${it.files.length === 1 ? '' : 's'}`
  $('#pmSub').textContent = locked
    ? `${it.name} — solo lectura.`
    : `${it.name} — arrastra para reordenar, doble clic para ver en grande.`
  $('#pmSort').disabled = locked
  const list = $('#pmThumbs')
  list.innerHTML = ''
  it.files.forEach((f, i) => {
    const big = f.size > MAX_BYTES
    list.append(el('li', {
      class: `thumb${big ? ' bad' : ''}${f.single ? ' single' : ''}${f.featured ? ' featured' : ''}`,
      draggable: locked ? 'false' : 'true',
      dataset: { index: i },
      title: f.name,
      ondblclick: () => openLightbox(i, it.files),
    },
    el('div', { class: 'thumb-img' },
      el('img', { src: f.url, alt: '', loading: 'lazy', decoding: 'async' }),
      el('span', { class: 'thumb-num', text: String(i + 1) }),
      locked ? null : el('button', {
        type: 'button', class: 'thumb-remove', title: 'Quitar', html: ICONS.x,
        onclick: (e) => {
          e.stopPropagation()
          if (it.files.length === 1) return toast('warn', 'El capítulo necesita al menos una página', 'Si no quieres subirlo, quítalo de la lista.')
          it.files.splice(i, 1)
          renderPm()
        },
      }),
      singleToggle(f, locked, renderPm),
      featuredToggle(f, it.files, locked, renderPm)),
    el('div', { class: 'thumb-meta' },
      el('span', { class: 'thumb-name', text: f.name }),
      el('span', { class: 'thumb-size', text: big ? `${formatBytes(f.size)} · supera 40 MB` : formatBytes(f.size) }))))
  })
}

function initPagesModal() {
  const list = $('#pmThumbs')
  let from = null
  const clear = () => $$('#pmThumbs .drop-before, #pmThumbs .drop-after').forEach((t) => t.classList.remove('drop-before', 'drop-after'))
  const target = (e) => {
    const li = e.target.closest('.thumb')
    if (!li) return null
    const r = li.getBoundingClientRect()
    const after = e.clientX > r.left + r.width / 2
    return { li, after, index: Number(li.dataset.index) + (after ? 1 : 0) }
  }
  list.addEventListener('dragstart', (e) => {
    const li = e.target.closest('.thumb')
    if (!li) return
    from = Number(li.dataset.index)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('application/x-capi-page', String(from))
    requestAnimationFrame(() => li.classList.add('dragging'))
  })
  list.addEventListener('dragend', () => { from = null; clear(); $$('#pmThumbs .dragging').forEach((t) => t.classList.remove('dragging')) })
  list.addEventListener('dragover', (e) => {
    if (from == null) return
    e.preventDefault()
    const t = target(e)
    clear()
    if (t) t.li.classList.add(t.after ? 'drop-after' : 'drop-before')
  })
  list.addEventListener('drop', (e) => {
    if (from == null) return
    e.preventDefault()
    const t = target(e)
    clear()
    const files = batch.pmItem.files
    if (t && from !== t.index && from + 1 !== t.index) {
      const [f] = files.splice(from, 1)
      files.splice(t.index > from ? t.index - 1 : t.index, 0, f)
      renderPm()
    }
    from = null
  })
  $('#pmSort').addEventListener('click', () => {
    batch.pmItem?.files.sort((a, b) => naturalCompare(a.name, b.name))
    renderPm()
  })
  $('#pmDone').addEventListener('click', closePagesModal)
  $('#pmClose').addEventListener('click', closePagesModal)
  $('#pagesModal').addEventListener('mousedown', (e) => { if (e.target.id === 'pagesModal') closePagesModal() })
  // Con el visor abierto encima, Escape solo debe cerrar el visor.
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#lightbox').hidden) closePagesModal() })
}

/* ---------- Zona de carpetas y reordenar capítulos ---------- */

function initBatchDrop() {
  const dz = $('#batchDrop')
  let depth = 0
  const isExternal = (e) => e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')

  dz.addEventListener('click', (e) => {
    if (!state.uploading && dz.classList.contains('empty') && !e.target.closest('button')) pickChapters()
  })
  dz.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target === dz) { e.preventDefault(); pickChapters() }
  })
  $('#batchPickBtn').addEventListener('click', (e) => { e.stopPropagation(); pickChapters() })
  $('#batchAddBtn').addEventListener('click', pickChapters)

  dz.addEventListener('dragenter', (e) => {
    if (!isExternal(e) || state.uploading) return
    e.preventDefault()
    depth++
    dz.classList.add('drag-over')
  })
  dz.addEventListener('dragleave', (e) => {
    if (!isExternal(e)) return
    depth = Math.max(0, depth - 1)
    if (!depth) dz.classList.remove('drag-over')
  })
  dz.addEventListener('dragover', (e) => {
    if (isExternal(e) && !state.uploading) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }
  })
  dz.addEventListener('drop', (e) => {
    if (!isExternal(e)) return
    e.preventDefault()
    depth = 0
    dz.classList.remove('drag-over')
    if (state.uploading) return
    addChapterPaths(Array.from(e.dataTransfer.files).map((f) => window.capi.files.pathFor(f)).filter(Boolean))
  })

  // Reordenar filas
  const list = $('#batchList')
  let from = null
  const clear = () => $$('.chrow.drop-before, .chrow.drop-after').forEach((r) => r.classList.remove('drop-before', 'drop-after'))
  const indexOf = (row) => batch.items.findIndex((i) => String(i.id) === row.dataset.id)
  list.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.chrow')
    if (!row) return
    from = indexOf(row)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('application/x-capi-chapter', String(from))
    requestAnimationFrame(() => row.classList.add('dragging'))
  })
  list.addEventListener('dragend', () => { from = null; clear(); $$('.chrow.dragging').forEach((r) => r.classList.remove('dragging')) })
  list.addEventListener('dragover', (e) => {
    if (from == null) return
    e.preventDefault()
    const row = e.target.closest('.chrow')
    clear()
    if (!row) return
    const r = row.getBoundingClientRect()
    row.classList.add(e.clientY > r.top + r.height / 2 ? 'drop-after' : 'drop-before')
  })
  list.addEventListener('drop', (e) => {
    if (from == null) return
    e.preventDefault()
    e.stopPropagation()
    const row = e.target.closest('.chrow')
    clear()
    if (row) {
      const r = row.getBoundingClientRect()
      moveChapter(from, indexOf(row) + (e.clientY > r.top + r.height / 2 ? 1 : 0))
    }
    from = null
  })

  $('#batchSortBtn').addEventListener('click', () => {
    batch.items.sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity) || naturalCompare(a.name, b.name))
    renderBatch()
    batchValidate()
  })
  $('#batchClearDoneBtn').addEventListener('click', () => {
    batch.items = batch.items.filter((i) => i.status !== 'done')
    renderBatch()
    batchValidate()
  })
  $('#batchClearBtn').addEventListener('click', batchReset)
}

/* ---------- Subida en cola ---------- */

async function batchStart() {
  state.attempted = true
  const v = batchValidate()
  if (!v.ok) {
    if (v.errors.key) return openKeyModal()
    const first = Object.keys(v.errors)[0]
    toast('warn', 'Revisa el formulario', v.errors[first])
    if (first === 'rows') $('.chrow.invalid')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    else if (first === 'work') $('#workTrigger').focus()
    else if (first === 'publish') $('#publishAt').focus()
    return
  }

  const work = state.selectedWork
  const { plan, queue } = v
  for (const it of queue) { it.status = 'pending'; it.error = ''; it.progress = 0 }
  batch.cancelled = false
  setUploadingUI(true)
  renderBatch()
  setProgress(0, 'Preparando…')
  $('#summaryMain').textContent = `Subiendo ${queue.length} capítulo${queue.length === 1 ? '' : 's'} de «${work.title}»`
  $('#summarySub').className = 'summary-sub'

  const totalBytes = queue.reduce((s, it) => s + sumSize(it.files), 0) || 1
  let bytesBefore = 0
  let current = null
  let pos = 0
  const label = () => `Capítulo ${pos + 1} de ${queue.length} (#${current.number})`

  const unsubscribe = window.capi.upload.onProgress((p) => {
    if (!current) return
    if (p.phase === 'upload') {
      current.progress = p.doneBytes / p.totalBytes
      updateRowStatus(current)
      setProgress(((bytesBefore + p.doneBytes) / totalBytes) * 100, `${label()} · páginas ${p.done}/${p.total}`)
    } else if (p.phase === 'create') {
      $('#progressText').textContent = `${label()} · creando capítulo…`
    } else if (p.phase === 'verify') {
      $('#progressText').textContent = `${label()} · verificando páginas simples…`
    } else if (p.phase === 'sign') {
      $('#progressText').textContent = `${label()} · preparando subida…`
    }
  })

  let ok = 0
  let failed = 0
  let stopped = false
  for (pos = 0; pos < queue.length; pos++) {
    if (batch.cancelled) { stopped = true; break }
    const it = queue[pos]
    current = it
    it.status = 'uploading'
    updateRowStatus(it)
    it.refs?.row.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    $('#summarySub').textContent = `${ok} subidos${failed ? ` · ${failed} con error` : ''} · quedan ${queue.length - pos}`

    const sched = plan.map.get(it.id) || {}
    const releaseAt = plan.releaseOffset
      ? new Date((sched.publishAt ? sched.publishAt.getTime() : Date.now()) + plan.releaseOffset)
      : null
    const res = await window.capi.upload.start({
      workId: work.id,
      files: it.files.map((f) => ({ path: f.path, single: Boolean(f.single) })),
      chapter: {
        number: it.number,
        title: it.title || null,
        volumeNumber: it.volume,
        publishAt: sched.publishAt ? sched.publishAt.toISOString() : null,
        earlyAccess: plan.early,
        releaseAt: releaseAt ? releaseAt.toISOString() : null,
        notify: plan.notify,
        announcePage: announcePageFor(it.files),
      },
    })
    bytesBefore += sumSize(it.files)

    if (res.ok) {
      it.status = 'done'
      it.result = res.data
      it.progress = 1
      ok++
      warnSingles(res.data.singleCheck, it.number)
      state.chapters.push({ number: it.number, volumeNumber: it.volume, state: res.data.state })
    } else if (res.error.code === 'cancelled') {
      it.status = 'pending'
      it.progress = 0
      stopped = true
    } else {
      it.status = 'error'
      it.error = res.error.message
      failed++
      if (res.error.code === 'api.key_invalid' || res.error.code === 'api.key_missing') {
        handleApiError(res.error, 'API key no válida')
        stopped = true
      }
    }
    updateRowStatus(it)
    if (stopped) break
  }

  unsubscribe()
  current = null
  setUploadingUI(false)
  state.attempted = false
  renderBatch()
  batchValidate()
  loadChapters()

  const pending = queue.filter((i) => i.status === 'pending').length
  if (!ok && !failed) {
    toast('info', 'Subida cancelada', 'Las páginas ya subidas se reutilizarán si vuelves a intentarlo pronto.')
    return
  }
  showBatchDone(work, plan, { ok, failed, pending, stopped })
}

function showBatchDone(work, plan, { ok, failed, pending }) {
  const mark = $('#doneModal .success-mark')
  const clean = !failed && !pending
  mark.classList.toggle('warn', !clean)
  mark.innerHTML = clean ? ICONS.check : ICONS.warn
  $('#doneTitle').textContent = clean
    ? `¡${ok} capítulo${ok === 1 ? '' : 's'} ${plan.schedule ? 'programado' : 'subido'}${ok === 1 ? '' : 's'}!`
    : ok ? 'Subida terminada con pendientes' : 'No se pudo subir ningún capítulo'
  const lines = [`«${work.title}»`]
  const parts = [`${ok} subido${ok === 1 ? '' : 's'}`]
  if (failed) parts.push(`${failed} con error`)
  if (pending) parts.push(`${pending} sin subir`)
  lines.push(parts.join(' · '))
  if (plan.schedule && plan.base) lines.push(`Programados desde el ${formatDate(plan.base)}${plan.step ? `, uno ${every(plan.intervalVal, plan.unit)}` : ''}`)
  if (failed || pending) lines.push('Corrige lo marcado en la lista y pulsa «Subir capítulos» para seguir solo con esos.')
  const text = $('#doneText')
  text.innerHTML = ''
  lines.forEach((l, i) => { if (i) text.append(el('br')); text.append(l) })
  state.lastResult = { url: work.url }
  $('#doneOpen').textContent = 'Ver obra en Capibara'
  $('#doneOpen').hidden = !work.url
  $('#doneNext').textContent = 'Listo'
  $('#doneModal').hidden = false
}

/* ---------- Modo ---------- */

function setMode(mode) {
  if (state.uploading) return
  state.mode = mode === 'batch' ? 'batch' : 'single'
  localStorage.setItem('mode', state.mode)
  document.body.classList.toggle('mode-batch', state.mode === 'batch')
  $$('#modeSwitch button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === state.mode)))
  $('#uploadBtnText').textContent = state.mode === 'batch' ? 'Subir capítulos' : 'Subir capítulo'
  state.attempted = false
  validate()
}

function initBatch() {
  initBatchDrop()
  initPagesModal()
  $$('#modeSwitch button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)))

  $('#batchVolume').addEventListener('input', () => { batch.volumeAuto = false; batchValidate() })
  $('#announceDefault').addEventListener('change', () => {
    renderThumbs()
    if (state.mode === 'batch') renderBatch()
    validate()
  })
  $('#renumberBtn').addEventListener('click', () => {
    const start = Number($('#renumberFrom').value)
    if ($('#renumberFrom').value.trim() === '' || Number.isNaN(start) || start < 0) {
      $('#renumberFrom').focus()
      return toast('warn', 'Indica desde qué número empezar')
    }
    let n = start
    let count = 0
    for (const it of batch.items) {
      if (it.status === 'done') continue
      it.number = n++
      count++
    }
    renderBatch()
    batchValidate()
    if (count) toast('success', 'Capítulos renumerados', `Del ${start} al ${n - 1}, en el orden de la lista.`)
  })
  ;['#batchInterval', '#batchReleaseVal'].forEach((s) => $(s).addEventListener('input', () => validate()))
  ;['#batchIntervalUnit', '#batchReleaseUnit'].forEach((s) => $(s).addEventListener('change', () => validate()))
  ;['#scheduleToggle', '#earlyToggle'].forEach((s) => $(s).addEventListener('change', () => validate()))

  $('#cancelBtn').addEventListener('click', () => { if (state.mode === 'batch') batch.cancelled = true })
  // Al cerrar el resumen, el modal vuelve a su forma de «un capítulo».
  $('#doneNext').addEventListener('click', () => {
    const mark = $('#doneModal .success-mark')
    mark.classList.remove('warn')
    mark.innerHTML = ICONS.check
    $('#doneOpen').textContent = 'Ver en Capibara'
    $('#doneNext').textContent = 'Subir otro capítulo'
  })

  renderBatch()
  setMode(localStorage.getItem('mode') || 'single')
}

initBatch()
