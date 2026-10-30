'use strict'

/* =========================================================
   Modo «Un capítulo»: páginas, visor, formulario y subida.
   ========================================================= */

/* =========================================================
   Páginas
   ========================================================= */
async function addPaths(paths) {
  if (!paths.length) return
  const res = await window.capi.files.resolve(paths)
  if (!res.ok) return toast('error', 'No se pudieron leer los archivos', res.error.message)
  addResolved(res.data)
}

function addResolved({ files, skipped, psd }) {
  const existing = new Set(state.files.map((f) => f.path))
  const fresh = files.filter((f) => !existing.has(f.path))
  const dupes = files.length - fresh.length
  const wasEmpty = state.files.length === 0
  const room = MAX_PAGES - state.files.length
  const accepted = fresh.slice(0, Math.max(0, room))
  state.files.push(...accepted.map((f) => ({ ...f, id: ++fileSeq, status: null })))
  if (wasEmpty) state.files.sort((a, b) => naturalCompare(a.name, b.name))

  if (skipped.length) toast('warn', `${skipped.length} archivo(s) ignorado(s)`, `Solo se aceptan JPG, PNG, WEBP, GIF, AVIF y PSD. ${skipped.slice(0, 3).join(', ')}${skipped.length > 3 ? '…' : ''}`)
  if (dupes) toast('info', `${dupes} imagen(es) ya estaban en la lista`)
  if (fresh.length > accepted.length) toast('warn', 'Límite de páginas', `Un capítulo admite como máximo ${MAX_PAGES} páginas.`)
  if (!files.length && !skipped.length) toast('warn', 'No se encontraron imágenes')
  reportPsd(psd)
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
    ? `${state.files.length} página${state.files.length === 1 ? '' : 's'} · ${formatBytes(total)}${singles ? ` · ${singles} simple${singles === 1 ? '' : 's'}` : ''}${featured >= 0 ? ` · destacada: pág. ${featured + 1}` : ''} — arrastra para reordenar${hasCap('singles') ? ', «Simple» para verla sola en doble página, ★ para destacarla' : ''}.`
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
  const publishRaw = $('#publishAt').value
  return {
    number: numRaw === '' ? null : Number(numRaw),
    volumeNumber: volRaw === '' ? null : Number(volRaw),
    title: $('#chTitle').value.trim(),
    publishAt: schedule && publishRaw ? new Date(publishRaw) : null,
    schedule,
    notify: $('#notifyToggle').checked,
    extra: $('#extraToggle').checked,
  }
}

function setHint(id, text, kind = '') {
  const h = $(id)
  h.textContent = text || ''
  h.className = `hint ${kind}`
}

function validate() {
  if (state.mode === 'batch') return batchValidate()
  const form = readForm()
  const errors = {}
  const show = state.attempted

  if (!state.selectedWork) errors.work = 'Selecciona una obra.'

  // Número (los extras llevan su propia numeración)
  const existing = usedNumbers(state.chapters, form.extra)
  // Reintento de una subida a varias que ya quedó en la plataforma activa: no cuenta como repetido.
  if (single.doneOn.has(state.platform)) existing.delete(form.number)
  $('#chNumberLabel').textContent = form.extra ? 'Número del extra' : 'Número de capítulo'
  if (form.number == null || Number.isNaN(form.number)) errors.number = form.extra ? 'Indica el número del extra.' : 'Indica el número del capítulo.'
  else if (form.number < 0) errors.number = 'El número no puede ser negativo.'
  else if (form.number >= EXTRA_BASE) errors.number = `El número debe ser menor que ${formatNumber(EXTRA_BASE)}.`
  else if (existing.has(form.number)) errors.number = `${form.extra ? 'El extra' : 'El capítulo'} ${form.number} ya existe en esta obra.`
  if (errors.number && (show || existing.has(form.number))) setHint('#chNumberHint', errors.number, 'error')
  else if (form.number != null && state.autoNumber && form.extra) setHint('#chNumberHint', 'Sugerido: siguiente extra. Se muestra como «Extra N».', '')
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

  // Páginas
  if (!state.files.length) errors.files = 'Agrega las páginas del capítulo.'
  else if (state.files.some((f) => f.size > MAX_BYTES)) errors.files = 'Hay imágenes de más de 40 MB.'

  $('#workTrigger').classList.toggle('invalid', show && Boolean(errors.work))
  $('#titleCounter').textContent = `${$('#chTitle').value.length}/256`

  // Permiso
  if (isCapibara() && state.me && !state.me.key.scopes.includes('chapters:write')) errors.scope = 'La clave no tiene el permiso chapters:write.'
  if (!state.hasKey) errors.key = isCapibara() ? 'Configura tu API key.' : `Inicia sesión en ${plat().full}.`

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
  if (form.number != null && !Number.isNaN(form.number)) parts.push(form.extra ? `Extra ${form.number}` : `Cap. ${form.number}`)
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
  if (!form.notify) when += ' · Sin avisos'
  sub.textContent = when
}

function initForm() {
  const schedule = $('#scheduleToggle')
  const refreshMins = () => {
    const min = toLocalInput(new Date(Date.now() + 2 * 60e3))
    $('#publishAt').min = min
    $('#publishAt').max = toLocalInput(new Date(Date.now() + 364 * 86400e3))
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

  $('#chNumber').addEventListener('input', () => { state.autoNumber = false; validate() })
  // Al marcar o desmarcar «extra», el número sugerido pasa a la otra numeración.
  $('#extraToggle').addEventListener('change', () => { state.autoNumber = true; applyChapterSuggestions(); validate() })
  $('#chVolume').addEventListener('input', () => { state.autoVolume = false; validate() })
  $('#publishAt').addEventListener('input', () => { refreshMins(); validate() })
  ;['#chTitle', '#notifyToggle'].forEach((s) => $(s).addEventListener('input', validate))
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
    $('#publishAt').value = ''
    $('#notifyToggle').checked = true
    $('#extraToggle').checked = false
    $('#scheduleToggle').dispatchEvent(new Event('change'))
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

/** Reintentos de «Un capítulo»: plataformas donde ya quedó (si se subía a varias). */
const single = { sig: null, doneOn: new Set() }

function setUploadingUI(on) {
  state.uploading = on
  document.body.classList.toggle('uploading', on)
  setViewBusy('upload', on)
  $('#progressWrap').hidden = !on
  $('#cancelBtn').hidden = !on
  $('#resetBtn').hidden = on
  $('#uploadBtn').disabled = on
  $('#uploadBtnText').textContent = on ? 'Subiendo…' : state.mode === 'batch' ? 'Subir capítulos' : 'Subir capítulo'
  $$('[data-pane="upload"] .column-form input, [data-pane="upload"] .column-form button, [data-pane="upload"] .column-form select, #pagesToolbar button, #dropzone button, #batchToolbar button, #batchDrop button, #batchList input, #batchList button').forEach((n) => {
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
    const focusMap = { work: '#workTrigger', number: '#chNumber', volume: '#chVolume', publish: '#publishAt', files: '#dropzone' }
    if (errors.key) return openKeyModal()
    $(focusMap[first] || '#uploadBtn')?.focus()
    toast('warn', 'Revisa el formulario', errors[first])
    return
  }

  const work = state.selectedWork
  if (!(await alsoReady([work.id]))) return
  // En un reintento solo se sube a las plataformas donde aún no quedó.
  const sig = `${state.platform}|${work.id}|${form.extra ? 'x' : ''}${form.number}|${state.files.map((f) => f.path).join('|')}`
  if (single.sig !== sig) { single.sig = sig; single.doneOn = new Set() }
  const targets = uploadTargets(work.id, single.doneOn)
  if (!targets) return toast('info', 'Ya está subido', 'Este capítulo ya quedó en todas las plataformas marcadas.')

  state.files.forEach((f) => { f.status = 'queued' })
  setUploadingUI(true)
  alsoProgressStart(targets)
  renderThumbs()
  setProgress(0, 'Preparando…')
  $('#summaryMain').textContent = `Subiendo «${state.selectedWork.title}» · ${form.extra ? 'Extra' : 'Cap.'} ${form.number}`
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
    else if (p.phase === 'convert') $('#progressText').textContent = `Convirtiendo a WebP ${p.done}/${p.total}…`
    else if (p.phase === 'platform') alsoProgress(p)
    else if (p.phase === 'done') setProgress(100, 'Listo')
  })

  const res = await window.capi.upload.start({
    ...targets,
    files: state.files.map((f) => ({ path: f.path, single: Boolean(f.single) })),
    chapter: {
      number: form.number,
      title: form.title || null,
      volumeNumber: form.volumeNumber,
      publishAt: form.publishAt ? form.publishAt.toISOString() : null,
      notify: form.notify,
      announcePage: announcePageFor(state.files),
      extra: form.extra,
    },
  })
  unsubscribe()
  setUploadingUI(false)

  if (!res.ok && res.error.results) okPlatforms(res.error.results).forEach((p) => single.doneOn.add(p))
  if (!res.ok) {
    if (res.error.results) res.error.message = `${res.error.message} (${resultsText(res.error.results)}). Al reintentar solo se sube a lo que falta.`
    state.files.forEach((f) => { if (f.status !== 'done') f.status = null })
    renderThumbs()
    validate()
    if (res.error.code === 'cancelled') {
      toast('info', 'Subida cancelada', 'Las páginas ya subidas se reutilizarán si vuelves a intentarlo pronto.')
      return
    }
    if (['api.conflict', 'api.chapter_exists', 'api.extra_exists'].includes(res.error.code)) {
      $('#chNumber').classList.add('invalid')
      setHint('#chNumberHint', res.error.message, 'error')
      $('#chNumber').focus()
    }
    $('#summarySub').className = 'summary-sub error'
    $('#summarySub').textContent = res.error.message
    handleApiError(res.error, 'No se pudo subir el capítulo')
    return
  }

  single.doneOn = new Set()
  single.sig = null
  state.lastResult = res.data
  showDone(res.data, form, work)
  if (res.data.results) toast('success', 'Subido a todas las plataformas', resultsText(res.data.results), 8000)
  warnSingles(res.data.singleCheck, form.extra ? `Extra ${form.number}` : `Cap. ${form.number}`)
  state.chapters.push({ number: res.data.number ?? form.number, extra: form.extra, extraNumber: form.extra ? form.number : null, volumeNumber: form.volumeNumber, state: res.data.state })
  loadChapters()
}

/** Avisa si la comprobación posterior no encontró las páginas simples como se pidieron. */
/** label: «Cap. 12», «Extra 2»… */
function warnSingles(check, label) {
  if (!check || check.ok) return
  toast('warn', `${label}: revisa las páginas simples`, check.error
    ? `El capítulo se subió, pero no se pudieron comprobar: ${check.error}`
    : `Se pidieron ${check.expected} y quedaron ${check.marked}. Corrígelas desde el panel.`, 10000)
}

function showDone(chapter, form, work) {
  const states = { published: 'Publicado', scheduled: 'Programado', early_access: 'Anticipado' }
  const lines = [`«${work.title}» · ${form.extra ? `Extra ${form.number}` : `Capítulo ${chapter.number ?? form.number}`}${form.title ? ` — ${form.title}` : ''}`]
  const singles = countSingles(state.files)
  const fl = featuredLabel(state.files)
  lines.push(`${state.files.length} páginas${singles ? ` (${singles} simple${singles === 1 ? '' : 's'})` : ''}${fl ? ` · destacada ${fl.replace('★ ', '')}` : ''} · ${states[chapter.state] || chapter.state || 'Creado'}`)
  if (form.publishAt) lines.push(`Se publica el ${formatDate(form.publishAt)}`)
  $('#doneTitle').textContent = form.publishAt ? '¡Capítulo programado!' : '¡Capítulo subido!'
  const text = $('#doneText')
  text.innerHTML = ''
  lines.forEach((l, i) => { if (i) text.append(el('br')); text.append(l) })
  $('#doneOpen').hidden = !chapter.url
  $('#doneOpen').textContent = `Ver en ${plat().label}`
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
