'use strict'

/* =========================================================
   «Nueva obra» en Crimson Scan y Mangation: la ficha con lo
   que pide cada una (Crimson: géneros por nombre, banner
   opcional; Mangation: demografía, géneros de su lista y
   portada obligatoria de hasta 5 MB). Las imágenes se mandan
   tal cual; el proceso principal convierte las de Crimson a WebP.
   ========================================================= */
const aw = {
  platform: null,
  genres: [], // [{ id, name }]
  chosen: new Set(),
  images: { cover: null, banner: null }, // { path, name, size, url }
  onCreated: null,
  createdAt: 0,
  busy: false,
}

const AW_LIMITS = { crimson: { title: 200, desc: 5000, genres: 20 }, mangation: { title: 180, desc: 10000, genres: 15 } }

function awOptions(select, list, value) {
  select.innerHTML = ''
  for (const o of list || []) select.append(el('option', { value: o.value, text: o.label, selected: o.value === value }))
}

async function openAltWork({ title = '', onCreated = null } = {}) {
  const p = state.platform
  if (!state.hasKey) return openAccountModal(p)
  const info = state.platformInfo?.[p]
  if (!info) return toast('error', 'No se pudo abrir el formulario', 'Vuelve a intentarlo en un momento.')
  aw.platform = p
  aw.onCreated = onCreated
  aw.chosen = new Set()
  aw.images = { cover: null, banner: null }
  const meta = plat(p)
  $('#altWorkModal').dataset.platform = p
  $('#altWorkMark').textContent = meta.mark
  $('#altWorkTitle').textContent = `Nueva obra en ${meta.full}`
  $('#altWorkSub').textContent = p === 'crimson'
    ? 'Se crea en tu scan de Crimson. La portada (2:3) y el banner se convierten a WebP solos.'
    : 'Se crea en tu cuenta de creador. Mangation pide portada (hasta 5 MB) y al menos un género.'
  $('#awTitle').value = title
  $('#awDesc').value = ''
  $('#awAdult').checked = false
  $('#awGenreSearch').value = ''
  $('#awError').textContent = ''
  awOptions($('#awType'), info.types, 'manga')
  awOptions($('#awStatus'), info.statuses, info.statuses?.[0]?.value)
  awOptions($('#awDemography'), [{ value: '', label: 'Sin demografía' }, ...(info.demographies || [])], '')
  $$('#altWorkModal [data-aw="demography"]').forEach((n) => { n.hidden = p !== 'mangation' })
  $('#awBanner').hidden = p !== 'crimson'
  $('#awCoverReq').textContent = p === 'mangation' ? 'obligatoria · máx. 5 MB' : '2:3 · recomendada'
  awRenderImage('cover')
  awRenderImage('banner')
  aw.genres = []
  awRenderGenres()
  awCounters()
  $('#altWorkModal').hidden = false
  setTimeout(() => $('#awTitle').focus(), 50)
  const res = await window.capi.platform.genres(p)
  if (aw.platform !== p) return
  if (!res.ok) { $('#awError').textContent = `No se pudieron cargar los géneros: ${res.error.message}`; return }
  aw.genres = res.data
  awRenderGenres()
}

function closeAltWork() {
  if (aw.busy) return
  $('#altWorkModal').hidden = true
  aw.platform = null
}

function awRenderImage(kind) {
  const img = aw.images[kind]
  const tag = $(kind === 'cover' ? '#awCoverImg' : '#awBannerImg')
  tag.hidden = !img
  if (img) tag.src = img.url
  else tag.removeAttribute('src')
}

function awCounters() {
  const lim = AW_LIMITS[aw.platform] || AW_LIMITS.crimson
  $('#awTitleCount').textContent = `${$('#awTitle').value.length}/${lim.title}`
  $('#awDescCount').textContent = `${$('#awDesc').value.length}/${lim.desc}`
  $('#awGenreCount').textContent = `${aw.chosen.size}/${lim.genres}`
}

function awRenderGenres() {
  const box = $('#awGenres')
  box.innerHTML = ''
  if (!aw.genres.length) { box.append(el('span', { class: 'hint', text: 'Cargando géneros…' })); return }
  const q = normTitle($('#awGenreSearch').value)
  for (const g of aw.genres) {
    const on = aw.chosen.has(g.id)
    if (q && !on && !normTitle(g.name).includes(q)) continue
    box.append(el('button', {
      type: 'button', class: `chip${on ? ' active' : ''}`, text: g.name, 'aria-pressed': String(on),
      onclick: () => {
        const lim = AW_LIMITS[aw.platform].genres
        if (!on && aw.chosen.size >= lim) return toast('info', `Hasta ${lim} géneros`, 'Quita alguno para elegir otro.')
        if (on) aw.chosen.delete(g.id)
        else aw.chosen.add(g.id)
        awRenderGenres()
        awCounters()
      },
    }))
  }
}

async function awPick(kind) {
  const res = await window.capi.platform.pickImage(kind)
  if (!res.ok) return toast('error', 'No se pudo usar esa imagen', res.error.message)
  if (!res.data) return
  if (aw.platform === 'mangation' && kind === 'cover' && res.data.size > 5 * 1024 * 1024) {
    return toast('warn', 'La portada pesa más de 5 MB', 'Mangation acepta portadas de hasta 5 MB. Elige otra o redúcela.')
  }
  aw.images[kind] = res.data
  awRenderImage(kind)
}

async function awCreate() {
  if (aw.busy) return
  const p = aw.platform
  const lim = AW_LIMITS[p]
  const title = $('#awTitle').value.trim()
  const err = !title ? 'Escribe el título de la obra.'
    : title.length > lim.title ? `El título admite hasta ${lim.title} caracteres.`
      : $('#awDesc').value.length > lim.desc ? `La sinopsis admite hasta ${lim.desc} caracteres.`
        : p === 'mangation' && !aw.chosen.size ? 'Mangation pide al menos un género.'
          : p === 'mangation' && !aw.images.cover ? 'Mangation pide una portada.'
            : ''
  if (err) { $('#awError').textContent = err; return }
  $('#awError').textContent = ''
  aw.busy = true
  const btn = $('#awSave')
  btn.disabled = true
  $('#awCancel').disabled = true
  btn.textContent = 'Creando…'
  // Antes de pedirla: el aviso «obra nueva» a las ventanas puede llegar antes que la respuesta.
  aw.createdAt = Date.now()
  try {
    const res = await window.capi.platform.createWork(p, {
      title,
      type: $('#awType').value,
      status: $('#awStatus').value,
      demography: $('#awDemography').value,
      description: $('#awDesc').value.trim(),
      genres: [...aw.chosen],
      adult: $('#awAdult').checked,
    }, {
      cover: aw.images.cover ? { path: aw.images.cover.path } : null,
      banner: aw.images.banner ? { path: aw.images.banner.path } : null,
    })
    if (!res.ok) { aw.createdAt = 0; $('#awError').textContent = res.error.message; return }
    aw.createdAt = Date.now()
    aw.busy = false
    closeAltWork()
    const warn = res.data.warnings?.join(' ')
    toast(warn ? 'warn' : 'success', `«${title}» creada en ${plat(p).full}`, warn || 'Ya puedes subirle capítulos.', 9000)
    if (p !== state.platform) return
    await loadWorks()
    const fresh = state.works.find((w) => String(w.id) === String(res.data.id))
    if (fresh && aw.onCreated) await aw.onCreated(fresh)
  } finally {
    aw.busy = false
    btn.disabled = false
    $('#awCancel').disabled = false
    btn.textContent = 'Crear obra'
  }
}

function initAltWork() {
  $('#awCover').addEventListener('click', () => awPick('cover'))
  $('#awBanner').addEventListener('click', () => awPick('banner'))
  $('#awCancel').addEventListener('click', closeAltWork)
  $('#awSave').addEventListener('click', awCreate)
  $('#awTitle').addEventListener('input', awCounters)
  $('#awDesc').addEventListener('input', awCounters)
  $('#awGenreSearch').addEventListener('input', awRenderGenres)
  $('#altWorkModal').addEventListener('mousedown', (e) => { if (e.target.id === 'altWorkModal') closeAltWork() })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#altWorkModal').hidden) closeAltWork() })
}
