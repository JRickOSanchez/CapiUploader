'use strict'

/* =========================================================
   «Nueva obra»: crea la ficha de una obra en el scan activo con
   la API (permiso works:write). Busca la obra base para no
   duplicarla, recorta la portada y el banner a la medida exacta
   y, al terminar, recarga las obras y elige la nueva.
   Usa el estado y las utilidades globales de core.js.
   ========================================================= */
const nw = {
  catalog: null, // { types, demographies, genres, statuses, languages } del scan activo
  catalogScan: null,
  base: null, // obra base elegida de /catalog/works (o null: se crea una nueva)
  bases: [], // sugerencias para el título escrito
  authors: [], // [{ id, name }]
  genres: new Set(),
  images: { cover: null, banner: null }, // { bitmap, name, pos (0-100) }
  onCreated: null,
  createdAt: 0, // cuándo se creó la última obra desde esta ventana
  busy: false,
  seqBase: 0, // para descartar respuestas de búsquedas viejas
  seqAuthor: 0,
}

// Medida a la que se recorta cada imagen (la menor que acepta Capibara) y su peso máximo.
const NW_IMAGE = {
  cover: { w: 1200, h: 1800, maxBytes: 3 * 1024 * 1024, label: 'la portada' },
  banner: { w: 2300, h: 650, maxBytes: 4 * 1024 * 1024, label: 'el banner' },
}
const NW_CATEGORY = { GENRE: 'Géneros', THEME: 'Temas', FORMAT: 'Formato', CONTENT: 'Contenido' }
const canCreateWorks = () => Boolean(state.me?.key?.scopes?.includes('works:write'))

/* ---------- Abrir y cerrar ---------- */

/**
 * Abre el formulario. opts.title: título sugerido (p. ej. el de la web de «Importar de web»).
 * opts.onCreated(work): se llama con la obra ya cargada en la lista.
 */
async function openNewWork({ title = '', language = '', onCreated = null } = {}) {
  if (!isCapibara()) return openAltWork({ title, onCreated })
  if (!state.hasKey) return openKeyModal(true)
  if (state.me && !canCreateWorks()) {
    return toast('warn', 'Esta API key no puede crear obras', 'Necesita el permiso works:write. Crea una clave con ese permiso en la pestaña Claves del panel de tu scan (las claves no se editan) y agrégala en «Mis scans».', 10000)
  }
  if (nw.catalogScan !== state.activeScanId) {
    const res = await window.capi.works.catalog()
    if (!res.ok) {
      if (res.error.code === 'api.scope_missing') return toast('warn', 'Esta API key no puede crear obras', 'Necesita el permiso works:write.', 9000)
      return handleApiError(res.error, 'No se pudo abrir el formulario')
    }
    nw.catalog = res.data
    nw.catalogScan = state.activeScanId
  }
  nw.onCreated = onCreated
  nwReset(title, language || state.langFilter || 'es')
  $('#nwModal').hidden = false
  setTimeout(() => $('#nwTitle').focus(), 50)
  if (title) nwSearchBase()
}

function closeNewWork() {
  if (nw.busy) return
  $('#nwModal').hidden = true
  for (const img of Object.values(nw.images)) img?.bitmap.close()
  nw.images = { cover: null, banner: null }
}

function nwReset(title, language) {
  const c = nw.catalog
  nw.base = null
  nw.bases = []
  nw.authors = []
  nw.genres = new Set()
  nw.images = { cover: null, banner: null }
  $('#nwTitle').value = title
  $('#nwLang').value = language
  $('#nwAlt').value = ''
  $('#nwShort').value = ''
  $('#nwDesc').value = ''
  $('#nwStatus').value = 'ongoing'
  $('#nwNsfw').checked = false
  $('#nwPublish').checked = false
  $('#nwNotify').checked = true
  $('#nwNotifyOpt').hidden = true
  $('#nwAuthorSearch').value = ''
  $('#nwAuthorList').hidden = true
  const fill = (sel, items, value, label, placeholder) => {
    sel.innerHTML = ''
    sel.append(el('option', { value: '', text: placeholder }))
    for (const it of items) sel.append(el('option', { value: value(it), text: label(it) }))
  }
  fill($('#nwType'), c.types || [], (t) => t.code, (t) => t.name, 'Elige el tipo…')
  fill($('#nwDemo'), c.demographies || [], (d) => d.id, (d) => d.name, 'Elige la demografía…')
  $('#nwError').textContent = ''
  nwRenderBase()
  nwRenderAuthors()
  nwRenderGenres()
  nwRenderImage('cover')
  nwRenderImage('banner')
  nwCounters()
}

/* ---------- Obra base ---------- */

/** Busca en el catálogo de Capibara obras con ese título, para usar su ficha base en vez de duplicarla. */
const nwSearchBase = debounce(async () => {
  const q = $('#nwTitle').value.trim()
  const seq = ++nw.seqBase
  if (q.length < 2) { nw.bases = []; return nwRenderBase() }
  const res = await window.capi.works.searchBase(q)
  if (seq !== nw.seqBase) return
  nw.bases = res.ok ? res.data.slice(0, 5) : []
  nwRenderBase()
}, 400)

const nwTypeName = (code) => nw.catalog?.types?.find((t) => t.code === code)?.name || code || ''
const nwDemoName = (id) => nw.catalog?.demographies?.find((d) => d.id === id)?.name || ''
const nwHasLang = (b) => (b.yourWorks || []).find((w) => w.language === $('#nwLang').value)

function nwRenderBase() {
  const box = $('#nwBase')
  box.innerHTML = ''
  $('#nwNewBase').hidden = Boolean(nw.base)
  if (nw.base) {
    const b = nw.base
    box.hidden = false
    box.append(el('div', { class: 'nw-base-row chosen' },
      el('div', { class: 'work-text' },
        el('span', { class: 'work-title', text: `Usando la ficha de «${b.title}»` }),
        el('span', { class: 'work-meta', text: [nwTypeName(b.type), nwDemoName(b.demographyId), 'el tipo, la demografía y los autores salen de ahí'].filter(Boolean).join(' · ') })),
      el('button', { type: 'button', class: 'btn ghost small', onclick: () => { nw.base = null; nwRenderBase() } }, 'Crear otra')))
    return
  }
  const typed = normTitle($('#nwTitle').value)
  const list = nw.bases
  box.hidden = !list.length
  if (!list.length) return
  const same = list.find((b) => normTitle(b.title) === typed)
  box.append(el('p', { class: `nw-base-note${same ? ' warn' : ''}`, text: same
    ? 'Ya existe una obra con ese título en Capibara: usa su ficha (si la creas aparte, Capibara la rechaza).'
    : 'Obras parecidas que ya existen en Capibara. Si es una de ellas, usa su ficha:' }))
  for (const b of list) {
    const mine = nwHasLang(b)
    box.append(el('div', { class: 'nw-base-row' },
      el('div', { class: 'work-text' },
        el('span', { class: 'work-title', text: b.title, title: b.title }),
        el('span', { class: 'work-meta', text: [nwTypeName(b.type), nwDemoName(b.demographyId), mine ? 'tu scan ya la tiene en este idioma' : null].filter(Boolean).join(' · ') })),
      mine
        ? el('span', { class: 'badge', text: 'Ya es tuya' })
        : el('button', { type: 'button', class: 'btn secondary small', onclick: () => { nw.base = b; nwRenderBase() } }, 'Usar esta ficha')))
  }
}

/* ---------- Autores ---------- */

const nwSearchAuthors = debounce(async () => {
  const q = $('#nwAuthorSearch').value.trim()
  const list = $('#nwAuthorList')
  const seq = ++nw.seqAuthor
  if (q.length < 2) { list.hidden = true; return }
  const res = await window.capi.works.searchAuthors(q)
  if (seq !== nw.seqAuthor) return
  list.innerHTML = ''
  const found = res.ok ? res.data.filter((a) => !nw.authors.some((x) => x.id === a.id)) : []
  if (!found.length) list.append(el('li', { class: 'empty', text: res.ok ? 'No hay autores con ese nombre.' : res.error.message }))
  for (const a of found) {
    list.append(el('li', { onmousedown: (e) => { e.preventDefault(); nwAddAuthor(a) } }, a.name))
  }
  list.hidden = false
}, 300)

function nwAddAuthor(a) {
  if (nw.authors.length >= 10) return toast('warn', 'Máximo 10 autores')
  nw.authors.push({ id: a.id, name: a.name })
  $('#nwAuthorSearch').value = ''
  $('#nwAuthorList').hidden = true
  nwRenderAuthors()
  $('#nwAuthorSearch').focus()
}

function nwRenderAuthors() {
  const box = $('#nwAuthors')
  box.querySelectorAll('.nw-tag').forEach((t) => t.remove())
  const input = $('#nwAuthorSearch')
  for (const a of nw.authors) {
    box.insertBefore(el('span', { class: 'nw-tag' }, a.name,
      el('button', { type: 'button', title: 'Quitar', onclick: () => { nw.authors = nw.authors.filter((x) => x.id !== a.id); nwRenderAuthors() } }, '×')), input)
  }
  $('#nwAuthorCount').textContent = `${nw.authors.length}/10`
}

/* ---------- Géneros ---------- */

function nwRenderGenres() {
  const box = $('#nwGenres')
  box.innerHTML = ''
  const adult = $('#nwNsfw').checked
  const groups = new Map()
  for (const g of nw.catalog?.genres || []) {
    if (g.nsfw && !adult) { nw.genres.delete(g.id); continue } // los +18 solo en obras +18
    const cat = NW_CATEGORY[g.category] || 'Otros'
    if (!groups.has(cat)) groups.set(cat, [])
    groups.get(cat).push(g)
  }
  for (const [cat, list] of groups) {
    box.append(el('div', { class: 'nw-genre-group' },
      el('span', { class: 'nw-genre-cat', text: cat }),
      el('div', { class: 'nw-genre-chips' }, list.map((g) => el('button', {
        type: 'button', class: `chip${nw.genres.has(g.id) ? ' active' : ''}`, title: g.own ? 'Género propio de tu scan' : null,
        onclick: (e) => {
          if (!nw.genres.has(g.id) && nw.genres.size >= 30) return toast('warn', 'Máximo 30 géneros')
          nw.genres.has(g.id) ? nw.genres.delete(g.id) : nw.genres.add(g.id)
          e.currentTarget.classList.toggle('active', nw.genres.has(g.id))
          $('#nwGenreCount').textContent = `${nw.genres.size}/30`
        },
      }, g.name)))))
  }
  $('#nwGenreCount').textContent = `${nw.genres.size}/30`
}

/* ---------- Portada y banner ---------- */

async function nwPickImage(kind) {
  const res = await window.capi.works.pickImage(kind)
  if (!res.ok) return toast('error', 'No se pudo abrir la imagen', res.error.message)
  if (!res.data) return
  try {
    const bitmap = await createImageBitmap(new Blob([res.data.bytes], { type: res.data.type }))
    nw.images[kind]?.bitmap.close()
    nw.images[kind] = { bitmap, name: res.data.name, pos: 50 }
  } catch {
    return toast('error', 'No se pudo leer la imagen', 'Prueba con un JPG, PNG o WEBP.')
  }
  nwRenderImage(kind)
}

/** Recorte centrado (movible con `pos`) que llena w×h sin deformar la imagen. */
function nwCrop(bitmap, w, h, pos) {
  const scale = Math.max(w / bitmap.width, h / bitmap.height)
  const sw = w / scale
  const sh = h / scale
  const t = pos / 100
  return { sx: (bitmap.width - sw) * t, sy: (bitmap.height - sh) * t, sw, sh }
}

function nwDraw(canvas, img, w, h) {
  const { sx, sy, sw, sh } = nwCrop(img.bitmap, w, h, img.pos)
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img.bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
}

function nwRenderImage(kind) {
  const spec = NW_IMAGE[kind]
  const box = $(kind === 'cover' ? '#nwCoverBox' : '#nwBannerBox')
  const hint = $(kind === 'cover' ? '#nwCoverHint' : '#nwBannerHint')
  const img = nw.images[kind]
  box.innerHTML = ''
  hint.className = 'hint'
  if (!img) {
    box.append(el('button', { type: 'button', class: 'nw-image-empty', onclick: () => nwPickImage(kind) },
      el('span', { html: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-4.5-4.5L6 21"/></svg>' }),
      el('span', { text: `Elegir ${spec.label}` }),
      el('span', { class: 'muted', text: 'Opcional' })))
    hint.textContent = ''
    return
  }
  const preview = kind === 'cover' ? { w: 160, h: 240 } : { w: 340, h: 96 }
  const canvas = el('canvas', { width: preview.w * 2, height: preview.h * 2, class: 'nw-preview' })
  nwDraw(canvas, img, canvas.width, canvas.height)
  const { sw, sh } = nwCrop(img.bitmap, spec.w, spec.h, img.pos)
  const cropsX = sw < img.bitmap.width - 1
  const cropsY = sh < img.bitmap.height - 1
  const slider = cropsX || cropsY
    ? el('input', {
      type: 'range', min: '0', max: '100', value: String(img.pos), class: 'nw-pos',
      title: cropsX ? 'Mover el recorte a los lados' : 'Mover el recorte arriba o abajo',
      oninput: (e) => { img.pos = Number(e.target.value); nwDraw(canvas, img, canvas.width, canvas.height) },
    })
    : null
  box.append(canvas, el('div', { class: 'nw-image-actions' },
    slider,
    el('button', { type: 'button', class: 'btn ghost small', onclick: () => nwPickImage(kind) }, 'Cambiar'),
    el('button', { type: 'button', class: 'btn ghost small danger', onclick: () => { img.bitmap.close(); nw.images[kind] = null; nwRenderImage(kind) } }, 'Quitar')))
  const small = img.bitmap.width < spec.w || img.bitmap.height < spec.h
  hint.textContent = small
    ? `${img.name}: mide ${img.bitmap.width}×${img.bitmap.height}, se agranda a ${spec.w}×${spec.h} y puede verse borrosa.`
    : `${img.name} · se recorta a ${spec.w}×${spec.h}${slider ? '; mueve la barra para elegir qué parte queda' : ''}.`
  if (small) hint.classList.add('warn')
}

/** La imagen a la medida exacta, en JPG que no pase del peso máximo. */
async function nwExport(kind) {
  const img = nw.images[kind]
  if (!img) return null
  const spec = NW_IMAGE[kind]
  const canvas = new OffscreenCanvas(spec.w, spec.h)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, spec.w, spec.h)
  nwDraw(canvas, img, spec.w, spec.h)
  for (const quality of [0.92, 0.85, 0.75, 0.65, 0.5]) {
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality })
    if (blob.size <= spec.maxBytes) return new Uint8Array(await blob.arrayBuffer())
  }
  throw new Error(`No se pudo dejar ${spec.label} por debajo de ${spec.maxBytes / 1024 / 1024} MB.`)
}

/* ---------- Crear ---------- */

function nwCounters() {
  $('#nwTitleCount').textContent = `${$('#nwTitle').value.length}/256`
  $('#nwShortCount').textContent = `${$('#nwShort').value.length}/300`
}

function nwProblem() {
  if (!$('#nwTitle').value.trim()) return { field: '#nwTitle', text: 'Escribe el título de la obra.' }
  if (nw.base && nwHasLang(nw.base)) return { field: '#nwLang', text: 'Tu scan ya tiene esa obra en este idioma: elige otro idioma u otra ficha.' }
  if (!nw.base) {
    if (!$('#nwType').value) return { field: '#nwType', text: 'Elige el tipo de obra.' }
    if (!$('#nwDemo').value) return { field: '#nwDemo', text: 'Elige la demografía.' }
    if (!nw.authors.length) return { field: '#nwAuthorSearch', text: 'Agrega al menos un autor.' }
  }
  return null
}

async function nwCreate() {
  if (nw.busy) return
  const problem = nwProblem()
  if (problem) {
    $('#nwError').textContent = problem.text
    $(problem.field).focus()
    return
  }
  nw.busy = true
  const btn = $('#nwCreate')
  btn.disabled = true
  $('#nwCancel').disabled = true
  $('#nwError').textContent = ''
  btn.textContent = 'Preparando imágenes…'
  try {
    const [cover, banner] = await Promise.all([nwExport('cover'), nwExport('banner')])
    btn.textContent = 'Creando…'
    nw.createdAt = Date.now() // el aviso a las ventanas puede llegar antes que la respuesta
    const res = await window.capi.works.create({
      title: $('#nwTitle').value.trim(),
      language: $('#nwLang').value,
      alternativeTitle: $('#nwAlt').value.trim(),
      ...(nw.base
        ? { baseId: nw.base.id }
        : { type: $('#nwType').value, demographyId: Number($('#nwDemo').value), authorIds: nw.authors.map((a) => a.id) }),
      status: $('#nwStatus').value,
      genreIds: [...nw.genres],
      shortDescription: $('#nwShort').value.trim(),
      description: $('#nwDesc').value.trim(),
      isNSFW: $('#nwNsfw').checked,
      cover,
      banner,
      publish: $('#nwPublish').checked,
      notify: $('#nwNotify').checked,
    })
    if (!res.ok) {
      nw.createdAt = 0
      $('#nwError').textContent = withTrace(res.error)
      return
    }
    const { work, published, warning } = res.data
    nw.createdAt = Date.now()
    nw.busy = false
    closeNewWork()
    toast(warning ? 'warn' : 'success', `«${work.title}» creada${published ? ' y publicada' : ' (privada)'}`,
      warning || (published ? 'Ya puedes subirle capítulos.' : 'Ya puedes subirle capítulos; publícala desde el panel cuando esté lista.'), 9000)
    await loadWorks()
    const fresh = state.works.find((w) => w.id === work.id) || work
    if (nw.onCreated) await nw.onCreated(fresh)
  } catch (err) {
    $('#nwError').textContent = err.message
  } finally {
    nw.busy = false
    btn.disabled = false
    $('#nwCancel').disabled = false
    btn.textContent = 'Crear obra'
  }
}

/* ---------- Inicio ---------- */

function initNewWork() {
  $('#newWorkBtn').addEventListener('click', () => openNewWork({ onCreated: (w) => selectWork(w) }))
  $('#nwClose').addEventListener('click', closeNewWork)
  $('#nwCancel').addEventListener('click', closeNewWork)
  $('#nwCreate').addEventListener('click', nwCreate)
  $('#nwTitle').addEventListener('input', () => { nwCounters(); if (!nw.base) nwSearchBase() })
  $('#nwShort').addEventListener('input', nwCounters)
  $('#nwLang').addEventListener('change', nwRenderBase)
  $('#nwNsfw').addEventListener('change', nwRenderGenres)
  $('#nwPublish').addEventListener('change', (e) => { $('#nwNotifyOpt').hidden = !e.target.checked })
  $('#nwAuthorSearch').addEventListener('input', nwSearchAuthors)
  $('#nwAuthorSearch').addEventListener('blur', () => setTimeout(() => { $('#nwAuthorList').hidden = true }, 150))
  $('#nwAuthorSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !e.target.value && nw.authors.length) { nw.authors.pop(); nwRenderAuthors() }
    if (e.key === 'Enter') { e.preventDefault(); $('#nwAuthorList li:not(.empty)')?.dispatchEvent(new MouseEvent('mousedown')) }
  })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#nwModal').hidden) closeNewWork() })
}
