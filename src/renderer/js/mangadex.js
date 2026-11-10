'use strict'

/* =========================================================
   MangaDex: la parte de la ventana de cuenta (cliente personal
   de la API, idioma, grupo y reglas), agregar obras que ya
   existen y el aviso de los capítulos que revisa su staff.
   ========================================================= */

const mdx = { groupTimer: null, workTimer: null, groupSeq: 0, workSeq: 0 }

const mdxSession = () => state.sessions.mangadex || {}
const mdxSettings = () => mdxSession().settings || { groups: [], noGroup: false, lang: 'es-la', termsAcceptedAt: null }
const MDX_MAX_GROUPS = 10
const mdxInfo = () => state.platformInfo?.mangadex || { languages: [{ value: 'es-la', label: 'Español (Latinoamérica)' }], rulesUrl: 'https://mangadex.org/rules', termsUrl: 'https://mangadex.org/compliance' }

/* ---------- Ventana de cuenta ---------- */

function mdxFillAccount() {
  const s = mdxSettings()
  $('#accountUser').value = ''
  $('#accountPass').value = ''
  $('#mdxClientId').value = ''
  $('#mdxClientSecret').value = ''
  const sel = $('#mdxLang')
  sel.innerHTML = ''
  for (const l of mdxInfo().languages) sel.append(el('option', { value: l.value, text: l.label }))
  sel.value = s.lang
  $('#mdxTerms').checked = Boolean(s.termsAcceptedAt)
  $('#mdxGroupSearch').value = ''
  $('#mdxGroupResults').hidden = true
  renderMdxGroup()
  // Con la sesión ya iniciada, el botón guarda el grupo, el idioma y las reglas sin volver a entrar.
  if (mdxSession().loggedIn) $('#accountSave').textContent = 'Guardar'
}

function renderMdxGroup() {
  const { groups, noGroup } = mdxSettings()
  const box = $('#mdxGroupCurrent')
  box.innerHTML = ''
  if (!groups.length) box.append(el('span', { class: 'muted', text: noGroup ? 'Subes sin grupo (como autor o traductor autorizado).' : 'Ningún grupo elegido.' }))
  for (const g of groups) {
    box.append(el('span', { class: 'mdx-group-chip' }, el('b', { text: g.name }),
      el('button', { type: 'button', class: 'icon-btn small ghost', title: `Quitar ${g.name}`, html: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>', onclick: () => mdxSetGroups(groups.filter((x) => x.id !== g.id)) })))
  }
  // «Sin grupo» solo tiene sentido si no hay ningún grupo elegido.
  $('#mdxNoGroupRow').hidden = groups.length > 0
  $('#mdxNoGroup').checked = noGroup
  const loggedIn = mdxSession().loggedIn
  const full = groups.length >= MDX_MAX_GROUPS
  $('#mdxGroupSearch').disabled = !loggedIn || full
  $('#mdxGroupSearch').placeholder = !loggedIn ? 'Inicia sesión para elegir tus grupos' : full ? 'Ya elegiste 10 grupos, el máximo' : 'Busca un grupo por nombre o pega su enlace'
}

async function mdxSaveSettings(patch) {
  const res = await window.capi.mangadex.setSettings(patch)
  if (!res.ok) { $('#accountError').textContent = res.error.message; return false }
  state.sessions.mangadex = { ...mdxSession(), settings: res.data }
  return true
}

async function mdxSetGroups(groups) {
  if (!(await mdxSaveSettings({ groups }))) return
  $('#mdxGroupResults').hidden = true
  $('#mdxGroupSearch').value = ''
  renderMdxGroup()
  // Las obras de los grupos cambian: se recargan.
  if (state.platform === 'mangadex') onScanChanged()
}

function mdxPickGroup(group) {
  const groups = mdxSettings().groups
  if (groups.some((g) => g.id === group.id)) { $('#mdxGroupResults').hidden = true; return }
  return mdxSetGroups([...groups, group].slice(0, MDX_MAX_GROUPS))
}

function mdxSearchGroups() {
  clearTimeout(mdx.groupTimer)
  const q = $('#mdxGroupSearch').value.trim()
  const list = $('#mdxGroupResults')
  if (q.length < 2) { list.hidden = true; return }
  mdx.groupTimer = setTimeout(async () => {
    const seq = ++mdx.groupSeq
    list.hidden = false
    list.innerHTML = ''
    list.append(el('li', { class: 'empty', text: 'Buscando…' }))
    const res = await window.capi.mangadex.searchGroups(q)
    if (seq !== mdx.groupSeq) return
    list.innerHTML = ''
    if (!res.ok) { list.append(el('li', { class: 'empty', text: res.error.message })); return }
    if (!res.data.length) { list.append(el('li', { class: 'empty', text: 'No se encontró ningún grupo con ese nombre.' })); return }
    const chosen = new Set(mdxSettings().groups.map((g) => g.id))
    for (const g of res.data) {
      list.append(el('li', {}, el('button', { type: 'button', onclick: () => mdxPickGroup(g) },
        el('span', { text: g.name }), chosen.has(g.id) ? el('span', { class: 'mdx-added', text: 'Ya elegido' }) : null)))
    }
  }, 400)
}

async function mdxSaveAccount() {
  const username = $('#accountUser').value.trim()
  const password = $('#accountPass').value
  const clientId = $('#mdxClientId').value.trim()
  const clientSecret = $('#mdxClientSecret').value.trim()
  const terms = $('#mdxTerms').checked
  $('#accountError').textContent = ''
  const wantsLogin = Boolean(username || password || clientId || clientSecret)
  if (!wantsLogin && !mdxSession().loggedIn) { $('#accountError').textContent = 'Escribe tu usuario, contraseña, Client ID y Client Secret.'; return }
  if (wantsLogin && (!username || !password || !clientId || !clientSecret)) {
    $('#accountError').textContent = 'Para entrar hacen falta los cuatro datos: usuario, contraseña, Client ID y Client Secret.'
    return
  }
  const btn = $('#accountSave')
  btn.disabled = true
  const langBefore = mdxDefaultLang()
  if (!(await mdxSaveSettings({ lang: $('#mdxLang').value, termsAccepted: terms, noGroup: $('#mdxNoGroup').checked }))) { btn.disabled = false; return }
  if (mdxDefaultLang() !== langBefore) { mdxLangOptions($('#chLang'), mdxDefaultLang()); if (state.mode === 'batch') renderBatch() }
  if (wantsLogin) {
    btn.textContent = 'Entrando…'
    const res = await window.capi.platform.signIn('mangadex', { username, password, clientId, clientSecret })
    $('#accountPass').value = ''
    $('#mdxClientSecret').value = ''
    btn.disabled = false
    btn.textContent = 'Iniciar sesión'
    if (!res.ok) { $('#accountError').textContent = res.error.message; return }
    state.sessions.mangadex = res.data
    const hasGroups = res.data.settings?.groups?.length > 0
    toast('success', 'Sesión iniciada en MangaDex', `Como ${accountName('mangadex')}.${hasGroups ? '' : ' Elige tus grupos para ver sus obras.'}`)
    afterSessionsChanged('mangadex')
    // Sin grupo elegido, la ventana sigue abierta para elegirlo.
    if (!hasGroups && !res.data.settings?.noGroup) { mdxFillAccount(); $('#accountStatus').hidden = false; $('#accountStatus').textContent = `Sesión iniciada como ${accountName('mangadex')}. Ahora elige los grupos que trabajan tus capítulos.`; $('#accountOut').hidden = false; return }
  } else {
    btn.disabled = false
    toast('success', 'Ajustes de MangaDex guardados')
    if (state.platform === 'mangadex') onScanChanged()
  }
  if (!terms) toast('warn', 'Falta aceptar las reglas de MangaDex', 'Sin aceptarlas no se puede subir.', 8000)
  else if (!mdxSettings().groups.length && !mdxSettings().noGroup) toast('warn', 'Falta elegir tus grupos', 'Sin grupo no se puede subir, salvo que seas el autor o un traductor autorizado.', 8000)
  closeAccountModal()
}

/* ---------- Agregar una obra que ya existe ---------- */

let mdxOnAdded = null

function openMdxAddWork({ title = '', onAdded = null } = {}) {
  if (!mdxSession().loggedIn) return openAccountModal('mangadex')
  mdxOnAdded = onAdded
  $('#mdxWorkSearch').value = title
  $('#mdxWorkError').textContent = ''
  $('#mdxWorkResults').innerHTML = ''
  $('#mdxWorkModal').hidden = false
  setTimeout(() => $('#mdxWorkSearch').focus(), 50)
  if (title) mdxSearchWorks()
}

function closeMdxAddWork() {
  $('#mdxWorkModal').hidden = true
  mdxOnAdded = null
}

function mdxSearchWorks() {
  clearTimeout(mdx.workTimer)
  const q = $('#mdxWorkSearch').value.trim()
  const list = $('#mdxWorkResults')
  if (q.length < 2) { list.innerHTML = ''; return }
  mdx.workTimer = setTimeout(async () => {
    const seq = ++mdx.workSeq
    list.innerHTML = ''
    list.append(el('li', { class: 'empty', text: 'Buscando en MangaDex…' }))
    const res = await window.capi.mangadex.searchManga(q)
    if (seq !== mdx.workSeq) return
    list.innerHTML = ''
    if (!res.ok) { $('#mdxWorkError').textContent = res.error.message; return }
    $('#mdxWorkError').textContent = ''
    if (!res.data.length) { list.append(el('li', { class: 'empty', text: 'No hay obras con ese título en MangaDex.' })); return }
    for (const w of res.data) {
      const have = state.works.some((x) => x.id === w.id)
      list.append(el('li', {}, el('button', { type: 'button', onclick: () => mdxAddWork(w) },
        coverImg(w), el('div', { class: 'work-text' }, el('span', { class: 'work-title', text: w.title, title: w.title }), workMeta(w)),
        have ? el('span', { class: 'mdx-added', text: 'Ya está en tu lista' }) : null)))
    }
  }, 450)
}

async function mdxAddWork(w) {
  const res = await window.capi.mangadex.addWork(w.id)
  if (!res.ok) { $('#mdxWorkError').textContent = res.error.message; return }
  const onAdded = mdxOnAdded
  closeMdxAddWork()
  toast('success', `«${w.title}» agregada`, 'Ya puedes subirle capítulos.')
  await loadWorks()
  const fresh = state.works.find((x) => x.id === w.id)
  if (fresh) (onAdded || selectWork)(fresh)
}

/* ---------- Idioma de cada capítulo ----------
   El de la cuenta es el predeterminado; cada capítulo puede ir en otro (un grupo que traduce a
   varios idiomas). En MangaDex el 12 en español y el 12 en inglés son capítulos distintos, así que
   los números repetidos se revisan por idioma. */

const MDX_LANG_SHORT = { 'es-la': 'ES-LA', es: 'ES', en: 'EN', 'pt-br': 'PT-BR' }
const mdxDefaultLang = () => mdxSettings().lang || 'es-la'
const mdxLangLabel = (v) => mdxInfo().languages.find((l) => l.value === v)?.label || v
// Para usar dentro de una frase: «ya existe en inglés».
const MDX_LANG_NAME = { 'es-la': 'español latino', es: 'español de España', en: 'inglés', 'pt-br': 'portugués de Brasil' }
const mdxLangName = (v) => MDX_LANG_NAME[v] || mdxLangLabel(v)

/** El idioma con el que se sube ese capítulo de «Varios capítulos». */
const itemLang = (it) => it.lang || mdxDefaultLang()

/** El idioma elegido en «Un capítulo». */
const currentMdxLang = () => $('#chLang')?.value || mdxDefaultLang()

/** Capítulos de una obra de MangaDex en ese idioma (los de las demás plataformas no traen idioma). */
function chaptersInLang(list, lang) {
  if (state.platform !== 'mangadex' || !lang) return list || []
  return (list || []).filter((c) => !c.lang || c.lang === lang)
}

/** Opciones de idioma para un <select> (cortas en las filas de «Varios capítulos»). */
function mdxLangOptions(select, value, { short = false } = {}) {
  select.innerHTML = ''
  for (const l of mdxInfo().languages) select.append(el('option', { value: l.value, text: short ? (MDX_LANG_SHORT[l.value] || l.value.toUpperCase()) : l.label, title: l.label }))
  select.value = value
}

/**
 * Muestra el idioma (en el formulario y en cada fila) solo si la subida va a MangaDex, con sesión.
 * Se llama al validar, así sigue a la plataforma activa y a «También a…».
 */
function syncMdxTarget() {
  const on = goesToMangadex() && Boolean(mdxSession().loggedIn)
  const changed = document.body.classList.contains('to-mangadex') !== on
  document.body.classList.toggle('to-mangadex', on)
  const sel = $('#chLang')
  if (sel && (!sel.options.length || (changed && on))) mdxLangOptions(sel, sel.value || mdxDefaultLang())
  return changed
}

/* ---------- Reglas de MangaDex en el formulario ---------- */

/** «[HQ]», «v2», «(LQ)»… en el título: las reglas solo permiten «Censored» o «Uncensored». */
function mdxTitleDescriptor(title) {
  const t = String(title || '')
  const allowed = (s) => /^[\s[\](){}-]*(un)?censored[\s[\](){}-]*$/i.test(s)
  for (const m of t.matchAll(/\[[^\]]*\]|\{[^}]*\}|\((?:hq|lq|hd|raw|mtl|v\s*\d+|ver(?:sión|sion)?\s*\d+)\)/gi)) {
    if (!allowed(m[0])) return m[0]
  }
  const loose = /(?:^|\s)(v\d+|hq|lq|hd)(?=\s|$)/i.exec(t)
  return loose ? loose[1] : null
}

/** Lo que las reglas de MangaDex no dejan subir así (null si está bien). Solo con MangaDex como destino. */
function mdxChapterProblem({ title }) {
  if (!mdxSession().loggedIn) return null
  const s = mdxSettings()
  if (!s.groups.length && !s.noGroup) return 'Elige en tu cuenta de MangaDex los grupos que trabajaron el capítulo.'
  if (!s.termsAcceptedAt) return 'Acepta las reglas de MangaDex en tu cuenta.'
  const bad = mdxTitleDescriptor(title)
  if (bad) return `Quita «${bad}» del título: MangaDex no permite descriptores como «[HQ]» o «v2».`
  return null
}

/** ¿Va a MangaDex esta subida? (plataforma activa o «También a…»). */
const goesToMangadex = () => state.platform === 'mangadex' || (typeof alsoActive === 'function' && alsoActive().includes('mangadex'))

/*
 * Recordatorio de las reglas: antes de la primera subida a MangaDex de cada vez que se abre la app.
 * Devuelve true si se puede seguir.
 */
let mdxRulesReminded = false
async function mdxRemindRules() {
  if (mdxRulesReminded || !goesToMangadex()) return true
  const choice = await ask({
    kind: 'info',
    title: 'Antes de subir a MangaDex',
    wrap: true,
    text: 'Recuerda sus reglas de subida. Si no se cumplen, MangaDex puede borrar el capítulo o restringir tu cuenta.',
    list: [
      'Solo trabajo de tus grupos: nada oficial, de otros grupos ni de agregadores.',
      'Marca todos los grupos que trabajaron el capítulo. «Sin grupo» es solo para el autor o traductores autorizados.',
      'Un capítulo por subida: no juntes varios, y pártelo solo si la obra original también viene partida (usa decimales: 12.5).',
      'No unas páginas de libro en una tira larga. Las páginas dobles sí van juntas, en una sola imagen.',
      'Tomo solo si el capítulo ya salió en un tomo; no lo adivines. En obras por temporadas, la temporada va como tomo.',
      'Si el capítulo no tiene título, no le pongas uno, y no agregues «[HQ]», «v2» ni otros descriptores.',
    ],
    buttons: [
      { value: 'rules', label: 'Ver todas las reglas' },
      { value: 'no', label: 'Cancelar', cancel: true },
      { value: 'yes', label: 'Entendido, subir', kind: 'primary' },
    ],
  })
  if (choice === 'rules') { window.capi.settings.openRules(); return false }
  if (choice !== 'yes') return false
  mdxRulesReminded = true
  return true
}

/* ---------- Después de subir ---------- */

/** MangaDex revisa a mano el primer capítulo de cada idioma: se avisa para que no parezca un error. */
function noteMdxReview(data, label) {
  const d = data?.results?.mangadex?.data || data
  if (!d?.review) return
  toast('info', `${label}: MangaDex lo revisará`, 'Es el primer capítulo en este idioma: su staff lo revisa antes de mostrarlo (normalmente unas horas, a veces hasta 48 h).', 12000)
}

function initMangadex() {
  if (!$('#mdxWorkModal')) return
  $('#mdxGroupSearch').addEventListener('input', mdxSearchGroups)
  // Las reglas se leen en la app (traducidas); desde esa ventana también se puede abrir mangadex.org.
  $('#mdxRulesLink').addEventListener('click', (e) => { e.preventDefault(); window.capi.settings.openRules() })
  $('#mdxNoGroup').addEventListener('change', async (e) => { await mdxSaveSettings({ noGroup: e.target.checked }); renderMdxGroup() })
  // Idioma de «Un capítulo»: cambia el siguiente número sugerido y los repetidos.
  $('#chLang').addEventListener('change', () => { applyChapterSuggestions(); renderWorkInfo(); validate() })
  // Al cambiar de plataforma o el idioma de la cuenta, el capítulo vuelve al idioma predeterminado.
  on('platformChanged', () => { const s = $('#chLang'); if (s) mdxLangOptions(s, mdxDefaultLang()) })
  $('#mdxTermsLink').addEventListener('click', (e) => { e.preventDefault(); window.capi.system.openExternal(mdxInfo().termsUrl) })
  $('#mdxWorkSearch').addEventListener('input', mdxSearchWorks)
  $('#mdxWorkCancel').addEventListener('click', closeMdxAddWork)
  $('#mdxWorkModal').addEventListener('mousedown', (e) => { if (e.target.id === 'mdxWorkModal') closeMdxAddWork() })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#mdxWorkModal').hidden) closeMdxAddWork() })
}
