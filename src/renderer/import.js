'use strict'

/* =========================================================
   «Importar de web»: lee una obra de otra web (motor de HaruNeko),
   baja los capítulos elegidos y los pasa a «Varios capítulos».
   Usa el estado y las utilidades de app.js y batch.js.
   ========================================================= */
const im = {
  url: '',
  site: null, // { id, title, icon, languages, template? }
  manga: null, // { key, title, website, chapters }
  workId: null,
  workGuess: false,
  rows: [], // { index, title, languages, number, volume, label, selected, status, done, total, error }
  lang: '',
  group: '',
  searching: false,
  running: false,
  anchor: null,
}

const IM_LANG = {
  spanish: 'Español', english: 'Inglés', portuguese: 'Portugués', french: 'Francés', italian: 'Italiano', german: 'Alemán',
  russian: 'Ruso', japanese: 'Japonés', korean: 'Coreano', chinese: 'Chino', indonesian: 'Indonesio', vietnamese: 'Vietnamita',
  thai: 'Tailandés', turkish: 'Turco', arabic: 'Árabe', polish: 'Polaco', multilingual: 'Varios idiomas',
}
const langLabel = (l) => IM_LANG[l] || (l ? l[0].toUpperCase() + l.slice(1) : '')

const imWork = () => workById(im.workId)
const imExisting = () => new Set(workChapters(im.workId).map((c) => Number(c.number)))
// im.lang: un idioma, NO_LANG (capítulos sin idioma indicado) o '' (todos).
// im.group: un scan, NO_GROUP (sin scan indicado) o '' (todos).
const NO_LANG = '__none'
const NO_GROUP = '__nogroup'
const imInLang = (r) => !im.lang || (im.lang === NO_LANG ? !r.languages.length : r.languages.includes(im.lang))
const imInGroup = (r) => !im.group || (im.group === NO_GROUP ? !r.group : r.group === im.group)
const imVisible = () => im.rows.filter((r) => imInLang(r) && imInGroup(r))

/** Scan del capítulo: webs como MangaDex lo ponen al final del título, «… (es-la) [Nombre del scan]». */
const imGroupOf = (title) => (String(title).match(/\[([^\]]{2,80})\]\s*$/)?.[1] || '').trim()
const imChosen = () => imVisible().filter((r) => r.selected)

/* ---------- Búsqueda ---------- */

function setImHint(text, kind = '') {
  setHint('#imUrlHint', text, kind)
}

async function imSearch() {
  if (im.searching || im.running) return
  const url = $('#imUrl').value.trim()
  if (!url) { $('#imUrl').focus(); return setImHint('Pega el enlace de la obra.', 'error') }
  im.searching = true
  $('#imSearch').disabled = true
  $('#imSearch').textContent = 'Buscando…'
  setImHint('Reconociendo el sitio…')
  if (im.manga) window.capi.import.release(im.manga.key)
  im.manga = null
  im.rows = []
  im.site = null
  renderImSite()
  renderImList()
  try {
    const idf = await window.capi.import.identify(url)
    if (!idf.ok) return setImHint(idf.error.message, 'error')
    const { matches, sameHost, generic } = idf.data
    const site = matches[0] || generic
    if (!site) {
      if (sameHost.length) {
        return setImHint(`Ese enlace es de ${sameHost[0].title}, pero no es la página de una obra. Abre la obra (la página con la lista de capítulos) y copia ese enlace.`, 'error')
      }
      return setImHint('Este sitio todavía no es compatible. Si usa otra plataforma de lectura, no se puede importar desde aquí.', 'error')
    }
    im.site = site
    im.url = idf.data.url
    renderImSite()
    setImHint(`Leyendo la obra en ${site.title}… (puede tardar si el sitio tiene protección)`)
    const res = await window.capi.import.open(im.url, site.id)
    if (!res.ok) return setImHint(`No se pudo leer la obra: ${res.error.message}`, 'error')
    im.manga = res.data
    setImHint(`${plural(res.data.chapters.length, 'capítulo encontrado', 'capítulos encontrados')} en ${site.title}.`, 'ok')
    await imPrepare()
  } finally {
    im.searching = false
    $('#imSearch').disabled = false
    $('#imSearch').textContent = 'Buscar'
    renderImList()
  }
}

/** «Capítulo 99 - Capítulo 99» → sin título; «Cap 12 - El regreso» → «El regreso». */
function imTitle(p, number) {
  const t = (p.title || '').trim()
  if (!t) return ''
  const again = parseChapterName(t)
  return again.number === number && !again.title ? '' : t
}

/** Arma las filas: número, idioma, si ya está en Capibara y la selección inicial. */
async function imPrepare() {
  const m = im.manga
  // Obra de destino: la que se parezca al título de la web.
  const match = matchWork(m.title) || matchWork(m.title.replace(/\s+[-–|:]\s+[^-–|:]+$/, ''))
  im.workId = match?.work.id ?? null
  im.workGuess = Boolean(match && !match.sure)
  if (im.workId != null) await ensureChapters(im.workId)

  im.rows = m.chapters.map((c) => {
    const p = parseChapterName(c.title)
    return {
      index: c.index, title: c.title, languages: c.languages || [], group: imGroupOf(c.title),
      number: p.number, volume: p.volume, label: imTitle(p, p.number),
      selected: false, status: '', done: 0, total: 0, error: '',
    }
  })
  im.rows.sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity) || naturalCompare(a.title, b.title))

  // Idioma: si la web mezcla traducciones, se muestra uno (español si lo hay).
  const counts = new Map()
  let untagged = 0
  for (const r of im.rows) {
    if (!r.languages.length) untagged++
    for (const l of r.languages) counts.set(l, (counts.get(l) || 0) + 1)
  }
  const langs = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a))
  const mixed = langs.length > 1 || (langs.length === 1 && untagged > 0)
  im.lang = mixed ? (counts.has('spanish') ? 'spanish' : langs[0]) : ''
  const sel = $('#imLang')
  sel.hidden = !mixed
  sel.innerHTML = ''
  for (const l of langs) sel.append(el('option', { value: l, selected: l === im.lang, text: `${langLabel(l)} (${counts.get(l)})` }))
  if (mixed && untagged) sel.append(el('option', { value: NO_LANG, text: `Sin idioma indicado (${untagged})` }))
  if (mixed) sel.append(el('option', { value: '', text: `Todos los idiomas (${im.rows.length})` }))

  im.group = ''
  imRenderGroups(true)

  imSelectMissing()
  renderImTarget()
}

/**
 * Selector de scan: aparece si la web tiene versiones de varios scans. La primera vez se elige
 * solo el que se parezca al scan activo (la versión propia del scan que importa).
 */
function imRenderGroups(pickOwn = false) {
  const counts = new Map()
  let untagged = 0
  for (const r of im.rows) {
    if (!imInLang(r)) continue
    if (r.group) counts.set(r.group, (counts.get(r.group) || 0) + 1)
    else untagged++
  }
  const groups = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || naturalCompare(a, b))
  const sel = $('#imGroup')
  const show = groups.length > 1 || (groups.length === 1 && untagged > 0)
  sel.hidden = !show
  if (!show) { im.group = ''; sel.innerHTML = ''; return }
  if (pickOwn) {
    const own = normTitle(activeProfile()?.name || '')
    let best = null
    let score = 0
    for (const g of groups) {
      const n = normTitle(g)
      const sc = own && n ? Math.max(similarity(own, n), n.includes(own) || own.includes(n) ? 0.9 : 0) : 0
      if (sc > score) { score = sc; best = g }
    }
    if (best && score >= 0.6) im.group = best
  }
  if (im.group && im.group !== NO_GROUP && !counts.has(im.group)) im.group = ''
  sel.innerHTML = ''
  sel.append(el('option', { value: '', selected: !im.group, text: `Todos los scans (${groups.length})` }))
  for (const g of groups) sel.append(el('option', { value: g, selected: g === im.group, text: `${g} (${counts.get(g)})` }))
  if (untagged) sel.append(el('option', { value: NO_GROUP, selected: im.group === NO_GROUP, text: `Sin scan indicado (${untagged})` }))
}

/** Marca los que aún no están en Capibara, uno por número (la primera versión que aparezca). */
function imSelectMissing() {
  const existing = imExisting()
  const seen = new Set()
  for (const r of im.rows) r.selected = false
  for (const r of imVisible()) {
    if (r.number == null || existing.has(r.number) || seen.has(r.number)) continue
    seen.add(r.number)
    r.selected = true
  }
  renderImList()
}

/* ---------- Obra de destino ---------- */

function renderImTarget() {
  const box = $('#imTarget')
  box.innerHTML = ''
  if (!im.manga) {
    box.append(el('p', { class: 'muted', text: 'Busca la obra para elegir a cuál de tus obras van los capítulos.' }))
    return
  }
  const work = imWork()
  const pick = el('button', {
    type: 'button', class: `btn ${work ? 'secondary' : 'primary'} small`, disabled: im.running,
    onclick: (e) => openWorkPicker(e.currentTarget, [{ workId: im.workId }], imSetWork),
  }, work ? 'Cambiar' : 'Elegir obra')
  if (work) {
    const last = workLatest(work.id)
    box.append(el('div', { class: 'im-work' },
      coverImg(work, 'cover lg'),
      el('div', { class: 'work-text' },
        el('span', { class: 'work-title', text: work.title, title: work.title }),
        el('span', { class: 'work-meta', text: last ? `Último en Capibara: #${last.number}` : 'Aún sin capítulos en Capibara' }),
        im.workGuess ? el('span', { class: 'badge warning', text: 'Detectada por el título: revísala' }) : null),
      pick))
    return
  }
  box.append(el('div', { class: 'im-warn' },
    el('span', { html: ICONS.warn }),
    el('div', {},
      el('strong', { text: `«${im.manga.title}» no está entre las obras de tu scan.` }),
      el('p', { text: 'Por favor, crea primero la ficha de la obra en Capibara y vuelve a buscar. Si ya existe con otro nombre, elígela.' }),
      el('div', { class: 'im-warn-actions' },
        pick,
        el('button', {
          type: 'button', class: 'btn ghost small', disabled: im.running,
          onclick: async () => { await loadWorks(); if (im.manga) await imPrepare() },
        }, 'Ya la creé: recargar obras'),
        activeProfile()?.url ? el('button', { type: 'button', class: 'btn ghost small', onclick: () => window.capi.system.openExternal(activeProfile().url) }, 'Abrir mi scan') : null))))
}

async function imSetWork(work) {
  im.workId = work.id
  im.workGuess = false
  await ensureChapters(work.id)
  imSelectMissing()
  renderImTarget()
}

/* ---------- Lista ---------- */

function renderImSite() {
  const box = $('#imSite')
  box.hidden = !im.site
  box.innerHTML = ''
  if (!im.site) return
  const s = im.site
  box.append(
    s.icon ? el('img', { src: s.icon, alt: '', class: 'im-site-icon' }) : el('span', { class: 'im-site-icon' }),
    el('div', { class: 'work-text' },
      el('span', { class: 'work-title', text: s.title }),
      el('span', { class: 'work-meta', text: [s.template ? `Detectado: tema ${s.template}` : 'Sitio compatible', ...(s.languages || []).map(langLabel)].join(' · ') })))
}

function imStatusPill(r) {
  const map = {
    queued: ['', 'En cola'],
    downloading: ['uploading', r.total ? `Bajando ${r.done}/${r.total}` : 'Leyendo…'],
    done: ['done', 'Listo ✓'],
    error: ['error', 'Error'],
  }
  if (map[r.status]) {
    const [cls, text] = map[r.status]
    return el('span', { class: `ch-status ${cls}`, text, title: r.error || '' })
  }
  if (r.number != null && imExisting().has(r.number)) return el('span', { class: 'ch-status skipped', text: 'Ya en Capibara' })
  return el('span')
}

function imRow(r, dupes) {
  const num = el('input', {
    type: 'number', step: 'any', min: '0', value: r.number ?? '', placeholder: '?', disabled: im.running, title: 'Número en Capibara',
    onclick: (e) => e.stopPropagation(),
    oninput: (e) => { r.number = e.target.value === '' ? null : Number(e.target.value); renderImSummary(); markImRow(r) },
  })
  const pct = r.status === 'downloading' && r.total ? r.done / r.total : r.status === 'done' ? 1 : 0
  const warn = r.selected && (r.number == null ? 'Falta el número' : dupes.has(r.number) ? 'Número repetido' : imExisting().has(r.number) ? 'Ya existe en Capibara' : '')
  return el('li', {
    class: `dl-row im-row${r.selected ? ' on' : ''}${warn ? ' invalid' : ''}`, dataset: { index: r.index, status: r.status },
    title: r.error || warn || '',
    onclick: (e) => imToggle(r, e.shiftKey),
  },
  el('input', { type: 'checkbox', checked: r.selected, disabled: im.running, tabindex: '-1' }),
  el('label', { class: 'im-num', onclick: (e) => e.stopPropagation() }, el('span', { text: 'Cap' }), num),
  el('span', { class: 'dl-title', text: r.title }),
  el('span', { class: 'dl-meta', text: [r.volume != null ? `Vol ${r.volume}` : null, im.lang ? null : r.languages.map(langLabel).join(', '), im.group ? null : r.group].filter(Boolean).join(' · ') }),
  imStatusPill(r),
  el('div', { class: 'ch-progress' }, el('div', { style: `width:${Math.round(pct * 100)}%` })))
}

function imDupes() {
  const counts = new Map()
  for (const r of imChosen()) if (r.number != null) counts.set(r.number, (counts.get(r.number) || 0) + 1)
  return new Set([...counts].filter(([, n]) => n > 1).map(([k]) => k))
}

/** Al escribir el número: actualiza aviso y estado sin rehacer la fila (no se pierde el foco). */
function markImRow(r) {
  const li = $(`#imList .im-row[data-index="${r.index}"]`)
  if (!li) return
  const fresh = imRow(r, imDupes())
  li.className = fresh.className
  li.title = fresh.title
  li.children[4].replaceWith(fresh.children[4])
}

function updateImRow(r) {
  const li = $(`#imList .im-row[data-index="${r.index}"]`)
  if (li) li.replaceWith(imRow(r, imDupes()))
}

function imToggle(r, range) {
  if (im.running) return
  const list = imVisible()
  if (range && im.anchor != null) {
    const a = list.findIndex((x) => x.index === im.anchor)
    const b = list.findIndex((x) => x.index === r.index)
    const on = !r.selected
    for (const x of list.slice(Math.min(a, b), Math.max(a, b) + 1)) x.selected = on
  } else {
    r.selected = !r.selected
  }
  im.anchor = r.index
  renderImList()
}

function renderImList() {
  const rows = imVisible()
  const list = $('#imList')
  const empty = !im.manga || !rows.length
  $('#imEmpty').hidden = !empty
  list.hidden = empty
  $('#imToolbar').hidden = !im.manga || !im.rows.length
  $('#imCount').textContent = String(im.manga ? rows.length : 0)
  if (im.searching) {
    $('#imEmptyTitle').textContent = 'Buscando la obra…'
    $('#imEmptySub').textContent = im.site ? `Leyendo ${im.site.title}` : 'Reconociendo el sitio'
  } else if (!im.manga) {
    $('#imEmptyTitle').textContent = 'Pega el enlace de una obra'
    $('#imEmptySub').textContent = 'Sus capítulos aparecerán aquí para elegir cuáles traer.'
  } else if (!rows.length) {
    $('#imEmptyTitle').textContent = 'No hay capítulos'
    $('#imEmptySub').textContent = im.rows.length ? 'Ninguno en este idioma.' : 'La web no muestra capítulos para esta obra.'
  }
  $('#imListSummary').textContent = im.manga
    ? `«${im.manga.title}» en ${im.manga.website.title} — clic para marcar, Mayús + clic para un tramo. Puedes corregir el número de cada uno.`
    : 'Busca una obra para ver sus capítulos.'
  list.innerHTML = ''
  if (!empty) {
    const dupes = imDupes()
    rows.forEach((r) => list.append(imRow(r, dupes)))
  }
  renderImSummary()
}

function imProblems() {
  const chosen = imChosen()
  const existing = imExisting()
  const dupes = imDupes()
  if (!im.manga) return 'Busca la obra primero.'
  if (!imWork()) return 'Elige la obra de Capibara a la que van los capítulos.'
  if (!chosen.length) return 'Marca al menos un capítulo.'
  if (chosen.some((r) => r.number == null)) return 'Hay capítulos marcados sin número: escríbelo en su fila.'
  if (dupes.size) return `El número ${[...dupes][0]} está repetido entre los marcados.`
  const clash = chosen.find((r) => existing.has(r.number))
  if (clash) return `El capítulo ${clash.number} ya existe en «${imWork().title}».`
  if (!$('#imConfirm').checked) return 'Confirma que el contenido es de tu scan.'
  return ''
}

function renderImSummary() {
  const chosen = imChosen()
  const problem = imProblems()
  if (!im.running) {
    const work = imWork()
    $('#imSummaryMain').textContent = im.manga
      ? `${plural(chosen.length, 'capítulo', 'capítulos')} de «${im.manga.title}»${work ? ` → ${work.title}` : ''}`
      : 'Pega el enlace de una obra'
    $('#imSummarySub').className = `summary-sub${problem && im.manga ? ' error' : ''}`
    $('#imSummarySub').textContent = im.manga ? problem || 'Se bajan y pasan a «Varios capítulos» para revisarlos antes de subir.' : ''
  }
  $('#imStartText').textContent = im.running ? 'Importando…' : chosen.length > 1 ? `Importar ${chosen.length} capítulos` : 'Importar'
  $('#imStartBtn').disabled = im.running || Boolean(problem)
}

/* ---------- Importación ---------- */

function setImProgress(pct, text) {
  $('#imProgressBar').style.width = `${Math.max(0, Math.min(100, pct))}%`
  $('#imProgressPct').textContent = `${Math.round(pct)}%`
  if (text) $('#imProgressText').textContent = text
}

function setImRunningUI(on) {
  im.running = on
  $('#imProgressWrap').hidden = !on
  $('#imCancelBtn').hidden = !on
  $('#imSearch').disabled = on
  $('#imUrl').disabled = on
  setViewBusy('import', on)
  renderImTarget()
  renderImList()
}

async function imStart() {
  if (im.running || imProblems()) return
  if (state.uploading) return toast('warn', 'Hay una subida en curso', 'Espera a que termine para importar más capítulos.')
  const work = imWork()
  const chosen = imChosen()
  for (const r of im.rows) { r.status = ''; r.error = ''; r.done = 0; r.total = 0 }
  for (const r of chosen) r.status = 'queued'
  setImRunningUI(true)
  setImProgress(0, 'Preparando…')
  $('#imSummaryMain').textContent = `Importando ${plural(chosen.length, 'capítulo', 'capítulos')} de ${im.manga.website.title}`

  const byIndex = new Map(chosen.map((r) => [r.index, r]))
  const unsubscribe = window.capi.import.onProgress((p) => {
    const r = byIndex.get(p.index)
    if (!r) return
    if (p.status === 'start' || p.status === 'page') Object.assign(r, { status: 'downloading', done: p.done, total: p.total })
    else if (p.status === 'done') Object.assign(r, { status: 'done', done: p.total, total: p.total })
    else if (p.status === 'error') Object.assign(r, { status: 'error', error: p.error })
    updateImRow(r)
    const frac = r.status === 'downloading' && r.total ? r.done / r.total : r.status === 'queued' ? 0 : 1
    setImProgress(((p.position + frac) / p.count) * 100,
      `${p.position + 1}/${p.count} · Cap ${r.number}${r.total ? ` · páginas ${r.done}/${r.total}` : ' · leyendo páginas…'}`)
  })

  const res = await window.capi.import.download({
    key: im.manga.key,
    workTitle: work.title,
    chapters: chosen.map((r) => ({ index: r.index, number: r.number, volumeNumber: r.volume, title: r.label })),
  })
  unsubscribe()
  for (const r of im.rows) if (r.status === 'queued' || r.status === 'downloading') r.status = ''
  setImRunningUI(false)

  if (!res.ok) {
    if (res.error.code === 'cancelled') toast('info', 'Importación cancelada')
    else toast('error', 'No se pudo importar', res.error.message, 9000)
    return
  }
  const { dirs, failed } = res.data
  if (failed.length) {
    toast('warn', `${plural(failed.length, 'capítulo no se pudo bajar', 'capítulos no se pudieron bajar')}`,
      `${failed.slice(0, 2).map((f) => `Cap ${f.number}: ${f.error}`).join(' · ')}${failed.length > 2 ? '…' : ''}`, 12000)
  }
  if (!dirs.length) return
  await imHandOff(work, dirs.map((d) => d.dir))
}

/** Pasa las carpetas bajadas a «Varios capítulos», con la obra fija y la publicación escalonada. */
async function imHandOff(work, dirs) {
  const res = await window.capi.files.resolveChapters(dirs)
  if (!res.ok) return toast('error', 'No se pudieron preparar los capítulos', res.error.message)
  setView('upload')
  setMode('batch')
  const interval = Math.max(0, Math.floor(Number($('#imInterval').value) || 0))
  if (interval > 0) {
    $('#scheduleToggle').checked = true
    // El primero sale en 15 minutos; los demás, uno cada intervalo.
    const first = new Date(Date.now() + 15 * 60e3)
    first.setSeconds(0, 0)
    first.setMinutes(Math.ceil(first.getMinutes() / 5) * 5)
    $('#publishAt').value = toLocalInput(first)
    $('#batchInterval').value = String(interval)
    $('#batchIntervalUnit').value = $('#imIntervalUnit').value
    $('#scheduleBox').hidden = false
  }
  await addChapters(res.data, { workId: work.id })
  validate()
  toast('success', `${plural(res.data.chapters.length, 'capítulo listo', 'capítulos listos')} para subir`,
    interval > 0
      ? `Programados uno ${every(interval, $('#imIntervalUnit').value)} desde ${formatDate(new Date($('#publishAt').value))}. Revisa la lista y pulsa «Subir capítulos».`
      : 'Revisa la lista y pulsa «Subir capítulos».', 10000)
}

/* ---------- Ganchos con app.js ---------- */

function imOnShow() {
  renderImTarget()
  renderImList()
  if (!im.manga) $('#imUrl').focus()
}

function imOnScanChanged() {
  im.workId = null
  if (im.manga) imPrepare()
  else renderImTarget()
}

function imOnWorksLoaded() {
  if (im.manga && im.workId == null) imPrepare()
  else renderImTarget()
}

/* ---------- Inicio ---------- */

/** Avisos de la verificación de Cloudflare, que se hace en el navegador del usuario. */
function imOnVerify(p) {
  if (p.status === 'open') {
    setImHint(`Se abrió ${p.browser} para verificar ${p.site}. Marca la casilla de Cloudflare ahí; la ventana se cerrará sola.`, 'warn')
    toast('info', `Verificación en ${p.browser}`, `${p.site} pide comprobar que eres humano. Marca la casilla en la ventana de ${p.browser}; se cerrará sola al terminar.`, 12000)
  } else if (p.status === 'done') {
    setImHint(`Verificación lista. Leyendo la obra en ${im.site?.title || p.site}…`)
  } else if (p.status === 'rejected') {
    setImHint(`${p.site} no aceptó la verificación desde la app aunque la pasaste en el navegador. Este sitio no se puede importar por ahora.`, 'error')
  } else if (p.status === 'error') {
    setImHint(`No se pudo verificar ${p.site}: ${p.error}`, 'error')
  }
}

function initImport() {
  window.capi.import.onVerify(imOnVerify)
  $('#imSearch').addEventListener('click', imSearch)
  $('#imUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') imSearch() })
  $('#imUrl').addEventListener('input', () => setImHint(''))
  $('#imLang').addEventListener('change', (e) => { im.lang = e.target.value; imRenderGroups(); imSelectMissing() })
  $('#imGroup').addEventListener('change', (e) => { im.group = e.target.value; imSelectMissing() })
  $('#imMissing').addEventListener('click', () => { if (!im.running) imSelectMissing() })
  $('#imAll').addEventListener('click', () => { if (!im.running) { imVisible().forEach((r) => { r.selected = true }); renderImList() } })
  $('#imNone').addEventListener('click', () => { if (!im.running) { im.rows.forEach((r) => { r.selected = false }); renderImList() } })
  $('#imRange').addEventListener('click', () => {
    if (im.running) return
    const from = $('#imFrom').value.trim() === '' ? -Infinity : Number($('#imFrom').value)
    const to = $('#imTo').value.trim() === '' ? Infinity : Number($('#imTo').value)
    if (from > to) return toast('warn', 'El tramo está al revés', '«Del» debe ser menor o igual que «al».')
    const seen = new Set()
    for (const r of im.rows) r.selected = false
    for (const r of imVisible()) {
      if (r.number == null || r.number < from || r.number > to || seen.has(r.number)) continue
      seen.add(r.number)
      r.selected = true
    }
    renderImList()
  })
  $('#imConfirm').addEventListener('change', renderImSummary)
  $('#imStartBtn').addEventListener('click', imStart)
  $('#imCancelBtn').addEventListener('click', () => {
    $('#imProgressText').textContent = 'Cancelando…'
    window.capi.import.cancel()
  })
}

initImport()
