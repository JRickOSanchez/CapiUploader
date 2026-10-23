'use strict'

/* =========================================================
   Modo «Varios capítulos»
   Usa las utilidades y el estado globales de app.js.
   Cada capítulo lleva su propia obra (del scan activo).
   ========================================================= */
const batch = {
  // { id, name, dir, parent, files, workId, workGuess, number, numberAuto, volume, volumeAuto, title,
  //   status, progress, error, result, refs }
  items: [],
  seq: 0,
  volumeAuto: true,
  cancelled: false,
  pmItem: null,
}

const UNIT_MS = { minutes: 60e3, hours: 3600e3, days: 864e5, weeks: 7 * 864e5 }
const YEAR_MS = 365 * 864e5
const LIMIT_CHAPTERS_PER_HOUR = 60
const LIMIT_IMAGES_PER_HOUR = 3000
const ICON_GRIP = '<svg viewBox="0 0 24 24"><circle cx="9" cy="6" r=".8"/><circle cx="15" cy="6" r=".8"/><circle cx="9" cy="12" r=".8"/><circle cx="15" cy="12" r=".8"/><circle cx="9" cy="18" r=".8"/><circle cx="15" cy="18" r=".8"/></svg>'
const ICON_PAGES = '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-4.5-4.5L6 21"/></svg>'
const ICON_BOOK = '<svg viewBox="0 0 24 24"><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5Z"/><path d="M4 19a2 2 0 0 1 2-2h13"/></svg>'

const sumSize = (files) => files.reduce((s, f) => s + f.size, 0)
const UNIT_TEXT = {
  minutes: ['minuto', 'minutos'], hours: ['hora', 'horas'], days: ['día', 'días'], weeks: ['semana', 'semanas'],
}
/** «1 día», «3 días», «cada día» en vez de «cada 1 días». */
const amount = (n, unit) => `${n} ${UNIT_TEXT[unit][n === 1 ? 0 : 1]}`
const every = (n, unit) => (n === 1 ? `cada ${UNIT_TEXT[unit][0]}` : `cada ${amount(n, unit)}`)
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

const workById = (id) => (id == null ? null : state.works.find((w) => w.id === id) || null)
const pendingItems = () => batch.items.filter((i) => i.status !== 'done')

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

/* ---------- Detección de la obra por el nombre de la carpeta ---------- */

const normTitle = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim()

function bigramSet(s) {
  const t = ` ${s} `
  const out = []
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2))
  return out
}

/** Coeficiente de Dice sobre bigramas: 1 = iguales, 0 = nada en común. */
function similarity(a, b) {
  if (!a || !b) return 0
  if (a === b) return 1
  const A = bigramSet(a)
  const B = bigramSet(b)
  const counts = new Map()
  for (const g of B) counts.set(g, (counts.get(g) || 0) + 1)
  let hits = 0
  for (const g of A) {
    const c = counts.get(g)
    if (c) { hits++; counts.set(g, c - 1) }
  }
  return (2 * hits) / (A.length + B.length)
}

/** Devuelve { work, sure } si el nombre de la carpeta se parece a alguna obra del scan. */
function matchWork(folderName) {
  const n = normTitle(folderName)
  if (n.length < 3 || !state.works.length) return null
  let best = null
  let score = 0
  for (const w of state.works) {
    const names = [w.title, w.alternativeTitle, w.slug && w.slug.replace(/-/g, ' ')].filter(Boolean)
    for (const t of names) {
      const m = normTitle(t)
      let sc = similarity(n, m)
      // «Kirara» dentro de «Kirara Hoshikita quiere brillar»
      if (n.length >= 4 && m.length >= 4 && (m.includes(n) || n.includes(m))) sc = Math.max(sc, 0.62 + 0.38 * (Math.min(n.length, m.length) / Math.max(n.length, m.length)))
      if (sc > score) { score = sc; best = w }
    }
  }
  if (score >= 0.85) return { work: best, sure: true }
  if (score >= 0.6) return { work: best, sure: false }
  return null
}

/* ---------- Números y tomos por obra ---------- */

function workChapters(workId) {
  return (workId != null && state.chaptersByWork.get(workId)) || []
}

function workLatest(workId) {
  return workChapters(workId).reduce((best, c) => (!best || c.number > best.number ? c : best), null)
}

/** Asigna números libres dentro de una obra (sin chocar con lo publicado ni con la lista). */
function makeNumberAllocator(workId, exclude = null) {
  const taken = new Set([
    ...workChapters(workId).map((c) => Number(c.number)),
    ...batch.items.filter((i) => i.workId === workId && i !== exclude && !i.numberAuto).map((i) => i.number),
  ].filter((n) => n != null && !Number.isNaN(n)))
  let n = Math.floor(Math.max(0, ...taken)) + 1
  return () => {
    while (taken.has(n)) n++
    taken.add(n)
    return n++
  }
}

/** Da número a los capítulos cuya carpeta no lo traía, según la obra que tengan. */
function allocateAutoNumbers(items) {
  const byWork = new Map()
  for (const it of items) {
    if (!it.numberAuto || it.status === 'done') continue
    if (!byWork.has(it.workId)) byWork.set(it.workId, makeNumberAllocator(it.workId))
    it.number = byWork.get(it.workId)()
  }
}

function readDefaultVolume() {
  const v = $('#batchVolume').value.trim()
  return v === '' ? null : Number(v)
}

function defaultVolumeFor(workId) {
  if (!batch.volumeAuto) return readDefaultVolume()
  return workLatest(workId)?.volumeNumber ?? null
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

/** opts.workId fija la obra de todos los capítulos (p. ej. al venir de «Importar de web»). */
async function addChapters({ chapters, skipped, looseFiles, psd }, opts = {}) {
  const known = new Set(batch.items.map((i) => i.dir))
  const fresh = chapters.filter((c) => !known.has(c.dir))
  const dupes = chapters.length - fresh.length
  const guesses = new Map() // carpeta → obra adivinada sin seguridad

  const items = fresh.map((c) => {
    const p = parseChapterName(c.name)
    const match = opts.workId != null ? null : matchWork(c.parent)
    if (match && !match.sure) guesses.set(c.parent, match.work.title)
    return {
      id: ++batch.seq,
      name: c.name,
      dir: c.dir,
      parent: c.parent || '',
      files: c.files.map((f) => ({ ...f, id: ++fileSeq, status: null })),
      workId: opts.workId ?? match?.work.id ?? state.selectedWork?.id ?? null,
      workGuess: Boolean(match),
      number: p.number,
      numberAuto: p.number == null,
      volume: p.volume,
      volumeAuto: p.volume == null,
      title: p.title,
      status: 'pending',
      progress: 0,
      error: '',
      result: null,
    }
  })

  // Los capítulos de cada obra hacen falta para numerar y validar.
  await Promise.all([...new Set(items.map((i) => i.workId).filter((id) => id != null))].map((id) => ensureChapters(id)))

  items.sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity) || naturalCompare(a.name, b.name))
  batch.items.push(...items)
  allocateAutoNumbers(items)
  const guessedNumbers = items.filter((i) => i.numberAuto).length
  const works = new Set(items.map((i) => i.workId))
  const unassigned = items.filter((i) => i.workId == null).length

  if (items.length) {
    // Un solo aviso: lo agregado y, si hubo, las obras adivinadas por el nombre de la carpeta.
    const msg = [
      works.size > 1 || (works.size === 1 && !works.has(state.selectedWork?.id)) ? `Repartidos en ${plural(works.size, 'obra', 'obras')}.` : '',
      guesses.size ? `Revisa las obras detectadas: ${[...guesses].map(([f, t]) => `«${f}» → ${t}`).join(' · ')}.` : '',
      guessedNumbers ? `${plural(guessedNumbers, 'carpeta', 'carpetas')} sin número: se les asignó el siguiente libre.` : '',
      unassigned ? `${plural(unassigned, 'capítulo', 'capítulos')} sin obra: elígela en su grupo.` : '',
    ].filter(Boolean).join(' ')
    toast(guesses.size || unassigned ? 'warn' : 'success', `${plural(items.length, 'capítulo agregado', 'capítulos agregados')}`, msg || null, guesses.size ? 10000 : 7000)
  }
  if (dupes) toast('info', `${dupes} carpeta(s) ya estaban en la lista`)
  if (looseFiles) toast('warn', 'Se ignoraron imágenes sueltas', 'En este modo cada capítulo debe ser una carpeta. Para un solo capítulo usa «Un capítulo».', 7000)
  if (skipped.length) toast('warn', `${skipped.length} carpeta(s) sin imágenes`, skipped.slice(0, 3).join(', ') + (skipped.length > 3 ? '…' : ''))
  if (!chapters.length && !looseFiles && !skipped.length) toast('warn', 'No se encontraron capítulos')
  reportPsd(psd)

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

/** Cambia la obra de uno o varios capítulos pendientes. */
async function assignWork(items, work) {
  const targets = items.filter((i) => i.status !== 'done')
  if (!targets.length) return
  for (const it of targets) {
    it.workId = work.id
    it.workGuess = false
    if (it.volumeAuto) it.volume = null
  }
  await ensureChapters(work.id)
  allocateAutoNumbers(targets)
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

/* ---------- Ganchos con app.js ---------- */

/** Al cambiar de scan, las obras asignadas ya no sirven: se vuelven a detectar al cargar. */
function batchOnScanChanged() {
  for (const it of batch.items) {
    if (it.status === 'done') continue
    it.workId = null
    it.workGuess = false
  }
  renderBatch()
}

/** Cuando cargan las obras del scan, se intenta asignar las que quedaron sin obra. */
async function batchOnWorksLoaded() {
  const orphans = pendingItems().filter((i) => i.workId == null)
  if (!orphans.length) return
  for (const it of orphans) {
    const m = matchWork(it.parent)
    if (m) { it.workId = m.work.id; it.workGuess = true }
  }
  await Promise.all([...new Set(orphans.map((i) => i.workId).filter((id) => id != null))].map((id) => ensureChapters(id)))
  allocateAutoNumbers(orphans)
  renderBatch()
  batchValidate()
}

/** La obra elegida arriba es la predeterminada para lo que no tenga obra. */
async function batchOnWorkSelected(work) {
  if (!work) return
  const orphans = pendingItems().filter((i) => i.workId == null)
  if (orphans.length) await assignWork(orphans, work)
}

/* ---------- Grupos por obra ---------- */

function groupedItems() {
  const order = []
  const map = new Map()
  for (const it of batch.items) {
    const k = it.workId ?? 'none'
    if (!map.has(k)) { map.set(k, []); order.push(k) }
    map.get(k).push(it)
  }
  return order.map((k) => ({ workId: k === 'none' ? null : k, items: map.get(k) }))
}

/* ---------- Programación ---------- */

function schedulePlan() {
  const schedule = $('#scheduleToggle').checked
  const base = schedule && $('#publishAt').value ? new Date($('#publishAt').value) : null
  const intervalVal = Math.max(0, Number($('#batchInterval').value) || 0)
  const unit = $('#batchIntervalUnit').value
  const step = intervalVal * UNIT_MS[unit]

  // Cada obra lleva su propia secuencia: Kirara 20, 21, 22 · Wistoria 20, 21…
  const groups = groupedItems()
  const queue = groups.flatMap((g) => g.items.filter((i) => i.status !== 'done'))
  const map = new Map()
  for (const g of groups) {
    let k = 0
    for (const it of g.items) {
      if (it.status === 'done') continue
      map.set(it.id, { publishAt: base ? new Date(base.getTime() + k * step) : null })
      k++
    }
  }
  return {
    schedule, base, step, intervalVal, unit, queue, map,
    notify: $('#notifyToggle').checked,
  }
}

function whenText(it, plan) {
  if (it.status === 'done') return ''
  const s = plan.map.get(it.id)
  if (!s) return ''
  return s.publishAt ? `Publica ${formatDate(s.publishAt)}` : 'Publica al subirse'
}

/* ---------- Validación ---------- */

function syncDefaultVolume() {
  if (batch.volumeAuto && !state.chaptersLoading) {
    const last = latestChapter()
    const v = last?.volumeNumber != null ? String(last.volumeNumber) : ''
    if ($('#batchVolume').value !== v) $('#batchVolume').value = v
  }
  for (const it of batch.items) {
    if (!it.volumeAuto || it.status === 'done') continue
    const def = defaultVolumeFor(it.workId)
    if (it.volume !== def) {
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
  const now = Date.now()

  if (!batch.items.length) errors.files = 'Agrega las carpetas de los capítulos.'
  else if (!queue.length) errors.files = 'Todos los capítulos de la lista ya se subieron.'

  // Números repetidos o existentes, dentro de cada obra
  const counts = new Map()
  queue.forEach((i) => { if (i.number != null && i.workId != null) { const k = `${i.workId}:${i.number}`; counts.set(k, (counts.get(k) || 0) + 1) } })
  const existing = new Map()
  const existingFor = (workId) => {
    if (!existing.has(workId)) existing.set(workId, new Set(workChapters(workId).map((c) => Number(c.number))))
    return existing.get(workId)
  }

  let bad = 0
  for (const it of batch.items) {
    let err = ''
    let always = false // errores que se muestran aunque aún no se intente subir
    if (it.status !== 'done') {
      const s = plan.map.get(it.id) || {}
      const work = workById(it.workId)
      if (!work) err = state.works.length ? 'Elige la obra de este capítulo.' : 'Cargando las obras del scan…'
      else if (it.number == null || Number.isNaN(it.number)) err = 'Falta el número del capítulo.'
      else if (it.number < 0) err = 'El número no puede ser negativo.'
      else if (existingFor(it.workId).has(it.number)) { err = `El capítulo ${it.number} ya existe en «${work.title}».`; always = true }
      else if (counts.get(`${it.workId}:${it.number}`) > 1) { err = `El número ${it.number} está repetido en «${work.title}».`; always = true }
      else if (it.volume != null && (!Number.isInteger(it.volume) || it.volume < 0)) { err = 'El tomo debe ser un número entero.'; always = true }
      else if (it.files.length > MAX_PAGES) { err = `Tiene ${it.files.length} páginas (máximo ${MAX_PAGES}).`; always = true }
      else if (it.files.some((f) => f.size > MAX_BYTES)) { err = 'Tiene imágenes de más de 40 MB.'; always = true }
      else if (s.publishAt && s.publishAt.getTime() > now + YEAR_MS) { err = 'Su fecha de publicación queda a más de 1 año (máximo de la API).'; always = true }
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

  // Fecha del primer capítulo (de cada obra)
  let publishMsg = ''
  if (plan.schedule) {
    const dates = queue.map((i) => plan.map.get(i.id)?.publishAt).filter(Boolean)
    const last = dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null
    if (!plan.base) errors.publish = 'Elige la fecha del primer capítulo.'
    else if (plan.base.getTime() <= now + 60e3) errors.publish = 'La fecha debe ser futura.'
    else if (last && last.getTime() > now + YEAR_MS) errors.publish = 'El último capítulo quedaría a más de 1 año (máximo de la API).'
    else if (last && last > plan.base) publishMsg = `Cada obra empieza el ${formatDate(plan.base)}; el último sale el ${formatDate(last)}.`
    else publishMsg = `${queue.length > 1 ? 'Todos se publican' : 'Se publica'} ${relativeFromNow(plan.base)} · ${formatDate(plan.base)}`
  }
  setHint('#publishHint', errors.publish || publishMsg || 'Máximo 1 año a futuro. Hora local de tu equipo.',
    errors.publish ? 'error' : publishMsg ? 'ok' : '')
  $('#publishAt').classList.toggle('invalid', Boolean(errors.publish) && (show || Boolean(plan.base)))

  const p = typeof activeProfile === 'function' ? activeProfile() : null
  if ((state.me && !state.me.key.scopes.includes('chapters:write')) || (p && !canWrite(p))) errors.scope = 'La clave de este scan no tiene el permiso chapters:write.'
  if (!state.hasKey) errors.key = 'Agrega un scan.'
  $('#workTrigger').classList.remove('invalid')

  renderBatchSummary(plan, errors)
  const ok = Object.keys(errors).length === 0
  $('#uploadBtn').disabled = state.uploading || (state.attempted && !ok)
  return { ok, errors, plan, queue }
}

function renderBatchSummary(plan, errors) {
  const queue = plan.queue
  const pages = queue.reduce((s, it) => s + it.files.length, 0)
  const allPages = batch.items.reduce((s, it) => s + it.files.length, 0)
  const workIds = new Set(queue.map((i) => i.workId).filter((id) => id != null))
  $('#batchCount').textContent = String(batch.items.length)
  $('#batchSummary').textContent = batch.items.length
    ? `${plural(batch.items.length, 'capítulo', 'capítulos')} · ${formatNumber(allPages)} páginas · ${formatBytes(batch.items.reduce((s, it) => s + sumSize(it.files), 0))} — arrastra ⠿ para reordenar dentro de cada obra.`
    : 'Una carpeta por capítulo. Puedes mezclar obras del mismo scan.'
  if (state.uploading) return

  const main = $('#summaryMain')
  const sub = $('#summarySub')
  const parts = []
  if (workIds.size === 1) parts.push(workById([...workIds][0])?.title)
  else if (workIds.size > 1) parts.push(plural(workIds.size, 'obra', 'obras'))
  if (queue.length) {
    parts.push(plural(queue.length, 'capítulo', 'capítulos'))
    parts.push(`${formatNumber(pages)} pág.`)
  }
  main.textContent = parts.filter(Boolean).length ? parts.filter(Boolean).join(' · ') : 'Agrega las carpetas de los capítulos'

  const firstError = Object.values(errors)[0]
  if (state.attempted && firstError) {
    sub.textContent = firstError
    sub.className = 'summary-sub error'
    return
  }
  sub.className = 'summary-sub'
  let t = plan.schedule && plan.base
    ? `Programados desde ${formatDate(plan.base)}${queue.length > 1 ? (plan.step ? ` · uno ${every(plan.intervalVal, plan.unit)} por obra` : ' · todos a la vez') : ''}`
    : 'Se publican conforme terminan de subirse'
  if (!plan.notify) t += ' · Sin avisos'
  if (queue.length > LIMIT_CHAPTERS_PER_HOUR || pages > LIMIT_IMAGES_PER_HOUR) {
    t += ` · Ojo: supera el límite por hora del scan (${LIMIT_CHAPTERS_PER_HOUR} capítulos / ${formatNumber(LIMIT_IMAGES_PER_HOUR)} imágenes)`
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
    oninput: (e) => { it.number = e.target.value === '' ? null : Number(e.target.value); it.numberAuto = false; batchValidate() },
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
  const handle = el('div', { class: 'ch-handle', html: ICON_GRIP, title: 'Arrastra para reordenar dentro de la obra' })

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
      el('button', { type: 'button', class: 'icon-btn small ghost', title: 'Mover a otra obra', html: ICON_BOOK, disabled: locked, onclick: (e) => openWorkPicker(e.currentTarget, [it]) }),
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

function groupHeader(g) {
  const work = workById(g.workId)
  const pending = g.items.filter((i) => i.status !== 'done')
  const nums = g.items.map((i) => i.number).filter((n) => n != null && !Number.isNaN(n))
  const last = workLatest(g.workId)
  const guessed = g.items.some((i) => i.workGuess)
  const meta = [
    plural(g.items.length, 'capítulo', 'capítulos'),
    nums.length ? (nums.length > 1 ? `#${Math.min(...nums)}–${Math.max(...nums)}` : `#${nums[0]}`) : null,
    work ? (last ? `último publicado #${last.number}` : 'sin capítulos publicados') : null,
  ].filter(Boolean).join(' · ')

  return el('li', { class: `group-head${work ? '' : ' none'}`, dataset: { work: g.workId ?? 'none' } },
    work ? coverImg(work) : el('div', { class: 'cover' }),
    el('div', { class: 'group-text' },
      el('div', { class: 'group-title' },
        el('span', { text: work ? work.title : state.works.length ? 'Sin obra asignada' : 'Cargando obras…' }),
        guessed && work ? el('span', { class: 'badge warning', title: 'Asignada por el nombre de la carpeta. Cámbiala si no es correcta.', text: 'Detectada por carpeta' }) : null),
      el('div', { class: 'group-meta', text: meta })),
    el('div', { class: 'group-actions' },
      work && pending.length ? el('button', {
        type: 'button', class: 'btn ghost small', title: 'Numerar en orden desde el siguiente al último publicado', disabled: state.uploading,
        onclick: () => {
          const start = last ? Math.floor(last.number) + 1 : 1
          let n = start
          for (const it of g.items) { if (it.status !== 'done') { it.number = n++; it.numberAuto = false } }
          renderBatch()
          batchValidate()
          toast('success', `«${work.title}» renumerada`, `Del ${start} al ${n - 1}.`)
        },
      }, 'Numerar desde el último') : null,
      el('button', {
        type: 'button', class: `btn ${work ? 'secondary' : 'primary'} small`, disabled: state.uploading || !pending.length,
        onclick: (e) => openWorkPicker(e.currentTarget, g.items),
      }, el('span', { html: ICON_BOOK }), work ? 'Cambiar obra' : 'Elegir obra')))
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
  for (const g of groupedItems()) {
    list.append(groupHeader(g))
    g.items.forEach((it) => list.append(chapterRow(it)))
  }
  if (has && !state.uploading) {
    list.append(el('li', { class: 'add-row', onclick: pickChapters, html: `${ICONS.plus}<span>Agregar más carpetas</span>` }))
  }
}

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
  const work = workById(it.workId)
  $('#pmTitle').textContent = `${work ? `${work.title} · ` : ''}Capítulo ${it.number ?? '—'} · ${it.files.length} página${it.files.length === 1 ? '' : 's'}`
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

  // Reordenar filas (solo dentro de la misma obra)
  const list = $('#batchList')
  let from = null
  const clear = () => $$('.chrow.drop-before, .chrow.drop-after').forEach((r) => r.classList.remove('drop-before', 'drop-after'))
  const indexOf = (row) => batch.items.findIndex((i) => String(i.id) === row.dataset.id)
  const sameWork = (row) => from != null && batch.items[indexOf(row)]?.workId === batch.items[from]?.workId
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
    if (!row || !sameWork(row)) { e.dataTransfer.dropEffect = 'none'; return }
    const r = row.getBoundingClientRect()
    row.classList.add(e.clientY > r.top + r.height / 2 ? 'drop-after' : 'drop-before')
  })
  list.addEventListener('drop', (e) => {
    if (from == null) return
    e.preventDefault()
    e.stopPropagation()
    const row = e.target.closest('.chrow')
    clear()
    if (row && !sameWork(row)) {
      toast('info', 'Para pasar un capítulo a otra obra', 'Usa el botón 📕 «Mover a otra obra» de su fila.')
    } else if (row) {
      const r = row.getBoundingClientRect()
      moveChapter(from, indexOf(row) + (e.clientY > r.top + r.height / 2 ? 1 : 0))
    }
    from = null
  })

  $('#batchSortBtn').addEventListener('click', () => {
    const order = groupedItems().map((g) => g.workId)
    batch.items.sort((a, b) => order.indexOf(a.workId) - order.indexOf(b.workId)
      || (a.number ?? Infinity) - (b.number ?? Infinity) || naturalCompare(a.name, b.name))
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
    if (v.errors.key) return openKeyModal(true)
    const first = Object.keys(v.errors)[0]
    toast('warn', 'Revisa el formulario', v.errors[first])
    if (first === 'rows') $('.chrow.invalid')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    else if (first === 'publish') $('#publishAt').focus()
    return
  }

  const { plan, queue } = v
  const scanName = activeProfile()?.name || 'tu scan'
  const workIds = [...new Set(queue.map((i) => i.workId))]
  for (const it of queue) { it.status = 'pending'; it.error = ''; it.progress = 0 }
  batch.cancelled = false
  setUploadingUI(true)
  renderBatch()
  setProgress(0, 'Preparando…')
  $('#summaryMain').textContent = workIds.length === 1
    ? `Subiendo ${plural(queue.length, 'capítulo', 'capítulos')} de «${workById(workIds[0]).title}»`
    : `Subiendo ${plural(queue.length, 'capítulo', 'capítulos')} de ${workIds.length} obras a ${scanName}`
  $('#summarySub').className = 'summary-sub'

  const totalBytes = queue.reduce((s, it) => s + sumSize(it.files), 0) || 1
  let bytesBefore = 0
  let current = null
  let pos = 0
  const label = () => `${pos + 1}/${queue.length} · ${workById(current.workId)?.title || ''} #${current.number}`

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

  const perWork = new Map() // workId → { ok, failed }
  let ok = 0
  let failed = 0
  let stopped = false
  for (pos = 0; pos < queue.length; pos++) {
    if (batch.cancelled) { stopped = true; break }
    const it = queue[pos]
    const work = workById(it.workId)
    current = it
    it.status = 'uploading'
    updateRowStatus(it)
    it.refs?.row.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    $('#summarySub').textContent = `${ok} subidos${failed ? ` · ${failed} con error` : ''} · quedan ${queue.length - pos}`

    const sched = plan.map.get(it.id) || {}
    const res = await window.capi.upload.start({
      workId: work.id,
      files: it.files.map((f) => ({ path: f.path, single: Boolean(f.single) })),
      chapter: {
        number: it.number,
        title: it.title || null,
        volumeNumber: it.volume,
        publishAt: sched.publishAt ? sched.publishAt.toISOString() : null,
        notify: plan.notify,
        announcePage: announcePageFor(it.files),
      },
    })
    bytesBefore += sumSize(it.files)
    const tally = perWork.get(it.workId) || { ok: 0, failed: 0 }
    perWork.set(it.workId, tally)

    if (res.ok) {
      it.status = 'done'
      it.result = res.data
      it.progress = 1
      ok++
      tally.ok++
      warnSingles(res.data.singleCheck, it.number)
      const cache = state.chaptersByWork.get(it.workId)
      const entry = { number: it.number, volumeNumber: it.volume, state: res.data.state }
      if (cache) cache.push(entry)
      if (state.selectedWork?.id === it.workId && state.chapters !== cache) state.chapters.push(entry)
    } else if (res.error.code === 'cancelled') {
      it.status = 'pending'
      it.progress = 0
      stopped = true
    } else {
      it.status = 'error'
      it.error = res.error.message
      failed++
      tally.failed++
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
  // Refresca los capítulos reales de cada obra tocada.
  Promise.all(workIds.map((id) => ensureChapters(id, { force: true }))).then(() => { renderBatch(); batchValidate() })
  loadChapters()

  const pending = queue.filter((i) => i.status === 'pending').length
  if (!ok && !failed) {
    toast('info', 'Subida cancelada', 'Las páginas ya subidas se reutilizarán si vuelves a intentarlo pronto.')
    return
  }
  showBatchDone(plan, perWork, { ok, failed, pending })
}

function showBatchDone(plan, perWork, { ok, failed, pending }) {
  const mark = $('#doneModal .success-mark')
  const clean = !failed && !pending
  mark.classList.toggle('warn', !clean)
  mark.innerHTML = clean ? ICONS.check : ICONS.warn
  $('#doneTitle').textContent = clean
    ? `¡${ok} capítulo${ok === 1 ? '' : 's'} ${plan.schedule ? 'programado' : 'subido'}${ok === 1 ? '' : 's'}!`
    : ok ? 'Subida terminada con pendientes' : 'No se pudo subir ningún capítulo'
  const lines = []
  for (const [workId, t] of perWork) {
    lines.push(`«${workById(workId)?.title || 'Obra'}»: ${t.ok} subido${t.ok === 1 ? '' : 's'}${t.failed ? ` · ${t.failed} con error` : ''}`)
  }
  const parts = [`${ok} subido${ok === 1 ? '' : 's'}`]
  if (failed) parts.push(`${failed} con error`)
  if (pending) parts.push(`${pending} sin subir`)
  lines.push(parts.join(' · '))
  if (plan.schedule && plan.base) lines.push(`Programados desde el ${formatDate(plan.base)}${plan.step ? `, uno ${every(plan.intervalVal, plan.unit)} por obra` : ''}`)
  if (failed || pending) lines.push('Corrige lo marcado en la lista y pulsa «Subir capítulos» para seguir solo con esos.')
  const text = $('#doneText')
  text.innerHTML = ''
  lines.forEach((l, i) => { if (i) text.append(el('br')); text.append(l) })
  const works = [...perWork.keys()]
  const single = works.length === 1 ? workById(works[0]) : null
  const url = single?.url || activeProfile()?.url || null
  state.lastResult = { url }
  $('#doneOpen').textContent = single ? 'Ver obra en Capibara' : 'Ver scan en Capibara'
  $('#doneOpen').hidden = !url
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
  initWorkPicker()
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
    let count = 0
    for (const g of groupedItems()) {
      let n = start
      for (const it of g.items) {
        if (it.status === 'done') continue
        it.number = n++
        it.numberAuto = false
        count++
      }
    }
    renderBatch()
    batchValidate()
    if (count) toast('success', 'Capítulos renumerados', `Cada obra empieza en el ${start}, en el orden de la lista.`)
  })
  $('#batchInterval').addEventListener('input', () => validate())
  $('#batchIntervalUnit').addEventListener('change', () => validate())
  $('#scheduleToggle').addEventListener('change', () => validate())

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
