'use strict'

/* =========================================================
   Joints de Capibara: obras que varios scans llevan juntos. Van
   en la lista de obras con id «joint:<id>». Aquí: la barra bajo la
   obra elegida y la ventana con las versiones de cada número
   (cuál ven los lectores) y la papelera del joint.
   ========================================================= */

const isJointWork = (w) => Boolean(w?.joint)
/** ¿Puede el scan subir a esta obra? (en un joint, el VIEWER no). */
const canUploadTo = (w) => !isJointWork(w) || w.joint.canUpload
const JOINT_VIEWER_TEXT = 'En este joint tu scan solo puede ver: pide al líder el rol de uploader para subir capítulos.'

const jm = { work: null, view: null, trash: null, tab: 'versions', busy: false, filter: 'all' }

/** La línea bajo las estadísticas de la obra cuando es un joint. */
function jointBar(w) {
  const j = w.joint
  return el('div', { class: `joint-bar${j.canUpload ? '' : ' viewer'}` },
    el('span', { class: 'tag joint', text: 'Joint' }),
    el('span', { class: 'joint-role', text: `Tu rol: ${j.roleText}${j.memberCount ? ` · ${plural(j.memberCount, 'scan', 'scans')}` : ''}` }),
    j.canUpload ? null : el('span', { class: 'joint-warn', text: 'Solo puedes ver: no puedes subir capítulos.' }),
    el('span', { class: 'spacer' }),
    el('button', { type: 'button', class: 'btn small secondary', text: 'Versiones y papelera', onclick: () => openJointModal(w) }))
}

async function openJointModal(work) {
  jm.work = work
  jm.view = null
  jm.trash = null
  jm.tab = 'versions'
  jm.filter = 'all'
  $('#jointTitle').textContent = work.title
  $('#jointSub').textContent = 'Cargando…'
  $('#jointModal').hidden = false
  renderJoint()
  await Promise.all([loadJointView(), loadJointTrash()])
}

function closeJointModal() {
  if ($('#jointModal').hidden) return
  $('#jointModal').hidden = true
  jm.work = null
}

async function loadJointView() {
  const work = jm.work
  const res = await window.capi.joint.view(work.id)
  if (jm.work !== work) return
  if (!res.ok) { jm.view = { error: res.error }; renderJoint(); return }
  jm.view = res.data
  renderJoint()
}

async function loadJointTrash() {
  const work = jm.work
  const res = await window.capi.joint.trash(work.id)
  if (jm.work !== work) return
  jm.trash = res.ok ? res.data : { error: res.error }
  renderJoint()
}

const jointNumberLabel = (c) => (c.extra ? `Extra ${c.extraNumber ?? shownNumber(c)}` : `Cap ${c.number}`)
const STATE_TEXT = { published: 'Publicado', scheduled: 'Programado', hidden: 'Oculto', draft: 'Borrador' }

function renderJoint() {
  const v = jm.view
  const body = $('#jointBody')
  body.innerHTML = ''
  $('#jointTabs .chip').forEach((c) => c.classList.toggle('active', c.dataset.tab === jm.tab))
  $('#jointHelp').hidden = jm.tab === 'trash'
  if (v && !v.error) {
    const members = v.members.map((m) => `${m.name} (${m.roleText})`).join(' · ')
    $('#jointSub').textContent = `Tu rol: ${v.roleText}${members ? ` · ${members}` : ''}`
  } else if (v?.error) {
    $('#jointSub').textContent = 'No se pudo cargar el joint.'
  }
  $('#jointOpen').hidden = !v?.url
  if (jm.tab === 'trash') return renderJointTrash(body)
  if (!v) return body.append(el('p', { class: 'muted joint-empty', text: 'Cargando los capítulos del joint…' }))
  if (v.error) return body.append(el('p', { class: 'muted joint-empty', text: withTrace(v.error) }))
  const many = v.chapters.filter((c) => c.versions.length > 1)
  $('#jointFilter').hidden = !many.length
  $('#jointFilter').textContent = jm.filter === 'many' ? 'Ver todos los números' : `Solo los que tienen varias versiones (${many.length})`
  const list = jm.filter === 'many' ? many : v.chapters
  if (!list.length) return body.append(el('p', { class: 'muted joint-empty', text: 'El joint todavía no tiene capítulos.' }))
  const ul = el('ul', { class: 'joint-list' })
  list.forEach((c) => ul.append(jointRow(c)))
  body.append(ul)
}

function jointRow(c) {
  const shown = c.versions.find((x) => x.shown)
  const versions = c.versions.map((x) => el('li', { class: `jv${x.shown ? ' shown' : ''}${x.mine ? ' mine' : ''}` },
    el('span', { class: 'jv-scan', text: x.scan || 'Scan' }),
    x.mine ? el('span', { class: 'tag', text: 'Tuya' }) : null,
    el('span', { class: 'jv-meta', text: [x.pages != null ? `${x.pages} pág.` : '', STATE_TEXT[x.state] || x.state || '', x.location === 'solo' ? 'en su ficha' : ''].filter(Boolean).join(' · ') }),
    x.shown ? el('span', { class: 'jv-shown', text: 'La ven los lectores' }) : null,
    x.mine && !x.shown && c.canShowMine
      ? el('button', { type: 'button', class: 'btn small primary', text: 'Mostrar la mía', disabled: jm.busy, onclick: () => jointShow(c, x) })
      : null))
  return el('li', { class: 'joint-row' },
    el('div', { class: 'joint-head' },
      el('b', { text: jointNumberLabel(c) }),
      shown?.title ? el('span', { class: 'joint-title', text: `— ${shown.title}` }) : null,
      el('span', { class: 'spacer' }),
      c.canRelease ? el('button', { type: 'button', class: 'btn small ghost', text: 'Liberar mi elección', title: 'Deja de fijar tu versión en este número: otro scan podrá elegir la suya.', disabled: jm.busy, onclick: () => jointRelease(c) }) : null,
      c.url ? el('button', { type: 'button', class: 'icon-btn small ghost', title: 'Abrir en Capibara', html: ICON_OPEN, onclick: () => window.capi.system.openExternal(c.url) }) : null),
    el('ul', { class: 'jv-list' }, ...versions))
}

function renderJointTrash(body) {
  const t = jm.trash
  $('#jointFilter').hidden = true
  if (!t) return body.append(el('p', { class: 'muted joint-empty', text: 'Cargando la papelera…' }))
  if (t.error) {
    const text = t.error.code === 'api.scope_missing' ? 'Para ver la papelera, la API key necesita el permiso chapters:write.' : withTrace(t.error)
    return body.append(el('p', { class: 'muted joint-empty', text }))
  }
  if (!t.chapters.length) return body.append(el('p', { class: 'muted joint-empty', text: `La papelera está vacía. Lo que se borre se guarda ${t.days} días.` }))
  body.append(el('p', { class: 'muted joint-note', text: `Se borra para siempre a los ${t.days} días.` }))
  const ul = el('ul', { class: 'joint-list' })
  for (const c of t.chapters) {
    ul.append(el('li', { class: 'joint-row trash' },
      el('div', { class: 'joint-head' },
        el('b', { text: c.extra ? `Extra ${c.displayNumber ?? c.number}` : `Cap ${c.displayNumber ?? c.number}` }),
        c.title ? el('span', { class: 'joint-title', text: `— ${c.title}` }) : null,
        el('span', { class: 'spacer' }),
        el('span', { class: 'jv-meta', text: [c.deletedAt ? `Borrado ${relativeFromNow(new Date(c.deletedAt))}` : '', c.purgeAt ? `se elimina el ${formatDate(new Date(c.purgeAt))}` : ''].filter(Boolean).join(' · ') }),
        c.restorable ? el('button', { type: 'button', class: 'btn small secondary', text: 'Restaurar', disabled: jm.busy, onclick: () => jointRestore(c) }) : null),
      c.reason ? el('p', { class: 'muted joint-note', text: c.reason }) : null))
  }
  body.append(ul)
}

async function jointAction(run, okTitle) {
  if (jm.busy) return
  jm.busy = true
  renderJoint()
  const res = await run()
  jm.busy = false
  if (!res.ok) { renderJoint(); return handleApiError(res.error, 'No se pudo hacer el cambio') }
  toast('success', okTitle)
  await Promise.all([loadJointView(), jm.tab === 'trash' ? loadJointTrash() : null])
  // La lista de capítulos de la obra cambió: se vuelve a pedir.
  if (state.selectedWork?.id === jm.work?.id) loadChapters()
  else if (jm.work) ensureChapters(jm.work.id, { force: true })
}

function jointShow(c, version) {
  return jointAction(() => window.capi.joint.show(jm.work.id, c.number, version.id), `${jointNumberLabel(c)}: ahora se ve tu versión`)
}

async function jointRelease(c) {
  const choice = await ask({
    kind: 'warn',
    title: `¿Liberar tu elección del ${jointNumberLabel(c)}?`,
    text: 'Tu versión no se borra. Solo dejas de fijarla como la visible, y otro scan del joint podrá elegir la suya.',
    buttons: [{ value: 'no', label: 'Cancelar', cancel: true }, { value: 'yes', label: 'Liberar', kind: 'primary' }],
  })
  if (choice !== 'yes') return
  return jointAction(() => window.capi.joint.release(jm.work.id, c.number), `${jointNumberLabel(c)}: elección liberada`)
}

function jointRestore(c) {
  return jointAction(() => window.capi.chapter.restore(c.id), `Cap ${c.displayNumber ?? c.number} restaurado`)
}

/** Después de subir a un joint: si el número ya era de otro scan, el capítulo quedó en la ficha. */
function noteJointResult(work, data, label) {
  if (!isJointWork(work) || !data?.quedoEnFicha) return
  toast('warn', `${label}: quedó en tu ficha`, `Ese número del joint ya lo tiene ${data.ocupadoPor || 'otro scan'}. Tu versión quedó en tu ficha; en «Versiones y papelera» puedes elegir cuál se muestra.`, 12000)
}

function initJoints() {
  if (!$('#jointModal')) return
  $('#jointClose').addEventListener('click', closeJointModal)
  $('#jointDone').addEventListener('click', closeJointModal)
  $('#jointModal').addEventListener('mousedown', (e) => { if (e.target.id === 'jointModal') closeJointModal() })
  $('#jointModal').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeJointModal() } })
  $('#jointReload').addEventListener('click', () => { jm.view = null; jm.trash = null; renderJoint(); loadJointView(); loadJointTrash() })
  $('#jointOpen').addEventListener('click', () => { if (jm.view?.url) window.capi.system.openExternal(jm.view.url) })
  $('#jointFilter').addEventListener('click', () => { jm.filter = jm.filter === 'many' ? 'all' : 'many'; renderJoint() })
  $$('#jointTabs .chip').forEach((c) => c.addEventListener('click', () => { jm.tab = c.dataset.tab; renderJoint() }))
}
