'use strict'

/* =========================================================
   Subida en cola de «Varios capítulos», con pausas por los límites de
   cada plataforma. Con «También a…», cada capítulo va a varias a la vez
   y en un reintento solo se sube a las que faltan (it.doneOn).
   ========================================================= */

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
  const scanName = activeProfile()?.name || plat().full
  const workIds = [...new Set(queue.map((i) => i.workId))]
  if (!(await alsoReady(workIds))) return
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
  const label = () => `${pos + 1}/${queue.length} · ${workById(current.workId)?.title || ''} ${current.extra ? `Extra ${current.number}` : `#${current.number}`}`

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
    } else if (p.phase === 'convert') {
      $('#progressText').textContent = `${label()} · convirtiendo a WebP ${p.done}/${p.total}…`
    } else if (p.phase === 'platform') {
      alsoProgress(p)
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
    it.doneOn ||= new Set()
    const targets = uploadTargets(work.id, it.doneOn)
    alsoProgressStart(targets)
    const res = !targets ? { ok: true, data: { skipped: true } } : await window.capi.upload.start({
      ...targets,
      files: it.files.map((f) => ({ path: f.path, single: Boolean(f.single) })),
      chapter: {
        number: it.number,
        title: it.title || null,
        volumeNumber: it.volume,
        publishAt: sched.publishAt ? sched.publishAt.toISOString() : null,
        notify: plan.notify,
        announcePage: announcePageFor(it.files),
        extra: Boolean(it.extra),
      },
    })
    bytesBefore += sumSize(it.files)
    const tally = perWork.get(it.workId) || { ok: 0, failed: 0 }
    perWork.set(it.workId, tally)

    // Subida a varias: lo que sí quedó no se repite al reintentar.
    if (!res.ok && res.error.results) {
      okPlatforms(res.error.results).forEach((p) => it.doneOn.add(p))
      if (res.error.code !== 'api.rate_limited' && res.error.code !== 'cancelled') res.error.message = `${res.error.message} (${resultsText(res.error.results)})`
    }

    if (res.ok) {
      it.status = 'done'
      it.doneOn = null
      it.result = res.data
      it.progress = 1
      ok++
      tally.ok++
      warnSingles(res.data.singleCheck, itemLabel(it))
      const cache = state.chaptersByWork.get(it.workId)
      const entry = { id: res.data.id, number: res.data.number ?? it.number, extra: Boolean(it.extra), extraNumber: it.extra ? it.number : null, volumeNumber: it.volume, title: it.title || '', pages: it.files.length, state: res.data.state, url: res.data.url }
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
      // Un límite de la plataforma: se espera lo que dice y se reintenta este mismo capítulo
      // (las páginas ya subidas se reutilizan; con varias plataformas, solo donde faltaba).
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
  // Se olvidan las páginas ya subidas de todo lo que quedó resuelto: solo se guardan las de los
  // capítulos que siguen en la cola (fallidos o cancelados), para reintentarlos sin volver a subirlas.
  window.capi.upload.keepOnly(queue.filter((i) => i.status !== 'done').flatMap((i) => i.files.map((f) => f.path)))
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

/** Espera a que la plataforma libere el límite, con cuenta atrás en la barra. false si se canceló. */
async function waitRateLimit(error) {
  const who = plat(error.platform || state.platform).label
  const until = Date.now() + (error.retryAfter + 3) * 1000
  const at = new Date(until).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
  toast('warn', 'Subida en pausa', `${error.message} Sigue sola a las ${at}; puedes dejar el programa abierto.`, 12000)
  while (Date.now() < until) {
    if (batch.cancelled) return false
    const left = Math.ceil((until - Date.now()) / 1000)
    $('#progressText').textContent = `En pausa por un límite de ${who} · sigue a las ${at} (falta ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')})`
    await new Promise((r) => setTimeout(r, 1000))
  }
  return !batch.cancelled
}

/**
 * Antes de subir: si algún capítulo va con un número distinto al de su carpeta, o con uno
 * asignado solo porque la carpeta no lo trae, se muestra el resumen y se pide confirmación.
 */
async function confirmNumbering(queue) {
  const odd = queue.filter((i) => i.parsedNumber != null && (i.number !== i.parsedNumber || Boolean(i.parsedExtra) !== Boolean(i.extra)))
  const auto = queue.filter((i) => i.parsedNumber == null && i.numberSource === 'auto')
  if (!odd.length && !auto.length) return true
  const MAX = 8
  const lines = [
    ...odd.map((i) => `«${i.name}» → ${itemLabel(i).toLowerCase()} (la carpeta dice ${chapterLabel(i.parsedNumber, i.parsedExtra).toLowerCase()})`),
    ...auto.map((i) => `«${i.name}» → ${itemLabel(i).toLowerCase()} (la carpeta no trae número)`),
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
  $('#doneOpen').textContent = single ? `Ver obra en ${plat().label}` : `Ver scan en ${plat().label}`
  $('#doneOpen').hidden = !url
  $('#doneNext').textContent = 'Listo'
  $('#doneModal').hidden = false
}
