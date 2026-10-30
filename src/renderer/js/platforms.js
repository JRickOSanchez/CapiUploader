'use strict'

/* =========================================================
   Plataformas: Capibara (API key por scan), Crimson Scan y
   Mangation (cuenta con usuario y contraseña). La activa decide
   las obras, lo que muestra el formulario (lo que no tiene se
   oculta con data-cap) y el tema (data-platform en <body>).
   ========================================================= */

const PLATFORMS = {
  capibara: {
    label: 'Capibara',
    full: 'Capibara Traductor',
    mark: 'C',
    heroSub: 'Publica en Capibara Traductor directo desde tu escritorio.',
    kana: '',
    caps: ['volume', 'extras', 'singles', 'announce', 'schedule', 'notify', 'publish', 'download', 'languages'],
    notify: ['Avisar a seguidores', 'Notificaciones, correos, webhooks y Discord. Apágalo para subir capítulos viejos en silencio.'],
  },
  crimson: {
    label: 'Crimson Scan',
    full: 'Crimson Scan',
    mark: 'CS',
    heroSub: 'Publica en Crimson Scan directo desde tu escritorio. Las páginas se convierten a WebP solas.',
    kana: '',
    caps: ['schedule', 'notify', 'publish'],
    notify: ['Avisar en Discord', 'Crimson anuncia el capítulo en su Discord. Apágalo para subir capítulos viejos en silencio.'],
    userLabel: 'Usuario',
    account: 'Entra con tu cuenta del panel de Crimson Scan (admin.scancrimson.com).',
  },
  mangation: {
    label: 'Mangation',
    full: 'Mangation',
    mark: 'MG',
    heroSub: 'Publica en Mangation directo desde tu escritorio.',
    kana: 'アップロード',
    caps: [],
    userLabel: 'Correo',
    account: 'Entra con tu cuenta de creador de Mangation (creator.mangation.com).',
  },
}
const PLATFORM_IDS = Object.keys(PLATFORMS)

const plat = (id = state.platform) => PLATFORMS[id] || PLATFORMS.capibara
const hasCap = (cap, id) => plat(id).caps.includes(cap)
const isCapibara = (id = state.platform) => id === 'capibara'

/** Clave de la «cuenta» activa: el scan en Capibara, la plataforma en las demás (listas guardadas, última obra…). */
const accountKey = () => (isCapibara() ? state.activeScanId : state.platform)

/** Obras y capítulos de una plataforma (la activa si no se dice otra). */
const platformApi = {
  works: (p = state.platform) => (isCapibara(p) ? window.capi.api.works() : window.capi.platform.works(p)),
  chapters: (workId, p = state.platform) => (isCapibara(p) ? window.capi.api.chapters(workId) : window.capi.platform.chapters(p, workId)),
}

/** ¿Hay con qué subir a esa plataforma? (API key del scan o sesión iniciada). */
function isConnected(p = state.platform) {
  if (isCapibara(p)) return state.profiles.some((x) => x.id === state.activeScanId)
  return Boolean(state.sessions[p]?.loggedIn)
}

/** Nombre que se muestra de la cuenta de Crimson o Mangation. */
function accountName(p) {
  const u = state.sessions[p]?.user
  if (!u) return null
  return p === 'crimson' ? (u.scanName || u.displayName || u.username) : (u.name || u.email)
}

function refreshConnected() {
  state.hasKey = isConnected()
}

/* ---------- Aplicar la plataforma activa ---------- */

function renderPlatform() {
  const p = plat()
  document.body.dataset.platform = state.platform
  document.body.dataset.caps = p.caps.join(' ')
  $('#brandSub').textContent = p.full
  $('#heroSub').textContent = p.heroSub
  $('#heroKana').textContent = p.kana
  $('#platformName').textContent = p.label
  $('#platformMark').textContent = p.mark
  $$('[data-platform-label]').forEach((n) => { n.textContent = p.label })
  if (p.notify) {
    $('#notifyTitle').textContent = p.notify[0]
    $('#notifyDesc').textContent = p.notify[1]
  }
  // Lo que la plataforma no tiene no debe colarse en la subida aunque esté oculto.
  if (!hasCap('extras') && $('#extraToggle').checked) { $('#extraToggle').checked = false; $('#extraToggle').dispatchEvent(new Event('change')) }
  if (!hasCap('volume')) { $('#chVolume').value = ''; $('#batchVolume').value = '' }
  if (!hasCap('schedule') && $('#scheduleToggle').checked) { $('#scheduleToggle').checked = false; $('#scheduleToggle').dispatchEvent(new Event('change')) }
  if (!hasCap('download') && state.view === 'download' && !isImportWindow) setView('upload')
  renderPlatformMenu()
}

function renderPlatformMenu() {
  const list = $('#platformList')
  list.innerHTML = ''
  for (const id of PLATFORM_IDS) {
    const p = PLATFORMS[id]
    const active = id === state.platform
    const ok = isConnected(id)
    const sub = isCapibara(id)
      ? (state.profiles.length ? (state.profiles.find((x) => x.id === state.activeScanId)?.name || 'Elige un scan') : 'Agrega la API key de tu scan')
      : ok ? `Conectado: ${accountName(id)}` : 'Sin iniciar sesión'
    list.append(el('li', {},
      el('button', {
        type: 'button', role: 'menuitemradio', 'aria-checked': String(active),
        class: `scan-item platform-item${active ? ' active' : ''}`, dataset: { platform: id },
        onclick: () => switchPlatform(id),
      },
      el('span', { class: 'platform-mark', text: p.mark }),
      el('span', { class: 'scan-item-text' },
        el('span', { class: 'scan-item-name', text: p.full }),
        el('span', { class: `scan-item-sub ${ok ? 'ok' : 'warn'}`, text: sub })),
      active ? el('span', { class: 'scan-item-check', html: ICON_CHECK_SM }) : null)))
  }
}

function openPlatformMenu() {
  renderPlatformMenu()
  $('#platformMenu').hidden = false
  $('#platformBtn').setAttribute('aria-expanded', 'true')
}

function closePlatformMenu() {
  $('#platformMenu').hidden = true
  $('#platformBtn').setAttribute('aria-expanded', 'false')
}

async function switchPlatform(id) {
  closePlatformMenu()
  if (id === state.platform) return
  if (state.uploading) return toast('warn', 'Hay una subida en curso', 'Espera a que termine para cambiar de plataforma.')
  const res = await window.capi.platform.setActive(id)
  if (!res.ok) return toast('error', 'No se pudo cambiar de plataforma', res.error.message)
  state.sessions = res.data.sessions || state.sessions
  // El aviso a todas las ventanas puede haber llegado antes y ya la aplicó.
  if (state.platform !== id) applyActivePlatform(id, { animate: true })
  if (!state.hasKey) openKeyModal(true)
  else toast('info', `Ahora subes a ${plat().full}`, 'Se cargaron sus obras.')
}

/** Cambia a la plataforma `id` (en esta ventana) y recarga sus obras. */
function applyActivePlatform(id, { animate = false } = {}) {
  if (animate) {
    document.body.classList.add('theme-anim')
    setTimeout(() => document.body.classList.remove('theme-anim'), 350)
  }
  state.platform = PLATFORMS[id] ? id : 'capibara'
  refreshConnected()
  renderPlatform()
  emit('platformChanged', state.platform)
  onScanChanged()
}

/* ---------- Cuenta de Crimson / Mangation ---------- */

let accountFor = null

function openAccountModal(p = state.platform) {
  if (isCapibara(p)) return openKeyModal()
  accountFor = p
  const meta = plat(p)
  const s = state.sessions[p]
  $('#accountModal').dataset.platform = p
  $('#accountMark').textContent = meta.mark
  $('#accountTitle').textContent = `Tu cuenta de ${meta.full}`
  $('#accountSub').textContent = meta.account
  $('#accountUserLabel').textContent = meta.userLabel
  $('#accountUser').type = p === 'mangation' ? 'email' : 'text'
  $('#accountUser').value = ''
  $('#accountPass').value = ''
  $('#accountPass').type = 'password'
  $('#accountError').textContent = ''
  const status = $('#accountStatus')
  status.hidden = !s?.loggedIn
  status.textContent = s?.loggedIn
    ? `Sesión iniciada como ${accountName(p)}${s.expiresAt ? ` · vence ${formatDate(new Date(s.expiresAt))}` : ''}. Para entrar con otra cuenta, escribe sus datos.`
    : ''
  $('#accountOut').hidden = !s?.loggedIn
  $('#accountSave').textContent = s?.loggedIn ? 'Cambiar de cuenta' : 'Iniciar sesión'
  $('#accountModal').hidden = false
  setTimeout(() => $('#accountUser').focus(), 50)
}

function closeAccountModal() {
  $('#accountModal').hidden = true
  accountFor = null
}

async function saveAccount() {
  const p = accountFor
  if (!p) return
  const username = $('#accountUser').value.trim()
  const password = $('#accountPass').value
  if (!username || !password) { $('#accountError').textContent = `Escribe tu ${plat(p).userLabel.toLowerCase()} y tu contraseña.`; return }
  const btn = $('#accountSave')
  btn.disabled = true
  btn.textContent = 'Entrando…'
  const res = await window.capi.platform.signIn(p, { username, password })
  btn.disabled = false
  btn.textContent = 'Iniciar sesión'
  $('#accountPass').value = ''
  if (!res.ok) { $('#accountError').textContent = res.error.message; return }
  state.sessions[p] = res.data
  closeAccountModal()
  toast('success', `Sesión iniciada en ${plat(p).full}`, accountName(p) ? `Como ${accountName(p)}.` : null)
  afterSessionsChanged(p)
}

async function signOutAccount() {
  const p = accountFor
  if (!p) return
  const res = await window.capi.platform.signOut(p)
  if (!res.ok) return toast('error', 'No se pudo cerrar la sesión', res.error.message)
  state.sessions[p] = { loggedIn: false, user: null }
  closeAccountModal()
  toast('info', `Cerraste la sesión de ${plat(p).full}`)
  afterSessionsChanged(p)
}

/** Última sesión aplicada de cada plataforma: el aviso entre ventanas y la respuesta llegan los dos. */
const appliedSession = {}
const sessionSig = (s) => JSON.stringify([Boolean(s?.loggedIn), s?.user?.id ?? s?.user?.username ?? s?.user?.email ?? null])

/** Tras entrar o salir: si es la plataforma activa, se recargan sus obras (una sola vez por cambio). */
function afterSessionsChanged(p) {
  const sig = sessionSig(state.sessions[p])
  if (appliedSession[p] === sig) { renderScanChip(); renderPlatformMenu(); return }
  appliedSession[p] = sig
  const before = state.hasKey
  refreshConnected()
  renderScanChip()
  renderPlatformMenu()
  emit('sessionsChanged', p)
  if (p === state.platform && (before !== state.hasKey || state.hasKey)) onScanChanged()
}

/** Una sesión que el servidor rechazó: se pide entrar de nuevo. */
function onSessionExpired(error) {
  const p = error.code.split('.')[0]
  if (!PLATFORMS[p]) return
  state.sessions[p] = { loggedIn: false, user: null }
  refreshConnected()
  renderScanChip()
  toast('warn', `Tu sesión de ${plat(p).full} venció`, 'Vuelve a iniciar sesión para seguir.', 8000)
  if (!isImportWindow) openAccountModal(p)
}

/* ---------- Arranque ---------- */

async function initPlatforms() {
  const res = await window.capi.platform.state()
  if (res.ok) {
    state.platform = PLATFORMS[res.data.active] ? res.data.active : 'capibara'
    state.sessions = res.data.sessions || {}
    state.platformInfo = res.data.info || null
    for (const p of PLATFORM_IDS) appliedSession[p] = sessionSig(state.sessions[p])
  }
  renderPlatform()

  $('#platformBtn').addEventListener('click', () => ($('#platformMenu').hidden ? openPlatformMenu() : closePlatformMenu()))
  document.addEventListener('mousedown', (e) => { if (!$('#platformWrap').contains(e.target)) closePlatformMenu() })
  $('#accountSave').addEventListener('click', saveAccount)
  $('#accountForm').addEventListener('submit', (e) => { e.preventDefault(); saveAccount() })
  $('#accountPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveAccount() } })
  $('#accountCancel').addEventListener('click', closeAccountModal)
  $('#accountOut').addEventListener('click', signOutAccount)
  $('#accountReveal').addEventListener('click', () => {
    const i = $('#accountPass')
    i.type = i.type === 'password' ? 'text' : 'password'
  })
  $('#accountModal').addEventListener('mousedown', (e) => { if (e.target.id === 'accountModal') closeAccountModal() })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#accountModal').hidden) closeAccountModal() })

  // Cambios hechos en la otra ventana de la app.
  window.capi.platform.onChanged(({ active }) => { if (active !== state.platform) applyActivePlatform(active) })
  window.capi.platform.onSessions((sessions) => {
    state.sessions = sessions
    PLATFORM_IDS.filter((p) => !isCapibara(p)).forEach(afterSessionsChanged)
  })
}
