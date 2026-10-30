'use strict'

/* =========================================================
   «Capítulos subidos»: lista por scan de lo que ya salió de la cola
   y arreglos con la API (número, publicar, papelera).
   ========================================================= */

/* ---------- Capítulos subidos (se guardan por scan) ---------- */

const UPLOADED_MAX = 1000
// Una lista por scan de Capibara y otra por cada plataforma (Crimson, Mangation).
const uploadedKey = () => `uploaded:${accountKey()}`

function loadUploaded() {
  if (batch.uploadedScan === accountKey()) return
  batch.uploadedScan = accountKey()
  batch.uploaded = []
  if (accountKey() != null) {
    try { batch.uploaded = JSON.parse(localStorage.getItem(uploadedKey()) || '[]') } catch { batch.uploaded = [] }
  }
  renderUploaded()
}

function saveUploaded() {
  if (batch.uploaded.length > UPLOADED_MAX) batch.uploaded.length = UPLOADED_MAX
  if (accountKey() == null) return
  try { localStorage.setItem(uploadedKey(), JSON.stringify(batch.uploaded)) } catch { /* sin espacio: queda solo en memoria */ }
}

/**
 * Agrega al inicio; si el mismo capítulo de la misma obra ya estaba en la lista, lo reemplaza.
 * Un «Ya estaba publicado» no reemplaza al registro de cuando lo subió el programa.
 */
function pushUploaded(entry) {
  const same = (e) => e.workId === entry.workId && e.number === entry.number && Boolean(e.extra) === Boolean(entry.extra)
  if (entry.kind === 'existing' && batch.uploaded.some((e) => same(e) && e.kind === 'uploaded')) return
  batch.uploaded = batch.uploaded.filter((e) => !same(e))
  batch.uploaded.unshift(entry)
}

/**
 * kind: 'uploaded' (lo subió el programa; data = respuesta de la API), 'existing' (data = capítulo
 * publicado) o 'trashed' (se mandó a la papelera desde esta lista; trashedFrom guarda el anterior).
 */
function uploadedEntry(it, data, kind) {
  const existing = kind === 'existing'
  return {
    kind,
    at: new Date().toISOString(),
    chapterId: data.id ?? null,
    workId: it.workId,
    workTitle: workById(it.workId)?.title || '',
    number: existing ? shownNumber(data) : it.number,
    extra: existing ? isExtra(data) : Boolean(it.extra),
    volume: existing ? data.volumeNumber ?? null : it.volume ?? null,
    title: (existing ? data.title : it.title) || '',
    folder: it.name,
    dir: it.dir,
    pages: it.files.length,
    remotePages: existing ? data.pages ?? null : null,
    state: data.state || null,
    publishAt: data.publishAt || null,
    url: data.url || null,
    thumb: it.files[0]?.url || null,
  }
}

function uploadedStatus(e) {
  if (e.kind === 'trashed') return { cls: 'trashed', text: isCapibara() ? 'En la papelera' : 'Borrado' }
  if (e.kind === 'existing') return { cls: 'existing', text: 'Ya estaba publicado' }
  if (e.state === 'scheduled' && e.publishAt) return { cls: 'scheduled', text: `Programado · ${formatDate(new Date(e.publishAt))}` }
  return { cls: 'done', text: 'Publicado' }
}

function uploadedRow(e) {
  const st = uploadedStatus(e)
  const pagesDiffer = e.remotePages != null && e.remotePages !== e.pages
  return el('li', { class: `uprow${e.kind === 'trashed' ? ' trashed' : ''}` },
    el('div', { class: 'up-cover' }, e.thumb ? el('img', { src: e.thumb, alt: '', loading: 'lazy', decoding: 'async', onerror: (ev) => ev.target.remove() }) : null),
    el('div', { class: 'up-body' },
      el('div', { class: 'up-title' },
        el('b', { text: chapterLabel(e.number, e.extra) }),
        e.volume != null ? el('span', { class: 'up-vol', text: `· Vol ${e.volume}` }) : null,
        e.title ? el('span', { class: 'up-name', text: `— ${e.title}` }) : null,
        el('span', { class: 'up-work', text: e.workTitle })),
      el('div', { class: 'ch-meta' },
        el('span', { class: 'folder', text: `📁 ${e.folder}`, title: e.dir }),
        el('span', { class: 'sep' }),
        el('span', { class: pagesDiffer ? 'bad' : '', text: pagesDiffer ? `${e.pages} pág. aquí · ${e.remotePages} en ${plat().label}` : `${e.pages} pág.` }),
        el('span', { class: 'sep' }),
        el('span', { text: relativeFromNow(new Date(e.at)), title: formatDate(new Date(e.at)) }))),
    el('span', { class: `up-status ${st.cls}`, text: st.text }),
    e.url && e.kind !== 'trashed'
      ? el('button', { type: 'button', class: 'icon-btn small ghost', title: `Abrir en ${plat().label}`, html: ICON_OPEN, onclick: () => window.capi.system.openExternal(e.url) })
      : el('span', { class: 'up-noop' }),
    el('button', {
      type: 'button', class: 'icon-btn small ghost', html: ICON_MORE, onclick: () => uploadedActions(e),
      title: e.kind === 'trashed' ? 'Restaurar o volver a subir' : isCapibara() ? 'Cambiar número, publicar ya o mandar a la papelera' : 'Cambiar número o borrar',
    }))
}

function renderUploaded() {
  const card = $('#uploadedCard')
  const n = batch.uploaded.length
  card.hidden = !n
  $('#uploadedCount').textContent = formatNumber(n)
  const existing = batch.uploaded.filter((e) => e.kind === 'existing').length
  const trashed = batch.uploaded.filter((e) => e.kind === 'trashed').length
  const parts = [
    n - existing - trashed ? plural(n - existing - trashed, 'subido con el programa', 'subidos con el programa') : '',
    existing ? plural(existing, 'omitido porque ya estaba publicado', 'omitidos porque ya estaban publicados') : '',
    trashed ? (isCapibara() ? plural(trashed, 'en la papelera', 'en la papelera') : plural(trashed, 'borrado', 'borrados')) : '',
  ].filter(Boolean)
  $('#uploadedSummary').textContent = `${existing || trashed ? `${parts.join(' · ')}. ` : 'Salen de la cola al terminar de subirse. '}Se guardan aunque cierres el programa.`
  card.classList.toggle('collapsed', !batch.uploadedOpen)
  $('#uploadedToggle span').textContent = batch.uploadedOpen ? 'Ocultar' : 'Mostrar'
  const list = $('#uploadedList')
  list.innerHTML = ''
  list.hidden = !batch.uploadedOpen
  if (batch.uploadedOpen) batch.uploaded.forEach((e) => list.append(uploadedRow(e)))
}

function initUploaded() {
  $('#uploadedToggle').addEventListener('click', () => {
    batch.uploadedOpen = !batch.uploadedOpen
    localStorage.setItem('uploadedOpen', batch.uploadedOpen ? '1' : '0')
    renderUploaded()
  })
  $('#uploadedClear').addEventListener('click', async () => {
    const choice = await ask({
      kind: 'warn',
      title: '¿Vaciar la lista de subidos?',
      text: `Solo se borra esta lista del programa. Los capítulos siguen en ${plat().label}.`,
      buttons: [{ value: 'no', label: 'Cancelar', cancel: true }, { value: 'yes', label: 'Vaciar', kind: 'danger-solid' }],
    })
    if (choice !== 'yes') return
    batch.uploaded = []
    saveUploaded()
    renderUploaded()
  })
  loadUploaded()
}

/* ---------- Arreglar un capítulo de la lista de subidos ---------- */

const ICON_MORE = '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>'

/** El id del capítulo en Capibara; las entradas de la 1.3.1 no lo guardaban y se busca por número. */
async function uploadedChapterId(e) {
  if (e.chapterId) return e.chapterId
  const list = await ensureChapters(e.workId)
  const found = list?.find((c) => isExtra(c) === Boolean(e.extra) && shownNumber(c) === Number(e.number))
  if (found) e.chapterId = found.id
  return found?.id || null
}

/** Tras un cambio en Capibara: se guarda la lista y se vuelven a leer los capítulos de la obra. */
function afterUploadedChange(e) {
  saveUploaded()
  renderUploaded()
  ensureChapters(e.workId, { force: true }).then(() => { renderBatch(); batchValidate() })
  if (state.selectedWork?.id === e.workId) loadChapters()
}

async function uploadedActions(e) {
  if (state.uploading) return toast('info', 'Espera a que termine la subida', 'Después podrás arreglar este capítulo.')
  if (!isCapibara()) return altUploadedActions(e)
  if (!canWrite(state.me?.key)) return toast('warn', 'No se puede cambiar', 'Esta API key no tiene el permiso chapters:write.')
  const name = `${chapterLabel(e.number, e.extra)} de «${e.workTitle || 'la obra'}»`

  if (e.kind === 'trashed') {
    const choice = await ask({
      kind: 'info',
      title: `${name} está en la papelera`,
      text: 'Se puede restaurar durante 30 días desde que se mandó a la papelera. Si quieres subir otra versión, vuelve a poner su carpeta en la cola.',
      buttons: [
        { value: 'close', label: 'Cerrar', cancel: true },
        ...(e.dir ? [{ value: 'requeue', label: 'Poner su carpeta en la cola' }] : []),
        { value: 'restore', label: 'Restaurar', kind: 'primary' },
      ],
    })
    if (choice === 'restore') return restoreUploaded(e)
    if (choice === 'requeue') return requeueUploaded(e)
    return
  }

  const id = await uploadedChapterId(e)
  if (!id) return toast('error', 'No se encontró el capítulo', `${name} ya no está en Capibara (¿lo borraron desde el panel?).`)
  const scheduled = e.state === 'scheduled'
  const pagesDiffer = e.remotePages != null && e.remotePages !== e.pages
  const choice = await ask({
    kind: 'info',
    title: name,
    text: [
      e.kind === 'existing' ? 'Ya estaba publicado en Capibara cuando agregaste su carpeta.' : `Lo subió el programa ${relativeFromNow(new Date(e.at))}.`,
      pagesDiffer ? `Ojo: la carpeta tiene ${e.pages} páginas y el de Capibara ${e.remotePages}.` : '',
      'Los cambios no avisan a nadie.',
    ].filter(Boolean).join(' '),
    buttons: [
      { value: 'close', label: 'Cerrar', cancel: true },
      { value: 'trash', label: 'Mandar a la papelera', kind: 'ghost danger' },
      ...(scheduled ? [{ value: 'publish', label: 'Publicar ya' }] : []),
      { value: 'number', label: 'Cambiar número', kind: 'primary' },
    ],
  })
  if (choice === 'number') return renumberUploaded(e, id)
  if (choice === 'publish') return publishUploaded(e, id)
  if (choice === 'trash') return trashUploaded(e, id)
}

/**
 * Crimson y Mangation: no tienen papelera ni «publicar ya». Crimson deja cambiar el número y borrar;
 * Mangation, borrar. Borrar no se puede deshacer, así que se pide confirmación.
 */
async function altUploadedActions(e) {
  const name = `${chapterLabel(e.number, false)} de «${e.workTitle || 'la obra'}»`
  if (e.kind === 'trashed') {
    if (!e.dir) return toast('info', `${name} se borró`, `Ya no está en ${plat().label}.`)
    const c = await ask({ kind: 'info', title: `${name} se borró`, text: 'Si quieres subirlo otra vez, vuelve a poner su carpeta en la cola.', buttons: [{ value: 'close', label: 'Cerrar', cancel: true }, { value: 'requeue', label: 'Poner su carpeta en la cola', kind: 'primary' }] })
    if (c === 'requeue') requeueUploaded(e)
    return
  }
  const id = await uploadedChapterId(e)
  if (!id) return toast('error', 'No se encontró el capítulo', `${name} ya no está en ${plat().label} (¿lo borraron desde su panel?).`)
  const canRenumber = state.platform === 'crimson'
  const choice = await ask({
    kind: 'info',
    title: name,
    text: e.kind === 'existing' ? `Ya estaba en ${plat().label} cuando agregaste su carpeta.` : `Lo subió el programa ${relativeFromNow(new Date(e.at))}.`,
    buttons: [
      { value: 'close', label: 'Cerrar', cancel: true },
      { value: 'delete', label: 'Borrar', kind: canRenumber ? 'ghost danger' : 'danger-solid' },
      ...(canRenumber ? [{ value: 'number', label: 'Cambiar número', kind: 'primary' }] : []),
    ],
  })
  if (choice === 'number') return renumberUploaded(e, id)
  if (choice !== 'delete') return
  const sure = await ask({
    kind: 'warn',
    title: `¿Borrar ${name}?`,
    text: `Se borra de ${plat().full} con sus páginas y no se puede deshacer (no hay papelera).`,
    buttons: [{ value: 'no', label: 'Cancelar', cancel: true, focus: true }, { value: 'yes', label: 'Borrar', kind: 'danger-solid' }],
  })
  if (sure !== 'yes') return
  const res = await window.capi.platform.deleteChapter(state.platform, e.workId, id)
  if (!res.ok) return handleApiError(res.error, `No se pudo borrar ${chapterLabel(e.number, false).toLowerCase()}`)
  e.trashedFrom = e.kind
  e.kind = 'trashed'
  e.trashedAt = new Date().toISOString()
  toast('success', `${chapterLabel(e.number, false)} borrado`, `«${e.workTitle}»`)
  afterUploadedChange(e)
}

async function renumberUploaded(e, id) {
  const r = await ask({
    kind: 'info',
    title: `Cambiar el número ${e.extra ? 'del extra' : 'del cap'} ${e.number}`,
    text: `«${e.workTitle}». Si ${e.extra ? 'ese extra' : 'ese número'} ya existe en la obra, ${plat().label} no deja cambiarlo.`,
    input: { label: 'Número nuevo', value: String(e.number), type: 'number' },
    buttons: [{ value: 'no', label: 'Cancelar', cancel: true }, { value: 'yes', label: 'Cambiar', kind: 'primary' }],
  })
  if (r.value !== 'yes') return
  const n = Number(String(r.input).replace(',', '.'))
  if (r.input === '' || !Number.isFinite(n) || n < 0) return toast('warn', 'Número no válido', 'Escribe un número, por ejemplo 12 o 12.5.')
  if (n === Number(e.number)) return
  const res = isCapibara() ? await window.capi.chapter.setNumber(id, n) : await window.capi.platform.renumberChapter(state.platform, e.workId, id, n)
  if (!res.ok) return handleApiError(res.error, `No se pudo cambiar ${e.extra ? 'el extra' : 'el cap'} ${e.number}`)
  const old = e.number
  // Otra entrada de la lista con ese número en la obra era de un capítulo que ya no lo tiene.
  batch.uploaded = batch.uploaded.filter((x) => x === e || !(x.workId === e.workId && Boolean(x.extra) === Boolean(e.extra) && Number(x.number) === n && x.kind !== 'trashed'))
  e.number = n
  if (res.data?.url) e.url = res.data.url
  toast('success', `${chapterLabel(old, e.extra)} → ${chapterLabel(n, e.extra).toLowerCase()}`, `«${e.workTitle}»`)
  afterUploadedChange(e)
}

async function publishUploaded(e, id) {
  const choice = await ask({
    kind: 'info',
    title: `¿Publicar ya ${e.extra ? 'el extra' : 'el cap'} ${e.number}?`,
    text: `«${e.workTitle}» estaba programado${e.publishAt ? ` para el ${formatDate(new Date(e.publishAt))}` : ''}.`,
    buttons: [
      { value: 'no', label: 'Cancelar', cancel: true },
      { value: 'quiet', label: 'Publicar sin avisos' },
      { value: 'notify', label: 'Publicar y avisar', kind: 'primary' },
    ],
  })
  if (choice !== 'quiet' && choice !== 'notify') return
  const res = await window.capi.chapter.publish(id, { notify: choice === 'notify' })
  if (!res.ok) return handleApiError(res.error, `No se pudo publicar ${chapterLabel(e.number, e.extra).toLowerCase()}`)
  e.state = 'published'
  e.publishAt = null
  toast('success', `${chapterLabel(e.number, e.extra)} publicado`, choice === 'notify' ? 'Salieron los avisos de siempre.' : 'Sin avisos.')
  afterUploadedChange(e)
}

async function trashUploaded(e, id) {
  const choice = await ask({
    kind: 'warn',
    title: `¿Mandar ${e.extra ? 'el extra' : 'el cap'} ${e.number} a la papelera?`,
    text: `«${e.workTitle}». Deja de verse en Capibara y su número queda libre. Se puede restaurar durante 30 días, aquí o desde el panel.`,
    buttons: [{ value: 'no', label: 'Cancelar', cancel: true, focus: true }, { value: 'yes', label: 'Mandar a la papelera', kind: 'danger-solid' }],
  })
  if (choice !== 'yes') return
  const res = await window.capi.chapter.trash(id)
  if (!res.ok) return handleApiError(res.error, `No se pudo borrar ${chapterLabel(e.number, e.extra).toLowerCase()}`)
  e.trashedFrom = e.kind
  e.kind = 'trashed'
  e.trashedAt = new Date().toISOString()
  toast('success', `${chapterLabel(e.number, e.extra)} en la papelera`, 'Puedes restaurarlo o volver a poner su carpeta en la cola desde esta lista.')
  afterUploadedChange(e)
}

async function restoreUploaded(e) {
  const id = e.chapterId
  if (!id) return toast('error', 'No se puede restaurar desde aquí', 'Restáuralo desde la papelera del panel.')
  const res = await window.capi.chapter.restore(id)
  if (!res.ok) return handleApiError(res.error, `No se pudo restaurar ${chapterLabel(e.number, e.extra).toLowerCase()}`)
  e.kind = e.trashedFrom || 'uploaded'
  delete e.trashedFrom
  delete e.trashedAt
  toast('success', `${chapterLabel(e.number, e.extra)} restaurado`, `«${e.workTitle}»`)
  afterUploadedChange(e)
}

/** Vuelve a poner la carpeta en la cola, con su obra; la entrada sale de la lista de subidos. */
async function requeueUploaded(e) {
  const res = await window.capi.files.resolveChapters([e.dir])
  if (!res.ok) return toast('error', 'No se pudo leer la carpeta', res.error.message)
  if (!res.data.chapters.length) return toast('warn', 'La carpeta ya no tiene páginas', e.dir)
  batch.uploaded = batch.uploaded.filter((x) => x !== e)
  saveUploaded()
  renderUploaded()
  await addChapters(res.data, { workId: e.workId })
}

/** La obra elegida arriba es la predeterminada para lo que no tenga obra. */
async function batchOnWorkSelected(work) {
  if (!work) return
  const orphans = pendingItems().filter((i) => i.workId == null)
  if (orphans.length) await assignWork(orphans, work)
}
