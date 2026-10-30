'use strict'

/* =========================================================
   «Mis scans»: varias API keys, una activa a la vez.
   ========================================================= */

const ICON_CHECK_SM = '<svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg>'
const ICON_REFRESH = '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5"/></svg>'
const ICON_TRASH = '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>'

/** El scan de Capibara activo (null en Crimson y Mangation, que usan cuenta en vez de scan). */
function activeProfile() {
  if (!isCapibara()) return null
  return state.profiles.find((p) => p.id === state.activeScanId) || null
}

function applyProfiles(data) {
  state.profiles = data.profiles || []
  state.activeScanId = data.activeId ?? null
  refreshConnected()
}

const canWrite = (p) => Boolean(p?.scopes?.includes('chapters:write'))

function scanAvatar(p) {
  return el('span', { class: 'scan-avatar', text: (p.name || '?').trim().charAt(0).toUpperCase() })
}

function scanStatus(p) {
  if (p.status === 'invalid') return { cls: 'err', text: 'Clave inválida o revocada' }
  if (!canWrite(p)) return { cls: 'warn', text: 'Sin permiso chapters:write' }
  return { cls: 'ok', text: p.slug ? `/${p.slug}` : 'Lista para subir' }
}

function renderScanChip() {
  const dot = $('#scanDot')
  dot.className = 'dot'
  if (!isCapibara()) {
    // Crimson y Mangation: el chip muestra la cuenta y abre su inicio de sesión.
    const name = accountName(state.platform)
    $('#scanName').textContent = name || 'Iniciar sesión'
    dot.classList.add(name ? 'ok' : 'err')
    $('#scanChip').title = name ? `Tu cuenta de ${plat().full}` : `Inicia sesión en ${plat().full}`
    return
  }
  const p = activeProfile()
  if (!p) {
    $('#scanName').textContent = 'Agregar scan'
    dot.classList.add('err')
  } else {
    $('#scanName').textContent = p.name
    dot.classList.add(scanStatus(p).cls)
  }
  $('#scanChip').title = state.profiles.length > 1 ? 'Cambiar de scan' : 'Tus scans'
  renderScanMenu()
}

function renderScanMenu() {
  const list = $('#scanMenuList')
  list.innerHTML = ''
  if (!state.profiles.length) {
    list.append(el('li', { class: 'scan-pop-empty', text: 'Aún no registras ningún scan.' }))
    return
  }
  for (const p of state.profiles) {
    const st = scanStatus(p)
    const active = p.id === state.activeScanId
    list.append(el('li', {},
      el('button', {
        type: 'button', role: 'menuitemradio', 'aria-checked': String(active),
        class: `scan-item${active ? ' active' : ''}`,
        onclick: () => switchScan(p.id),
      },
      scanAvatar(p),
      el('span', { class: 'scan-item-text' },
        el('span', { class: 'scan-item-name', text: p.name }),
        el('span', { class: `scan-item-sub ${st.cls}`, text: st.text })),
      active ? el('span', { class: 'scan-item-check', html: ICON_CHECK_SM }) : null)))
  }
}

function openScanMenu() {
  if (!isCapibara()) return openAccountModal()
  if (!state.profiles.length) return openKeyModal(true)
  renderScanMenu()
  $('#scanMenu').hidden = false
  $('#scanChip').setAttribute('aria-expanded', 'true')
}

function closeScanMenu() {
  $('#scanMenu').hidden = true
  $('#scanChip').setAttribute('aria-expanded', 'false')
}

async function switchScan(id) {
  closeScanMenu()
  if (id === state.activeScanId) return
  if (state.uploading) return toast('warn', 'Hay una subida en curso', 'Espera a que termine para cambiar de scan.')
  const res = await window.capi.profiles.setActive(id)
  if (!res.ok) return toast('error', 'No se pudo cambiar de scan', res.error.message)
  applyProfiles(res.data)
  onScanChanged()
  toast('info', `Ahora estás en ${activeProfile().name}`, 'Se cargaron sus obras.')
}

/** Al cambiar de scan se descartan obras, capítulos y obras asignadas de la sesión anterior. */
function onScanChanged() {
  state.scanGen++
  state.me = null
  state.works = []
  state.chapters = []
  state.chaptersByWork.clear()
  state.selectedWork = null
  state.autoNumber = true
  state.autoVolume = true
  emit('scanChanged')
  renderScanChip()
  renderWorkTrigger()
  renderWorkInfo()
  renderWorkList()
  validate()
  if (state.hasKey) loadWorks()
}

/* ---------- Modal «Mis scans» ---------- */

function openKeyModal(focusAdd = false) {
  closeScanMenu()
  if (!isCapibara()) return openAccountModal()
  $('#keyInput').value = ''
  $('#keyInput').type = 'password'
  $('#keyError').textContent = ''
  $('#keyCancel').hidden = !state.profiles.length
  $('#keyAddLabel').textContent = state.profiles.length ? 'Agregar otro scan' : 'Pega la API key de tu scan'
  renderScanList()
  $('#keyModal').hidden = false
  if (focusAdd || !state.profiles.length) setTimeout(() => $('#keyInput').focus(), 50)
}

function closeKeyModal() {
  if (!state.profiles.length) return
  $('#keyModal').hidden = true
}

function renderScanList() {
  const list = $('#scanList')
  list.innerHTML = ''
  list.hidden = !state.profiles.length
  for (const p of state.profiles) {
    const active = p.id === state.activeScanId
    const st = scanStatus(p)
    const scopes = (p.scopes || []).map((sc) => el('span', { class: `badge ${sc === 'chapters:write' ? 'success' : ''}`, text: sc }))
    const remove = el('button', {
      type: 'button', class: 'icon-btn small ghost danger-hover', title: 'Quitar este scan de la app', html: ICON_TRASH,
      onclick: (e) => removeScan(p, e.currentTarget),
    })
    list.append(el('li', { class: `scan-row${active ? ' active' : ''}` },
      scanAvatar(p),
      el('div', { class: 'scan-row-text' },
        el('div', { class: 'scan-row-name' },
          el('span', { text: p.name }),
          active ? el('span', { class: 'badge accent', text: 'Activo' }) : null,
          p.status === 'invalid' ? el('span', { class: 'badge danger', text: 'Clave inválida' }) : null),
        el('div', { class: 'scan-row-sub' },
          el('span', { text: `${p.keyName || 'Clave'} · ${p.prefix || 'capi_'}…` }),
          el('span', { class: 'sep' }),
          el('span', { text: p.expiresAt ? `Vence ${formatDate(new Date(p.expiresAt), false)}` : 'Sin vencimiento' })),
        el('div', { class: 'scan-row-scopes' }, scopes, el('span', { class: `scan-row-status ${st.cls}`, text: st.cls === 'ok' ? '' : st.text }))),
      el('div', { class: 'scan-row-actions' },
        active ? null : el('button', { type: 'button', class: 'btn secondary small', text: 'Usar', onclick: () => { switchScan(p.id); renderScanList() } }),
        el('button', { type: 'button', class: 'icon-btn small ghost', title: 'Verificar la clave', html: ICON_REFRESH, onclick: (e) => verifyScan(p, e.currentTarget) }),
        remove)))
  }
}

async function verifyScan(p, btn) {
  btn.classList.add('spin')
  btn.disabled = true
  const res = await window.capi.profiles.verify(p.id)
  btn.classList.remove('spin')
  btn.disabled = false
  const list = await window.capi.profiles.list()
  if (list.ok) applyProfiles(list.data)
  if (res.ok) {
    if (p.id === state.activeScanId) state.me = res.data.me
    toast('success', `${p.name}: la clave funciona`, canWrite(res.data.me.key) ? null : 'Pero no tiene el permiso chapters:write.')
  } else {
    toast('error', `${p.name}: ${res.error.code === 'api.key_invalid' ? 'la clave ya no es válida' : 'no se pudo verificar'}`, res.error.message, 8000)
  }
  renderScanChip()
  renderScanList()
}

async function removeScan(p, btn) {
  // Doble clic de confirmación para no quitar un scan por accidente.
  if (btn.dataset.confirm !== '1') {
    btn.dataset.confirm = '1'
    btn.classList.add('confirm')
    btn.title = 'Clic otra vez para quitarlo'
    toast('warn', `¿Quitar ${p.name}?`, 'Vuelve a dar clic en el bote para confirmar. La clave no se borra de Capibara, solo de esta app.')
    setTimeout(() => { btn.dataset.confirm = ''; btn.classList.remove('confirm') }, 4000)
    return
  }
  if (state.uploading && p.id === state.activeScanId) return toast('warn', 'Hay una subida en curso', 'Espera a que termine para quitar este scan.')
  const wasActive = p.id === state.activeScanId
  const res = await window.capi.profiles.remove(p.id)
  if (!res.ok) return toast('error', 'No se pudo quitar el scan', res.error.message)
  applyProfiles(res.data)
  toast('info', `Se quitó ${p.name}`)
  if (wasActive) onScanChanged()
  else renderScanChip()
  openKeyModal(!state.profiles.length)
}

async function saveKey() {
  const btn = $('#keySave')
  const value = $('#keyInput').value.trim()
  if (!value) { $('#keyError').textContent = 'Pega la API key del scan.'; return }
  const before = state.activeScanId
  btn.disabled = true
  btn.textContent = 'Verificando…'
  const res = await window.capi.profiles.add(value)
  btn.disabled = false
  btn.textContent = 'Verificar y agregar'
  if (!res.ok) {
    $('#keyError').textContent = res.error.message
    return
  }
  const { added, replaced, me } = res.data
  applyProfiles(res.data)
  $('#keyInput').value = ''
  $('#keyError').textContent = ''
  toast('success', replaced ? `Clave de ${added.name} actualizada` : `Se agregó ${added.name}`,
    canWrite(me.key) ? 'Ya puedes subir capítulos a este scan.' : 'Ojo: esta clave no tiene el permiso chapters:write, no podrá subir capítulos.', 8000)
  $('#keyModal').hidden = true
  if (before !== state.activeScanId || replaced) {
    onScanChanged()
    state.me = me
  } else {
    renderScanChip()
  }
}

function initKeyModal() {
  $('#settingsBtn').addEventListener('click', () => openKeyModal())
  $('#scanChip').addEventListener('click', () => ($('#scanMenu').hidden ? openScanMenu() : closeScanMenu()))
  $('#scanMenuAdd').addEventListener('click', () => openKeyModal(true))
  $('#scanMenuManage').addEventListener('click', () => openKeyModal())
  document.addEventListener('mousedown', (e) => { if (!$('#scanMenuWrap').contains(e.target)) closeScanMenu() })
  $('#keySave').addEventListener('click', saveKey)
  $('#keyCancel').addEventListener('click', closeKeyModal)
  $('#keyInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveKey() })
  $('#keyReveal').addEventListener('click', () => {
    const i = $('#keyInput')
    i.type = i.type === 'password' ? 'text' : 'password'
  })
  $('#keyModal').addEventListener('mousedown', (e) => { if (e.target.id === 'keyModal') closeKeyModal() })
}
