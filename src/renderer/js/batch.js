'use strict'

/* =========================================================
   Modo «Varios capítulos»
   Usa el estado y las utilidades globales de core.js.
   Cada capítulo lleva su propia obra (del scan activo).
   ========================================================= */
const batch = {
  // { id, name, dir, parent, files, workId, workGuess, number, numberAuto, volume, volumeAuto, title,
  //   extra, parsedExtra, parsedNumber, numberSource, keptPublished, status, progress, error, result, refs }
  // parsedNumber: el número que trae el nombre de la carpeta (null si no trae).
  // extra: se sube como «Extra N» (numeración aparte); parsedExtra: la carpeta dice «Extra», «Omake»…
  // numberSource: 'folder' | 'auto' (siguiente libre) | 'manual' | 'renumber'
  items: [],
  seq: 0,
  volumeAuto: true,
  cancelled: false,
  pmItem: null,
  // Capítulos que ya salieron de la cola (subidos u omitidos por estar publicados), del más nuevo al más viejo.
  uploaded: [],
  uploadedScan: undefined,
  uploadedOpen: localStorage.getItem('uploadedOpen') !== '0',
}

const UNIT_MS = { minutes: 60e3, hours: 3600e3, days: 864e5, weeks: 7 * 864e5 }
const YEAR_MS = 365 * 864e5
// Límites por hora del scan; GET /me trae los vigentes y estos son el respaldo.
const hourLimits = () => ({
  chapters: state.me?.limits?.chaptersPerHour || 300,
  images: state.me?.limits?.uploadsPerHour || 15000,
})
// Si Capibara frena el lote por un límite, se espera y se reintenta el mismo capítulo hasta estas veces.
const MAX_RATE_PAUSES = 3
const ICON_GRIP = '<svg viewBox="0 0 24 24"><circle cx="9" cy="6" r=".8"/><circle cx="15" cy="6" r=".8"/><circle cx="9" cy="12" r=".8"/><circle cx="15" cy="12" r=".8"/><circle cx="9" cy="18" r=".8"/><circle cx="15" cy="18" r=".8"/></svg>'
const ICON_PAGES = '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-4.5-4.5L6 21"/></svg>'
const ICON_BOOK = '<svg viewBox="0 0 24 24"><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5Z"/><path d="M4 19a2 2 0 0 1 2-2h13"/></svg>'

const sumSize = (files) => files.reduce((s, f) => s + f.size, 0)

const pendingItems = () => batch.items.filter((i) => i.status !== 'done')
const ICON_OPEN = '<svg viewBox="0 0 24 24"><path d="M14 4h6v6m0-6-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>'

/** [1, 2, 3, 5, 7, 8] → «1–3, 5, 7–8» */
function numberRanges(nums) {
  const sorted = [...new Set(nums)].sort((a, b) => a - b)
  const out = []
  for (let i = 0; i < sorted.length; i++) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++
    out.push(j > i ? `${sorted[i]}–${sorted[j]}` : String(sorted[i]))
    i = j
  }
  return out.join(', ')
}

/* ---------- Números y tomos por obra ---------- */

/** Capítulos (o, con extra, los extras) que ya tiene la obra en Capibara. */
function workChapters(workId, extra = false) {
  const all = (workId != null && state.chaptersByWork.get(workId)) || []
  return extra ? extrasOnly(all) : regularOnly(all)
}

function workLatest(workId) {
  return workChapters(workId).reduce((best, c) => (!best || c.number > best.number ? c : best), null)
}

/**
 * Asigna números libres dentro de una obra (sin chocar con lo publicado ni con la lista), en la
 * numeración de los capítulos o en la de los extras.
 */
function makeNumberAllocator(workId, exclude = null, extra = false, { includeAuto = false } = {}) {
  const taken = new Set([
    ...workChapters(workId, extra).map(shownNumber),
    ...batch.items.filter((i) => i.workId === workId && i !== exclude && Boolean(i.extra) === extra && (includeAuto || !i.numberAuto)).map((i) => i.number),
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
    const k = `${it.workId}:${it.extra ? 'e' : 'c'}`
    if (!byWork.has(k)) byWork.set(k, makeNumberAllocator(it.workId, null, Boolean(it.extra)))
    it.number = byWork.get(k)()
  }
}

/**
 * Marca o desmarca un capítulo de la lista como extra. Si la carpeta ya decía qué era («Extra 2»),
 * recupera ese número; si no, le da el siguiente libre de la otra numeración.
 */
async function setItemExtra(it, extra) {
  if (Boolean(it.extra) === extra) return
  it.extra = extra
  it.keptPublished = null
  if (it.parsedNumber != null && Boolean(it.parsedExtra) === extra) {
    it.number = it.parsedNumber
    it.numberSource = 'folder'
  } else {
    it.number = makeNumberAllocator(it.workId, it, extra, { includeAuto: true })()
    it.numberSource = 'auto'
  }
  it.numberAuto = false
  renderBatch()
  batchValidate()
  await offerSkipPublished([it])
}

/**
 * Renumera en orden los capítulos pendientes de cada grupo, empezando en startFor(grupo).
 * Los extras no se tocan: llevan su propia numeración.
 * Si alguno trae el número en el nombre de su carpeta, pregunta antes de cambiárselo.
 * Devuelve { count, all } o null si se canceló.
 */
async function renumberGroups(groups, startFor) {
  const targets = groups
    .map((g) => ({ g, items: g.items.filter((i) => i.status !== 'done' && !i.extra) }))
    .filter((x) => x.items.length)
  const named = targets.flatMap((x) => x.items.filter((i) => i.parsedNumber != null))
  const free = targets.flatMap((x) => x.items.filter((i) => i.parsedNumber == null))
  let all = true

  if (named.length) {
    // Ejemplo: lo que le pasaría al primero que tiene número en la carpeta.
    const ex = named[0]
    const exGroup = targets.find((x) => x.items.includes(ex))
    const exNew = startFor(exGroup.g) + exGroup.items.indexOf(ex)
    const changed = targets.flatMap((x) => x.items.map((it, i) => ({ it, n: startFor(x.g) + i })))
      .filter(({ it, n }) => it.parsedNumber != null && it.parsedNumber !== n).length
    if (changed) {
      // Lo más común: se volvió a agregar una carpeta con capítulos ya subidos.
      const published = findPublished(targets.flatMap((x) => x.items), { includeKept: true })
      const choice = await ask({
        kind: 'warn',
        title: `${plural(named.length, 'capítulo trae', 'capítulos traen')} el número en el nombre de su carpeta`,
        text: `Si los renumeras, ${changed === 1 ? 'uno dejará' : `${changed} dejarán`} de coincidir con su carpeta${exNew !== ex.parsedNumber ? `: «${ex.name}» es el cap ${ex.parsedNumber} y pasaría a ser el ${exNew}` : ''}.`
          + (published.length ? ` ${published.length === 1 ? 'Uno ya está publicado' : `${published.length} ya están publicados`}: lo normal es omitirlos y subir el resto con su número.` : ''),
        buttons: [
          { value: 'cancel', label: 'Cancelar', cancel: true },
          { value: 'all', label: 'Renumerar todos', kind: 'ghost danger' },
          published.length ? { value: 'skip', label: `Omitir los ${published.length} ya publicados`, kind: 'primary' } : null,
          free.length ? { value: 'free', label: `Solo los ${free.length} sin número`, kind: published.length ? 'secondary' : 'primary' } : null,
        ].filter(Boolean),
      })
      if (choice === 'cancel') return null
      if (choice === 'skip') {
        skipPublished(published)
        renderBatch()
        renderUploaded()
        batchValidate()
        return { count: 0, all: false, skipped: published.length }
      }
      all = choice === 'all'
    }
  }

  let count = 0
  for (const { g, items } of targets) {
    let n = startFor(g)
    if (all) {
      for (const it of items) { it.number = n++; it.numberAuto = false; it.numberSource = 'renumber'; count++ }
      continue
    }
    // Solo los que no traen número, sin chocar con lo publicado ni con los que sí lo traen.
    const taken = new Set([
      ...workChapters(g.workId).map((c) => Number(c.number)),
      ...items.filter((i) => i.parsedNumber != null).map((i) => i.number),
    ])
    for (const it of items) {
      if (it.parsedNumber != null) continue
      while (taken.has(n)) n++
      it.number = n
      taken.add(n++)
      it.numberAuto = false
      it.numberSource = 'renumber'
      count++
    }
  }
  renderBatch()
  batchValidate()
  return { count, all }
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
    const ancestors = c.ancestors || (c.parent ? [c.parent] : [])
    const match = opts.workId != null ? null : guessWork(ancestors, c.name)
    if (match && !match.sure) guesses.set(match.from, match.work.title)
    const volume = p.volume ?? volumeFromFolder(ancestors[0])
    return {
      id: ++batch.seq,
      name: c.name,
      dir: c.dir,
      parent: c.parent || '',
      ancestors,
      files: c.files.map((f) => ({ ...f, id: ++fileSeq, status: null })),
      workId: opts.workId ?? match?.work.id ?? state.selectedWork?.id ?? null,
      workGuess: Boolean(match),
      number: p.number,
      numberAuto: p.number == null,
      parsedNumber: p.number,
      extra: p.extra,
      parsedExtra: p.extra,
      numberSource: p.number == null ? 'auto' : 'folder',
      keptPublished: null,
      volume,
      volumeAuto: volume == null,
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
  const extras = items.filter((i) => i.extra).length
  const works = new Set(items.map((i) => i.workId))
  const unassigned = items.filter((i) => i.workId == null).length

  if (items.length) {
    // Un solo aviso: lo agregado y, si hubo, las obras adivinadas por el nombre de la carpeta.
    const msg = [
      works.size > 1 || (works.size === 1 && !works.has(state.selectedWork?.id)) ? `Repartidos en ${plural(works.size, 'obra', 'obras')}.` : '',
      guesses.size ? `Revisa las obras detectadas: ${[...guesses].map(([f, t]) => `«${f}» → ${t}`).join(' · ')}.` : '',
      guessedNumbers ? `${plural(guessedNumbers, 'carpeta', 'carpetas')} sin número: se les asignó el siguiente libre.` : '',
      extras ? `${plural(extras, 'se marcó como extra', 'se marcaron como extras')} por el nombre de la carpeta.` : '',
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
  await offerSkipPublished(items)
}

/* ---------- Capítulos que ya están publicados ---------- */

/**
 * Busca en la lista capítulos cuyo número ya existe en su obra y pregunta si omitirlos.
 * Los omitidos pasan a «Capítulos subidos» como «Ya estaba publicado».
 */
/** Capítulos de la lista cuyo número ya existe en su obra: [{ it, remote }]. */
function findPublished(items, { includeKept = false } = {}) {
  const found = []
  for (const it of items) {
    if (!batch.items.includes(it) || it.status === 'done' || it.workId == null || it.number == null) continue
    if (!includeKept && it.keptPublished === itemSlot(it)) continue // ya se preguntó y se decidió dejarlo
    const remote = workChapters(it.workId, Boolean(it.extra)).find((c) => shownNumber(c) === it.number)
    if (remote) found.push({ it, remote })
  }
  return found
}

/** «12:c5» o «12:e2»: obra, tipo (capítulo o extra) y número. */
const itemSlot = (it) => `${it.workId}:${it.extra ? 'e' : 'c'}${it.number}`
const itemLabel = (it) => chapterLabel(it.number, it.extra)

/** «caps 1–3, 5 · extras 1–2» */
function slotRanges(items) {
  const caps = items.filter((i) => !i.extra).map((i) => i.number)
  const extras = items.filter((i) => i.extra).map((i) => i.number)
  return [
    caps.length ? `${caps.length === 1 ? 'cap' : 'caps'} ${numberRanges(caps)}` : '',
    extras.length ? `${extras.length === 1 ? 'extra' : 'extras'} ${numberRanges(extras)}` : '',
  ].filter(Boolean).join(' · ')
}

/** Saca de la cola los ya publicados y los deja en «Capítulos subidos» como «Ya estaba publicado». */
function skipPublished(found) {
  const ids = new Set(found.map((f) => f.it.id))
  // Del más viejo al más nuevo, para que la lista de subidos quede en orden de capítulo.
  for (const f of [...found].sort((a, b) => Number(Boolean(a.it.extra)) - Number(Boolean(b.it.extra)) || a.it.number - b.it.number)) pushUploaded(uploadedEntry(f.it, f.remote, 'existing'))
  saveUploaded()
  batch.items = batch.items.filter((i) => !ids.has(i.id))
  toast('success', plural(found.length, 'capítulo omitido', 'capítulos omitidos'), 'Quedaron en «Capítulos subidos» como «Ya estaba publicado».')
}

async function offerSkipPublished(items) {
  if (state.uploading) return
  const found = findPublished(items)
  if (!found.length) return

  const byWork = new Map()
  for (const f of found) {
    if (!byWork.has(f.it.workId)) byWork.set(f.it.workId, [])
    byWork.get(f.it.workId).push(f)
  }
  const samePages = found.filter((f) => f.remote.pages == null || f.remote.pages === f.it.files.length).length
  const differ = found.filter((f) => f.remote.pages != null && f.remote.pages !== f.it.files.length)
  const list = [...byWork].map(([workId, fs]) =>
    `«${workById(workId)?.title || 'Obra'}»: ${slotRanges(fs.map((f) => f.it))}`)
  differ.slice(0, 5).forEach((f) => list.push(`${itemLabel(f.it)}: ${f.it.files.length} páginas aquí y ${f.remote.pages} en Capibara`))
  const total = batch.items.filter((i) => i.status !== 'done').length

  const choice = await ask({
    kind: 'warn',
    title: found.length === total
      ? `${found.length === 1 ? 'Este capítulo ya está publicado' : `Los ${found.length} capítulos ya están publicados`}`
      : `${found.length} de los ${total} capítulos ya están publicados`,
    text: differ.length
      ? `${plural(samePages, 'tiene', 'tienen')} la misma cantidad de páginas; ${plural(differ.length, 'tiene', 'tienen')} distinta cantidad: revísalos.`
      : 'Coinciden en número y cantidad de páginas con los de Capibara. Si los dejas, no se podrán subir con ese número.',
    list,
    more: Math.max(0, differ.length - 5),
    buttons: [
      { value: 'keep', label: 'Dejarlos en la lista', cancel: true },
      { value: 'skip', label: found.length === 1 ? 'Omitirlo' : `Omitir los ${found.length}`, kind: 'primary' },
    ],
  })

  if (choice === 'skip') {
    skipPublished(found)
  } else {
    for (const f of found) f.it.keptPublished = itemSlot(f.it)
  }
  renderBatch()
  renderUploaded()
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
  await offerSkipPublished(targets)
}

function batchReset() {
  if (state.uploading) return
  batch.items = []
  state.attempted = false
  renderBatch()
  batchValidate()
}

/* ---------- Eventos (se suscriben en el init) ---------- */

/** Al cambiar de scan, las obras asignadas ya no sirven: se vuelven a detectar al cargar. */
function batchOnScanChanged() {
  for (const it of batch.items) {
    if (it.status === 'done') continue
    it.workId = null
    it.workGuess = false
  }
  loadUploaded()
  renderBatch()
}

/** Cuando cargan las obras del scan, se intenta asignar las que quedaron sin obra. */
async function batchOnWorksLoaded() {
  loadUploaded()
  const orphans = pendingItems().filter((i) => i.workId == null)
  if (!orphans.length) return
  for (const it of orphans) {
    const m = guessWork(it.ancestors || [it.parent], it.name)
    if (m) { it.workId = m.work.id; it.workGuess = true }
  }
  await Promise.all([...new Set(orphans.map((i) => i.workId).filter((id) => id != null))].map((id) => ensureChapters(id)))
  allocateAutoNumbers(orphans)
  renderBatch()
  batchValidate()
  await offerSkipPublished(orphans)
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
  queue.forEach((i) => { if (i.number != null && i.workId != null) { const k = itemSlot(i); counts.set(k, (counts.get(k) || 0) + 1) } })
  const existing = new Map()
  const existingFor = (workId, extra) => {
    const k = `${workId}:${extra}`
    if (!existing.has(k)) existing.set(k, new Set(workChapters(workId, extra).map(shownNumber)))
    return existing.get(k)
  }

  let bad = 0
  for (const it of batch.items) {
    let err = ''
    let always = false // errores que se muestran aunque aún no se intente subir
    if (it.status !== 'done') {
      const s = plan.map.get(it.id) || {}
      const work = workById(it.workId)
      if (!work) err = state.works.length ? 'Elige la obra de este capítulo.' : 'Cargando las obras del scan…'
      else if (it.number == null || Number.isNaN(it.number)) err = it.extra ? 'Falta el número del extra.' : 'Falta el número del capítulo.'
      else if (it.number < 0) err = 'El número no puede ser negativo.'
      else if (it.number >= EXTRA_BASE) { err = `El número debe ser menor que ${formatNumber(EXTRA_BASE)}.`; always = true }
      else if (it.extra && !hasCap('extras')) { err = `${plat().label} no tiene extras: márcalo como capítulo o quítalo de la lista.`; always = true }
      // Si ya quedó en la plataforma activa y solo falta en otra, no cuenta como repetido.
      else if (!it.doneOn?.has(state.platform) && existingFor(it.workId, Boolean(it.extra)).has(it.number)) { err = `${it.extra ? 'El extra' : 'El capítulo'} ${it.number} ya existe en «${work.title}».`; always = true }
      else if (counts.get(itemSlot(it)) > 1) { err = `${it.extra ? 'El extra' : 'El número'} ${it.number} está repetido en «${work.title}».`; always = true }
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
      const n = numberNote(it)
      it.refs.note.className = `ch-note${n ? ` ${n.cls}` : ''}`
      it.refs.note.textContent = n ? n.text : ''
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

  const p = activeProfile()
  if (isCapibara() && ((state.me && !state.me.key.scopes.includes('chapters:write')) || (p && !canWrite(p)))) errors.scope = 'La clave de este scan no tiene el permiso chapters:write.'
  if (!state.hasKey) errors.key = isCapibara() ? 'Agrega un scan.' : `Inicia sesión en ${plat().full}.`
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
  const lim = hourLimits()
  if (isCapibara() && (queue.length > lim.chapters || pages > lim.images)) {
    t += ` · Supera el límite por hora del scan (${formatNumber(lim.chapters)} capítulos / ${formatNumber(lim.images)} imágenes): la subida se pausará sola hasta que se libere`
  }
  sub.textContent = t
}

/* ---------- Render ---------- */

/** Aviso bajo la fila cuando el número no es el que trae el nombre de la carpeta. */
function numberNote(it) {
  if (it.status === 'done' || it.number == null || Number.isNaN(it.number)) return null
  if (it.parsedNumber != null && (it.number !== it.parsedNumber || Boolean(it.parsedExtra) !== Boolean(it.extra))) {
    return { cls: 'warn', text: `La carpeta dice ${chapterLabel(it.parsedNumber, it.parsedExtra).toLowerCase()} → se subirá como ${itemLabel(it).toLowerCase()}` }
  }
  if (it.extra && it.parsedExtra && it.parsedNumber == null && it.numberSource === 'auto') {
    return { cls: 'info', text: 'Extra sin número en el nombre: se le asignó el siguiente libre' }
  }
  if (it.parsedNumber == null && it.numberSource === 'auto') {
    return { cls: 'info', text: 'La carpeta no trae número: se le asignó el siguiente libre' }
  }
  return null
}

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
  it.refs.status.title = it.status === 'done' && it.result?.url ? `Abrir en ${plat().label}` : it.status === 'error' ? it.error : ''
  it.refs.progress.style.width = `${it.status === 'done' ? 100 : Math.round((it.progress || 0) * 100)}%`
  if (it.status === 'error') it.refs.error.textContent = it.error
}

function chapterRow(it) {
  const locked = state.uploading || it.status === 'done'
  const total = sumSize(it.files)
  const tooBig = it.files.filter((f) => f.size > MAX_BYTES).length

  const num = el('input', {
    type: 'number', step: 'any', min: '0', placeholder: '—', value: it.number ?? '', disabled: locked, title: it.extra ? 'Número del extra' : 'Número de capítulo',
    oninput: (e) => { it.number = e.target.value === '' ? null : Number(e.target.value); it.numberAuto = false; it.numberSource = 'manual'; batchValidate() },
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
  const note = el('div', { class: 'ch-note' })
  const error = el('div', { class: 'ch-error' })
  const status = el('span', {
    class: 'ch-status',
    onclick: () => { if (it.status === 'done' && it.result?.url) window.capi.system.openExternal(it.result.url) },
  })
  const progress = el('div')
  const handle = el('div', { class: 'ch-handle', html: ICON_GRIP, title: 'Arrastra para reordenar dentro de la obra' })
  // Capítulo normal o extra («Extra N»: arte, ilustración, contenido fuera de capítulos).
  const kindBtn = (extra, label, hint) => el('button', {
    type: 'button', class: Boolean(it.extra) === extra ? 'on' : '', disabled: locked, title: hint,
    'aria-pressed': String(Boolean(it.extra) === extra), onclick: () => setItemExtra(it, extra),
  }, label)
  const kind = el('div', { class: `ch-kind${it.extra ? ' extra' : ''}`, role: 'group', 'aria-label': 'Tipo', 'data-cap': 'extras' },
    kindBtn(false, 'Capítulo', 'Capítulo normal: lleva el número de capítulo de la obra.'),
    kindBtn(true, 'Extra', 'Extra: arte, ilustración o contenido fuera de capítulos. Se muestra como «Extra N» y no cuenta como capítulo.'))

  const row = el('li', { class: 'chrow', dataset: { id: it.id, status: it.status } },
    handle,
    el('div', { class: 'ch-cover', title: 'Ver y ordenar las páginas de este capítulo', onclick: () => openPagesModal(it) },
      it.files[0] ? el('img', { src: it.files[0].url, alt: '', loading: 'lazy', decoding: 'async' }) : null,
      el('span', { class: 'thumb-num', text: String(it.files.length) }),
      el('span', { class: 'ch-cover-hint', html: `${ICON_PAGES}<span>Ver páginas</span>` })),
    el('div', { class: 'ch-body' },
      el('div', { class: 'ch-fields' },
        kind,
        el('label', { class: `ch-field${it.extra ? ' extra' : ''}` }, el('span', { class: 'pre', text: it.extra ? 'Extra' : 'Cap' }), num),
        el('label', { class: 'ch-field', 'data-cap': 'volume' }, el('span', { class: 'pre', text: 'Vol' }), vol),
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
      note,
      error),
    el('div', { class: 'ch-side' },
      el('div', { class: 'ch-side-top' },
        status,
        el('button', { type: 'button', class: 'icon-btn small ghost', title: 'Quitar este capítulo de la lista (no borra nada de tu carpeta ni de la plataforma)', html: ICONS.x, disabled: state.uploading, onclick: () => removeChapter(it.id) })),
      el('div', { class: 'ch-actions' },
        el('button', {
          type: 'button', class: 'btn secondary small', disabled: locked, onclick: (e) => openWorkPicker(e.currentTarget, [it]),
          title: `Subir solo este capítulo a otra obra del scan (ahora: «${workById(it.workId)?.title || 'sin obra'}»)`,
        }, el('span', { html: ICON_BOOK }), 'Cambiar obra'),
        el('button', {
          type: 'button', class: 'btn secondary small', onclick: () => openPagesModal(it),
          title: 'Ver las páginas en orden, reordenarlas, quitar alguna y marcar páginas simples o la destacada',
        }, el('span', { html: ICON_PAGES }), 'Ver páginas'))),
    el('div', { class: 'ch-progress' }, progress),
  )

  // Solo se arrastra desde el asa, para no interferir con los campos de texto.
  handle.addEventListener('mousedown', () => { if (!locked) row.draggable = true })
  row.addEventListener('dragend', () => { row.draggable = false })

  it.refs = { row, num, vol, when, note, error, status, progress }
  updateRowStatus(it)
  return row
}

function groupHeader(g) {
  const work = workById(g.workId)
  const pending = g.items.filter((i) => i.status !== 'done')
  const nums = g.items.filter((i) => !i.extra).map((i) => i.number).filter((n) => n != null && !Number.isNaN(n))
  const extras = g.items.filter((i) => i.extra).length
  const last = workLatest(g.workId)
  const guessed = g.items.some((i) => i.workGuess)
  const meta = [
    plural(g.items.length, 'capítulo', 'capítulos'),
    nums.length ? (nums.length > 1 ? `#${Math.min(...nums)}–${Math.max(...nums)}` : `#${nums[0]}`) : null,
    extras ? plural(extras, 'extra', 'extras') : null,
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
      work && pending.some((i) => !i.extra) ? el('button', {
        type: 'button', class: 'btn ghost small', title: 'Numerar en orden desde el siguiente al último publicado (los extras no se tocan)', disabled: state.uploading,
        onclick: async () => {
          const start = last ? Math.floor(last.number) + 1 : 1
          const res = await renumberGroups([g], () => start)
          if (!res?.count) return
          toast('success', `«${work.title}» renumerada`, res.all
            ? `Del ${start} al ${start + res.count - 1}.`
            : `${plural(res.count, 'capítulo sin número', 'capítulos sin número')} desde el ${start}; los demás conservan el de su carpeta.`)
        },
      }, 'Numerar desde el último') : null,
      el('button', {
        type: 'button', class: `btn ${work ? 'secondary' : 'primary'} small`, disabled: state.uploading || !pending.length,
        title: work ? `Pasar los ${plural(g.items.length, 'capítulo', 'capítulos')} de este grupo a otra obra` : 'Elegir la obra de estos capítulos',
        onclick: (e) => openWorkPicker(e.currentTarget, g.items),
      }, el('span', { html: ICON_BOOK }), work ? (g.items.length > 1 ? 'Cambiar obra de todos' : 'Cambiar obra') : 'Elegir obra')))
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

  // Se vuelve a dibujar a menudo (p. ej. cada vez que un capítulo sale de la cola): sin saltar al inicio.
  const scroll = list.scrollTop
  list.innerHTML = ''
  for (const g of groupedItems()) {
    list.append(groupHeader(g))
    g.items.forEach((it) => list.append(chapterRow(it)))
  }
  if (has && !state.uploading) {
    list.append(el('li', { class: 'add-row', onclick: pickChapters, html: `${ICONS.plus}<span>Agregar más carpetas</span>` }))
  }
  list.scrollTop = scroll
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
  $('#batchClearBtn').addEventListener('click', batchReset)
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

/* ---------- Capítulos que llegan de «Importar de web» (su propia ventana) ---------- */

/** Agrega los capítulos importados con su obra y, si se pidió, la publicación escalonada. */
async function batchReceiveImport({ dirs, workId, interval, unit }) {
  const res = await window.capi.files.resolveChapters(dirs)
  if (!res.ok) return toast('error', 'No se pudieron preparar los capítulos importados', res.error.message)
  setView('upload')
  setMode('batch')
  if (interval > 0) {
    $('#scheduleToggle').checked = true
    // El primero sale en 15 minutos; los demás, uno cada intervalo.
    const first = new Date(Date.now() + 15 * 60e3)
    first.setSeconds(0, 0)
    first.setMinutes(Math.ceil(first.getMinutes() / 5) * 5)
    $('#publishAt').value = toLocalInput(first)
    $('#batchInterval').value = String(interval)
    $('#batchIntervalUnit').value = unit
    $('#scheduleBox').hidden = false
  }
  await addChapters(res.data, { workId })
  validate()
  toast('success', `${plural(res.data.chapters.length, 'capítulo importado', 'capítulos importados')}`,
    interval > 0
      ? `Programados uno ${every(interval, unit)} desde ${formatDate(new Date($('#publishAt').value))}. Revisa la lista y pulsa «Subir capítulos».`
      : 'Revisa la lista y pulsa «Subir capítulos».', 10000)
}

function initBatch() {
  window.capi.import.onHandoff(batchReceiveImport)
  for (const id of ['#batchImportBtn', '#batchImportEmpty']) $(id).addEventListener('click', (e) => { e.stopPropagation(); window.capi.import.openWindow() })
  on('scanChanged', batchOnScanChanged)
  on('worksLoaded', batchOnWorksLoaded)
  on('workSelected', batchOnWorkSelected)
  initBatchDrop()
  initPagesModal()
  initWorkPicker()
  initUploaded()
  $$('#modeSwitch button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)))

  $('#batchVolume').addEventListener('input', () => { batch.volumeAuto = false; batchValidate() })
  $('#announceDefault').addEventListener('change', () => {
    renderThumbs()
    if (state.mode === 'batch') renderBatch()
    validate()
  })
  $('#renumberBtn').addEventListener('click', async () => {
    const start = Number($('#renumberFrom').value)
    if ($('#renumberFrom').value.trim() === '' || Number.isNaN(start) || start < 0) {
      $('#renumberFrom').focus()
      return toast('warn', 'Indica desde qué número empezar')
    }
    const res = await renumberGroups(groupedItems(), () => start)
    if (!res?.count) return
    toast('success', 'Capítulos renumerados', res.all
      ? `Cada obra empieza en el ${start}, en el orden de la lista.`
      : `${plural(res.count, 'capítulo sin número', 'capítulos sin número')} desde el ${start}; los demás conservan el de su carpeta.`)
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
    $('#doneOpen').textContent = `Ver en ${plat().label}`
    $('#doneNext').textContent = 'Subir otro capítulo'
  })

  renderBatch()
  setMode(localStorage.getItem('mode') || 'single')
}
