'use strict'

/* =========================================================
   Modo «Varios capítulos»
   Usa las utilidades y el estado globales de app.js.
   Cada capítulo lleva su propia obra (del scan activo).
   ========================================================= */
const batch = {
  // { id, name, dir, parent, files, workId, workGuess, number, numberAuto, volume, volumeAuto, title,
  //   parsedNumber, numberSource, keptPublished, status, progress, error, result, refs }
  // parsedNumber: el número que trae el nombre de la carpeta (null si no trae).
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
const UNIT_TEXT = {
  minutes: ['minuto', 'minutos'], hours: ['hora', 'horas'], days: ['día', 'días'], weeks: ['semana', 'semanas'],
}
/** «1 día», «3 días», «cada día» en vez de «cada 1 días». */
const amount = (n, unit) => `${n} ${UNIT_TEXT[unit][n === 1 ? 0 : 1]}`
const every = (n, unit) => (n === 1 ? `cada ${UNIT_TEXT[unit][0]}` : `cada ${amount(n, unit)}`)
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

const workById = (id) => (id == null ? null : state.works.find((w) => w.id === id) || null)
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

/* ---------- Preguntas ---------- */

let askChain = Promise.resolve()

/**
 * Muestra una pregunta y resuelve con el `value` del botón elegido.
 * Escape o un clic fuera eligen el botón marcado con `cancel`. Las preguntas se encolan.
 * Con `input` ({ label, value, type }) muestra un campo y resuelve con { value, input }; Enter
 * en el campo elige el botón principal.
 */
function ask({ kind = 'warn', title, text = '', list = [], more = 0, buttons, input = null }) {
  const run = () => new Promise((resolve) => {
    const modal = $('#askModal')
    const cancel = buttons.find((b) => b.cancel) || buttons[0]
    $('#askIcon').innerHTML = kind === 'info' ? ICONS.info : ICONS.warn
    $('#askIcon').className = `modal-icon ${kind}`
    $('#askTitle').textContent = title
    $('#askText').textContent = text
    const ul = $('#askList')
    ul.innerHTML = ''
    list.forEach((line) => ul.append(el('li', { text: line })))
    if (more > 0) ul.append(el('li', { class: 'more', text: `…y ${more} más` }))
    ul.hidden = !list.length
    const field = $('#askInput')
    $('#askInputWrap').hidden = !input
    if (input) {
      $('#askInputLabel').textContent = input.label || ''
      field.type = input.type || 'text'
      field.value = input.value ?? ''
    }
    const actions = $('#askActions')
    actions.innerHTML = ''
    const done = (value) => {
      modal.hidden = true
      document.removeEventListener('keydown', onKey, true)
      modal.removeEventListener('mousedown', onBackdrop)
      field.onkeydown = null
      resolve(input ? { value, input: field.value.trim() } : value)
    }
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(cancel.value) } }
    const onBackdrop = (e) => { if (e.target === modal) done(cancel.value) }
    buttons.forEach((b, i) => {
      if (i === 1 && buttons.length > 2) actions.append(el('span', { class: 'spacer' }))
      actions.append(el('button', { type: 'button', class: `btn ${b.kind || 'secondary'}`, onclick: () => done(b.value) }, b.label))
    })
    if (buttons.length <= 2) actions.prepend(el('span', { class: 'spacer' }))
    document.addEventListener('keydown', onKey, true)
    modal.addEventListener('mousedown', onBackdrop)
    modal.hidden = false
    // El foco va al botón marcado con focus, si no a la opción recomendada y si no a la de cancelar
    // (nunca a una peligrosa).
    const target = buttons.find((b) => b.focus) || buttons.find((b) => b.kind === 'primary') || cancel
    if (input) {
      const primary = buttons.find((b) => b.kind === 'primary')
      field.onkeydown = (e) => { if (e.key === 'Enter' && primary) { e.preventDefault(); done(primary.value) } }
      field.focus()
      field.select()
    } else {
      ;[...actions.querySelectorAll('button')][buttons.indexOf(target)]?.focus()
    }
  })
  const p = askChain.then(run)
  askChain = p.catch(() => {})
  return p
}

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
  if (score >= 0.85) return { work: best, sure: true, score }
  if (score >= 0.6) return { work: best, sure: false, score }
  return null
}

const VOL_RE = /\b(?:vol(?:umen|ume)?|tomo|v)\s*[.#:-]?\s*(\d+)\b/i
const CAP_RE = /\b(?:cap(?:[ií]tulo|itulo)?|chapter|chap|ch|ep(?:isodio|isode)?|c)\s*[.#:-]?\s*(\d+(?:[.,]\d+)?)/i

/** Quita guiones bajos y lo que va entre corchetes, paréntesis o llaves: «Choujin X [Scan] (2023)» → «Choujin X». */
const cleanFolderName = (raw) => String(raw || '').replace(/_+/g, ' ').replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, ' ').replace(/\s+/g, ' ').trim()

/** La parte del nombre de un capítulo que nombra a la obra: «Choujin X Cap 12 - Título» → «Choujin X». */
function workHintFromName(raw) {
  let s = cleanFolderName(raw)
  const cap = s.match(CAP_RE)
  if (cap) s = s.slice(0, cap.index)
  else {
    const m = s.match(/^(.*?)(?:\s+|[-–—_]+)\d+(?:[.,]\d+)?(?:\s*[-–—:|].*)?$/)
    if (m) s = m[1]
    else if (/^\s*\d/.test(s)) s = ''
  }
  s = s.replace(VOL_RE, ' ')
  return s.replace(/[-–—:|]+\s*$/, '').replace(/\s+/g, ' ').trim()
}

/** Tomo según la carpeta que contiene al capítulo, si se llama «Vol 2», «Tomo 3», «Volumen 01»… */
function volumeFromFolder(name) {
  const m = cleanFolderName(name).match(/^(?:vol(?:umen|ume)?|tomo|v)\s*[.#:-]?\s*(\d+)$/i)
  return m ? parseInt(m[1], 10) : null
}

/**
 * Adivina la obra de un capítulo: primero por las carpetas que lo contienen, de la más cercana
 * a la más lejana («Lote/Choujin X/Vol 1/Cap 3» → «Choujin X»), y si no, por su propio nombre
 * («Choujin X Cap 12»). Devuelve { work, sure, score, from } o null.
 */
function guessWork(ancestors, name) {
  let best = null
  const consider = (text, from) => {
    const m = text ? matchWork(text) : null
    if (m && (!best || m.score > best.score)) best = { ...m, from }
    return m?.sure
  }
  for (const a of ancestors) {
    // Tal cual (sin corchetes) y sin números de tomo o capítulo; no se recorta un número
    // final sin más, porque hay obras como «Kaiju No. 8» o «Mob Psycho 100».
    const cands = new Set([cleanFolderName(a), workHintFromName(a)])
    for (const c of cands) if (consider(c, a)) return best
  }
  consider(workHintFromName(name), name)
  return best
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

/**
 * Renumera en orden los capítulos pendientes de cada grupo, empezando en startFor(grupo).
 * Si alguno trae el número en el nombre de su carpeta, pregunta antes de cambiárselo.
 * Devuelve { count, all } o null si se canceló.
 */
async function renumberGroups(groups, startFor) {
  const targets = groups
    .map((g) => ({ g, items: g.items.filter((i) => i.status !== 'done') }))
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
    if (!includeKept && it.keptPublished === `${it.workId}:${it.number}`) continue // ya se preguntó y se decidió dejarlo
    const remote = workChapters(it.workId).find((c) => Number(c.number) === it.number)
    if (remote) found.push({ it, remote })
  }
  return found
}

/** Saca de la cola los ya publicados y los deja en «Capítulos subidos» como «Ya estaba publicado». */
function skipPublished(found) {
  const ids = new Set(found.map((f) => f.it.id))
  // Del más viejo al más nuevo, para que la lista de subidos quede en orden de capítulo.
  for (const f of [...found].sort((a, b) => a.it.number - b.it.number)) pushUploaded(uploadedEntry(f.it, f.remote, 'existing'))
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
    `«${workById(workId)?.title || 'Obra'}»: ${fs.length === 1 ? 'cap' : 'caps'} ${numberRanges(fs.map((f) => f.it.number))}`)
  differ.slice(0, 5).forEach((f) => list.push(`Cap ${f.it.number}: ${f.it.files.length} páginas aquí y ${f.remote.pages} en Capibara`))
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
    for (const f of found) f.it.keptPublished = `${f.it.workId}:${f.it.number}`
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

/* ---------- Ganchos con app.js ---------- */

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

/* ---------- Capítulos subidos (se guardan por scan) ---------- */

const UPLOADED_MAX = 1000
const uploadedKey = () => `uploaded:${state.activeScanId}`

function loadUploaded() {
  if (batch.uploadedScan === state.activeScanId) return
  batch.uploadedScan = state.activeScanId
  batch.uploaded = []
  if (state.activeScanId != null) {
    try { batch.uploaded = JSON.parse(localStorage.getItem(uploadedKey()) || '[]') } catch { batch.uploaded = [] }
  }
  renderUploaded()
}

function saveUploaded() {
  if (batch.uploaded.length > UPLOADED_MAX) batch.uploaded.length = UPLOADED_MAX
  if (state.activeScanId == null) return
  try { localStorage.setItem(uploadedKey(), JSON.stringify(batch.uploaded)) } catch { /* sin espacio: queda solo en memoria */ }
}

/**
 * Agrega al inicio; si el mismo capítulo de la misma obra ya estaba en la lista, lo reemplaza.
 * Un «Ya estaba publicado» no reemplaza al registro de cuando lo subió el programa.
 */
function pushUploaded(entry) {
  const same = (e) => e.workId === entry.workId && e.number === entry.number
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
    number: existing ? Number(data.number) : it.number,
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
  if (e.kind === 'trashed') return { cls: 'trashed', text: 'En la papelera' }
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
        el('b', { text: `Cap ${e.number}` }),
        e.volume != null ? el('span', { class: 'up-vol', text: `· Vol ${e.volume}` }) : null,
        e.title ? el('span', { class: 'up-name', text: `— ${e.title}` }) : null,
        el('span', { class: 'up-work', text: e.workTitle })),
      el('div', { class: 'ch-meta' },
        el('span', { class: 'folder', text: `📁 ${e.folder}`, title: e.dir }),
        el('span', { class: 'sep' }),
        el('span', { class: pagesDiffer ? 'bad' : '', text: pagesDiffer ? `${e.pages} pág. aquí · ${e.remotePages} en Capibara` : `${e.pages} pág.` }),
        el('span', { class: 'sep' }),
        el('span', { text: relativeFromNow(new Date(e.at)), title: formatDate(new Date(e.at)) }))),
    el('span', { class: `up-status ${st.cls}`, text: st.text }),
    e.url && e.kind !== 'trashed'
      ? el('button', { type: 'button', class: 'icon-btn small ghost', title: 'Abrir en Capibara', html: ICON_OPEN, onclick: () => window.capi.system.openExternal(e.url) })
      : el('span', { class: 'up-noop' }),
    el('button', {
      type: 'button', class: 'icon-btn small ghost', html: ICON_MORE, onclick: () => uploadedActions(e),
      title: e.kind === 'trashed' ? 'Restaurar o volver a subir' : 'Cambiar número, publicar ya o mandar a la papelera',
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
    trashed ? plural(trashed, 'en la papelera', 'en la papelera') : '',
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
      text: 'Solo se borra esta lista del programa. Los capítulos siguen en Capibara.',
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
  const found = list?.find((c) => Number(c.number) === Number(e.number))
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
  if (!canWrite(state.me?.key)) return toast('warn', 'No se puede cambiar', 'Esta API key no tiene el permiso chapters:write.')
  const name = `Cap ${e.number} de «${e.workTitle || 'la obra'}»`

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

async function renumberUploaded(e, id) {
  const r = await ask({
    kind: 'info',
    title: `Cambiar el número del cap ${e.number}`,
    text: `«${e.workTitle}». Si el número nuevo ya existe en la obra, Capibara no deja cambiarlo.`,
    input: { label: 'Número nuevo', value: String(e.number), type: 'number' },
    buttons: [{ value: 'no', label: 'Cancelar', cancel: true }, { value: 'yes', label: 'Cambiar', kind: 'primary' }],
  })
  if (r.value !== 'yes') return
  const n = Number(String(r.input).replace(',', '.'))
  if (r.input === '' || !Number.isFinite(n) || n < 0) return toast('warn', 'Número no válido', 'Escribe un número, por ejemplo 12 o 12.5.')
  if (n === Number(e.number)) return
  const res = await window.capi.chapter.setNumber(id, n)
  if (!res.ok) return handleApiError(res.error, `No se pudo cambiar el cap ${e.number}`)
  const old = e.number
  // Otra entrada de la lista con ese número en la obra era de un capítulo que ya no lo tiene.
  batch.uploaded = batch.uploaded.filter((x) => x === e || !(x.workId === e.workId && Number(x.number) === n && x.kind !== 'trashed'))
  e.number = n
  if (res.data?.url) e.url = res.data.url
  toast('success', `Cap ${old} → cap ${n}`, `«${e.workTitle}»`)
  afterUploadedChange(e)
}

async function publishUploaded(e, id) {
  const choice = await ask({
    kind: 'info',
    title: `¿Publicar ya el cap ${e.number}?`,
    text: `«${e.workTitle}» estaba programado${e.publishAt ? ` para el ${formatDate(new Date(e.publishAt))}` : ''}.`,
    buttons: [
      { value: 'no', label: 'Cancelar', cancel: true },
      { value: 'quiet', label: 'Publicar sin avisos' },
      { value: 'notify', label: 'Publicar y avisar', kind: 'primary' },
    ],
  })
  if (choice !== 'quiet' && choice !== 'notify') return
  const res = await window.capi.chapter.publish(id, { notify: choice === 'notify' })
  if (!res.ok) return handleApiError(res.error, `No se pudo publicar el cap ${e.number}`)
  e.state = 'published'
  e.publishAt = null
  toast('success', `Cap ${e.number} publicado`, choice === 'notify' ? 'Salieron los avisos de siempre.' : 'Sin avisos.')
  afterUploadedChange(e)
}

async function trashUploaded(e, id) {
  const choice = await ask({
    kind: 'warn',
    title: `¿Mandar el cap ${e.number} a la papelera?`,
    text: `«${e.workTitle}». Deja de verse en Capibara y su número queda libre. Se puede restaurar durante 30 días, aquí o desde el panel.`,
    buttons: [{ value: 'no', label: 'Cancelar', cancel: true, focus: true }, { value: 'yes', label: 'Mandar a la papelera', kind: 'danger-solid' }],
  })
  if (choice !== 'yes') return
  const res = await window.capi.chapter.trash(id)
  if (!res.ok) return handleApiError(res.error, `No se pudo borrar el cap ${e.number}`)
  e.trashedFrom = e.kind
  e.kind = 'trashed'
  e.trashedAt = new Date().toISOString()
  toast('success', `Cap ${e.number} en la papelera`, 'Puedes restaurarlo o volver a poner su carpeta en la cola desde esta lista.')
  afterUploadedChange(e)
}

async function restoreUploaded(e) {
  const id = e.chapterId
  if (!id) return toast('error', 'No se puede restaurar desde aquí', 'Restáuralo desde la papelera del panel.')
  const res = await window.capi.chapter.restore(id)
  if (!res.ok) return handleApiError(res.error, `No se pudo restaurar el cap ${e.number}`)
  e.kind = e.trashedFrom || 'uploaded'
  delete e.trashedFrom
  delete e.trashedAt
  toast('success', `Cap ${e.number} restaurado`, `«${e.workTitle}»`)
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
  const lim = hourLimits()
  if (queue.length > lim.chapters || pages > lim.images) {
    t += ` · Supera el límite por hora del scan (${formatNumber(lim.chapters)} capítulos / ${formatNumber(lim.images)} imágenes): la subida se pausará sola hasta que se libere`
  }
  sub.textContent = t
}

/* ---------- Render ---------- */

/** Aviso bajo la fila cuando el número no es el que trae el nombre de la carpeta. */
function numberNote(it) {
  if (it.status === 'done' || it.number == null || Number.isNaN(it.number)) return null
  if (it.parsedNumber != null && it.number !== it.parsedNumber) {
    return { cls: 'warn', text: `La carpeta dice cap ${it.parsedNumber} → se subirá como cap ${it.number}` }
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
      note,
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

  it.refs = { row, num, vol, when, note, error, status, progress }
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
  if (!(await confirmNumbering(queue))) return
  const scanName = activeProfile()?.name || 'tu scan'
  const workIds = [...new Set(queue.map((i) => i.workId))]
  for (const it of queue) { it.status = 'pending'; it.error = ''; it.progress = 0; it.ratePauses = 0 }
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
      const entry = { id: res.data.id, number: it.number, volumeNumber: it.volume, title: it.title || '', pages: it.files.length, state: res.data.state, url: res.data.url }
      if (cache) cache.push(entry)
      if (state.selectedWork?.id === it.workId && state.chapters !== cache) state.chapters.push(entry)
      // Sale de la cola y pasa a «Capítulos subidos».
      pushUploaded(uploadedEntry(it, res.data, 'uploaded'))
      saveUploaded()
      batch.items = batch.items.filter((i) => i !== it)
      renderBatch()
      renderUploaded()
    } else if (res.error.code === 'cancelled') {
      it.status = 'pending'
      it.progress = 0
      stopped = true
    } else if (res.error.code === 'api.rate_limited' && res.error.retryAfter && it.ratePauses < MAX_RATE_PAUSES) {
      // Un límite por hora: se espera lo que dice Capibara y se reintenta este mismo capítulo
      // (las páginas ya subidas se reutilizan).
      it.ratePauses++
      it.status = 'pending'
      it.progress = 0
      updateRowStatus(it)
      bytesBefore -= sumSize(it.files)
      if (await waitRateLimit(res.error)) { pos--; continue }
      stopped = true
    } else {
      it.status = 'error'
      it.error = withTrace(res.error)
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

/** Espera a que Capibara libere el límite, con cuenta atrás en la barra. false si se canceló. */
async function waitRateLimit(error) {
  const until = Date.now() + (error.retryAfter + 3) * 1000
  const at = new Date(until).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
  toast('warn', 'Subida en pausa', `${error.message} Sigue sola a las ${at}; puedes dejar el programa abierto.`, 12000)
  while (Date.now() < until) {
    if (batch.cancelled) return false
    const left = Math.ceil((until - Date.now()) / 1000)
    $('#progressText').textContent = `En pausa por un límite de Capibara · sigue a las ${at} (falta ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')})`
    await new Promise((r) => setTimeout(r, 1000))
  }
  return !batch.cancelled
}

/**
 * Antes de subir: si algún capítulo va con un número distinto al de su carpeta, o con uno
 * asignado solo porque la carpeta no lo trae, se muestra el resumen y se pide confirmación.
 */
async function confirmNumbering(queue) {
  const odd = queue.filter((i) => i.parsedNumber != null && i.number !== i.parsedNumber)
  const auto = queue.filter((i) => i.parsedNumber == null && i.numberSource === 'auto')
  if (!odd.length && !auto.length) return true
  const MAX = 8
  const lines = [
    ...odd.map((i) => `«${i.name}» → cap ${i.number} (la carpeta dice ${i.parsedNumber})`),
    ...auto.map((i) => `«${i.name}» → cap ${i.number} (la carpeta no trae número)`),
  ]
  const choice = await ask({
    kind: 'warn',
    title: 'Revisa la numeración antes de subir',
    text: [
      odd.length ? `${plural(odd.length, 'capítulo se subirá', 'capítulos se subirán')} con un número distinto al de su carpeta.` : '',
      auto.length ? `${plural(auto.length, 'capítulo no trae', 'capítulos no traen')} número en el nombre y se numeró solo.` : '',
    ].filter(Boolean).join(' '),
    list: lines.slice(0, MAX),
    more: lines.length - MAX,
    buttons: [
      { value: 'review', label: 'Revisar', cancel: true, focus: true },
      { value: 'go', label: 'Subir así', kind: 'primary' },
    ],
  })
  if (choice === 'go') return true
  const first = odd[0] || auto[0]
  first.refs?.row.scrollIntoView({ block: 'center', behavior: 'smooth' })
  first.refs?.num.focus()
  return false
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
    $('#doneOpen').textContent = 'Ver en Capibara'
    $('#doneNext').textContent = 'Subir otro capítulo'
  })

  renderBatch()
  setMode(localStorage.getItem('mode') || 'single')
}

initBatch()
