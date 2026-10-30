'use strict'

/* =========================================================
   «También a…»: subir el mismo capítulo a la vez a otras
   plataformas (opcional). Cada obra de la plataforma activa se
   empareja con su obra en las otras (por título, y se recuerda).
   El proceso principal lee y convierte las páginas una sola vez;
   si una plataforma falla, al reintentar solo se sube a esa.
   ========================================================= */

const also = {
  on: {}, // plataforma → marcada
  works: {}, // plataforma → obras (caché de la sesión)
  loading: {}, // plataforma → Promise
  failed: {}, // plataforma → mensaje si no se pudieron cargar sus obras
  progress: {}, // plataforma → { status, percent, message }
}

const alsoOnKey = () => `also:${state.platform}`
const alsoMapKey = (p) => `alsoMap:${state.platform}:${accountKey()}:${p}`
const otherPlatforms = () => PLATFORM_IDS.filter((p) => p !== state.platform)

function alsoMap(p) {
  try { return JSON.parse(localStorage.getItem(alsoMapKey(p)) || '{}') } catch { return {} }
}
function setAlsoMap(p, workId, targetId) {
  const m = alsoMap(p)
  if (targetId == null) delete m[workId]
  else m[workId] = targetId
  localStorage.setItem(alsoMapKey(p), JSON.stringify(m))
}

/** Plataformas marcadas (además de la activa) que tienen con qué subir. */
const alsoActive = () => otherPlatforms().filter((p) => also.on[p] && isConnected(p))

/** Título para emparejar obras entre plataformas: sin acentos, signos ni mayúsculas. */
const matchTitle = (t) => normTitle(t).replace(/[^a-z0-9]+/g, ' ').trim()

/** La obra de `p` que corresponde a la obra `workId` de la plataforma activa (recordada o por título). */
function alsoTargetFor(p, workId) {
  const list = also.works[p] || []
  const saved = alsoMap(p)[workId]
  if (saved != null && list.some((w) => String(w.id) === String(saved))) return list.find((w) => String(w.id) === String(saved)).id
  if (saved != null && !list.length) return saved // aún no se cargó la lista: se confía en lo recordado
  const title = matchTitle(workById(workId)?.title)
  if (!title) return null
  const same = list.filter((w) => matchTitle(w.title) === title)
  return same.length === 1 ? same[0].id : null
}

async function loadAlsoWorks(p, { force = false } = {}) {
  if (!isConnected(p)) return []
  if (also.works[p] && !force) return also.works[p]
  if (also.loading[p]) return also.loading[p]
  also.loading[p] = platformApi.works(p).then((res) => {
    also.loading[p] = null
    if (!res.ok) {
      also.failed[p] = res.error.message
      handleApiError(res.error, `No se pudieron cargar las obras de ${plat(p).full}`)
      return []
    }
    delete also.failed[p]
    also.works[p] = res.data.slice().sort((a, b) => a.title.localeCompare(b.title, 'es'))
    return also.works[p]
  })
  return also.loading[p]
}

/** Obras de la plataforma activa que se van a subir (la elegida, o las de la cola en «Varios»). */
function alsoSourceWorks() {
  if (state.mode === 'batch') {
    const ids = [...new Set(pendingItems().map((i) => i.workId).filter((id) => id != null))]
    return ids.map(workById).filter(Boolean)
  }
  return state.selectedWork ? [state.selectedWork] : []
}

/* ---------- Ventanita ---------- */

function renderAlso() {
  const active = alsoActive()
  const btn = $('#alsoBtn')
  btn.classList.toggle('on', active.length > 0)
  $('#alsoBtnText').textContent = active.length ? `También a ${active.map((p) => plat(p).label).join(' y ')}` : 'También a…'
  const dots = $('#alsoDots')
  dots.innerHTML = ''
  active.forEach((p) => dots.append(el('span', { class: 'also-dot', dataset: { platform: p }, title: plat(p).full })))
  if (!$('#alsoPop').hidden) renderAlsoList()
}

function renderAlsoList() {
  const list = $('#alsoList')
  list.innerHTML = ''
  const sources = alsoSourceWorks()
  for (const p of otherPlatforms()) {
    const meta = plat(p)
    const connected = isConnected(p)
    const checked = Boolean(also.on[p]) && connected
    const box = el('input', {
      type: 'checkbox', checked, disabled: !connected || state.uploading,
      onchange: async (e) => {
        also.on[p] = e.target.checked
        localStorage.setItem(alsoOnKey(), JSON.stringify(also.on))
        if (e.target.checked) await loadAlsoWorks(p)
        renderAlso()
        validateAll()
      },
    })
    const head = el('label', { class: 'also-row-head' },
      box,
      el('span', { class: 'platform-mark', dataset: { platform: p }, text: meta.mark }),
      el('span', { class: 'also-row-name', text: meta.full }),
      connected
        ? el('span', { class: 'also-row-sub', text: isCapibara(p) ? (state.profiles.find((x) => x.id === state.activeScanId)?.name || '') : accountName(p) })
        : el('button', { type: 'button', class: 'btn secondary small', text: isCapibara(p) ? 'Agregar API key' : 'Iniciar sesión', onclick: (e) => { e.preventDefault(); isCapibara(p) ? openKeyModalFor(p) : openAccountModal(p) } }))
    const row = el('li', { class: `also-row${checked ? ' on' : ''}`, dataset: { platform: p } }, head)

    if (checked) {
      const works = also.works[p]
      if (!works && also.failed[p]) {
        row.append(el('p', { class: 'hint error', text: `No se pudieron cargar sus obras: ${also.failed[p]}` }),
          el('button', { type: 'button', class: 'btn ghost small', text: 'Reintentar', onclick: () => { delete also.failed[p]; renderAlsoList() } }))
      } else if (!works) {
        row.append(el('p', { class: 'hint', text: 'Cargando sus obras…' }))
        if (!also.loading[p]) loadAlsoWorks(p).then(() => renderAlsoList())
      } else if (!sources.length) {
        row.append(el('p', { class: 'hint', text: 'Elige primero la obra; aquí aparecerá su equivalente.' }))
      } else {
        for (const w of sources) {
          const target = alsoTargetFor(p, w.id)
          const select = el('select', {
            class: target == null ? 'invalid' : '',
            disabled: state.uploading,
            onchange: (e) => { setAlsoMap(p, w.id, e.target.value || null); renderAlso(); validateAll() },
          },
          el('option', { value: '', text: `Elige la obra en ${meta.label}…` }),
          ...works.map((x) => el('option', { value: x.id, text: x.title, selected: String(x.id) === String(target) })))
          row.append(el('div', { class: 'also-map' },
            el('span', { class: 'also-map-from', text: w.title, title: w.title }),
            el('span', { class: 'also-map-arrow', text: '→' }),
            select))
        }
        if (!works.length) row.append(el('p', { class: 'hint', text: `No tienes obras en ${meta.label}. Créala allí (o desde esta app al cambiar a ${meta.label}).` }))
      }
    }
    list.append(row)
  }
}

/** Capibara como destino secundario usa el scan activo de «Mis scans». */
function openKeyModalFor() {
  toast('info', 'Agrega la API key de tu scan', 'Cambia a Capibara con el botón de plataforma y agrégala en «Mis scans».')
}

function openAlso() {
  if (state.uploading) return
  $('#alsoPop').hidden = false
  $('#alsoBtn').setAttribute('aria-expanded', 'true')
  renderAlsoList()
}

function closeAlso() {
  $('#alsoPop').hidden = true
  $('#alsoBtn').setAttribute('aria-expanded', 'false')
}

const validateAll = () => (state.mode === 'batch' ? batchValidate() : validate())

/* ---------- Para la subida ---------- */

/** Obras sin pareja en alguna plataforma marcada: [{ platform, work }]. */
function alsoMissing(workIds) {
  const out = []
  for (const p of alsoActive()) {
    for (const id of workIds) if (alsoTargetFor(p, id) == null) out.push({ platform: p, work: workById(id) })
  }
  return out
}

/** Antes de subir: carga las obras que falten y avisa si alguna no tiene pareja. */
async function alsoReady(workIds) {
  const active = alsoActive()
  if (!active.length) return true
  await Promise.all(active.map((p) => loadAlsoWorks(p)))
  const missing = alsoMissing(workIds)
  if (!missing.length) return true
  openAlso()
  const m = missing[0]
  toast('warn', `Falta elegir la obra en ${plat(m.platform).full}`, `¿A qué obra de ${plat(m.platform).label} va «${m.work?.title || 'la obra'}»? Elígela en «También a…» o desmarca esa plataforma.`, 8000)
  return false
}

/**
 * Plataformas y obras de una subida: { platform, workId, also } para window.capi.upload.start.
 * doneOn: plataformas donde ese capítulo ya quedó subido (en un reintento solo se sube al resto).
 * null si ya no queda ninguna.
 */
function uploadTargets(workId, doneOn = null) {
  const all = [{ platform: state.platform, workId }, ...alsoActive().map((p) => ({ platform: p, workId: alsoTargetFor(p, workId) }))]
    .filter((t) => t.workId != null && !doneOn?.has(t.platform))
  if (!all.length) return null
  return { platform: all[0].platform, workId: all[0].workId, also: all.slice(1) }
}

/** Plataformas donde sí quedó, según la respuesta de una subida a varias. */
function okPlatforms(results) {
  return Object.entries(results || {}).filter(([, r]) => r.ok).map(([p]) => p)
}

/** Texto corto de cómo le fue a cada plataforma («Crimson: límite… · Mangation ✓»). */
function resultsText(results) {
  return Object.entries(results || {}).map(([p, r]) => `${plat(p).label}: ${r.ok ? (r.data?.skipped ? 'ya estaba' : 'subido') : r.error?.message || 'error'}`).join(' · ')
}

/* ---------- Avance por plataforma ---------- */

function alsoProgressStart(targets) {
  also.progress = {}
  const box = $('#platformProgress')
  const list = targets ? [targets.platform, ...targets.also.map((t) => t.platform)] : []
  box.hidden = list.length < 2
  box.innerHTML = ''
  for (const p of list) {
    also.progress[p] = { status: 'pending', percent: 0 }
    box.append(el('span', { class: 'pp', dataset: { platform: p, status: 'pending' } },
      el('span', { class: 'platform-mark', text: plat(p).mark }),
      el('span', { class: 'pp-name', text: plat(p).label }),
      el('span', { class: 'pp-state', text: 'En espera' })))
  }
}

const PP_TEXT = { converting: 'Convirtiendo', uploading: 'Subiendo', done: 'Listo', skipped: 'Ya estaba', error: 'Error', pending: 'En espera' }

function alsoProgress(p) {
  if (p.phase !== 'platform') return
  const chip = $(`#platformProgress .pp[data-platform="${p.platform}"]`)
  if (!chip) return
  chip.dataset.status = p.status
  const pct = Math.round((p.percent || 0) * 100)
  chip.querySelector('.pp-state').textContent = ['converting', 'uploading'].includes(p.status) ? `${PP_TEXT[p.status]} ${pct}%` : PP_TEXT[p.status] || p.status
  chip.title = p.message || p.reason || ''
}

/* ---------- Arranque ---------- */

function loadAlsoChoice() {
  try { also.on = JSON.parse(localStorage.getItem(alsoOnKey()) || '{}') } catch { also.on = {} }
  delete also.on[state.platform]
}

function initAlso() {
  loadAlsoChoice()
  $('#alsoBtn').addEventListener('click', () => ($('#alsoPop').hidden ? openAlso() : closeAlso()))
  $('#alsoDone').addEventListener('click', closeAlso)
  $('#alsoOff').addEventListener('click', () => {
    also.on = {}
    localStorage.setItem(alsoOnKey(), '{}')
    renderAlso()
    validateAll()
  })
  document.addEventListener('mousedown', (e) => { if (!$('#alsoWrap').contains(e.target)) closeAlso() })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#alsoPop').hidden) closeAlso() })
  on('platformChanged', () => { also.works = {}; loadAlsoChoice(); renderAlso() })
  on('scanChanged', () => { if (isCapibara()) also.works = {}; renderAlso() })
  on('sessionsChanged', (p) => { delete also.works[p]; renderAlso() })
  on('workSelected', () => renderAlso())
  on('worksLoaded', () => renderAlso())
  // Las marcadas cargan sus obras en segundo plano para emparejarlas.
  alsoActive().forEach((p) => loadAlsoWorks(p).then(renderAlso))
  renderAlso()
}
