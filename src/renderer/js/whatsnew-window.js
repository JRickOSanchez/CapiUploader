'use strict'

/* =========================================================
   Ventana «Novedades» (whatsnew.html). Página aparte de la
   interfaz principal: solo usa window.novedades del preload.
   Las notas llegan ya convertidas a HTML seguro desde el
   proceso principal (src/main/markdown.js).
   ========================================================= */
;(async () => {
  const $ = (sel) => document.querySelector(sel)
  let releaseUrl = null

  $('#wnClose').addEventListener('click', () => window.novedades.close())
  $('#wnGithub').addEventListener('click', () => { if (releaseUrl) window.novedades.openExternal(releaseUrl) })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' || e.key === 'Enter') window.novedades.close() })
  // Los enlaces de las notas se abren en el navegador.
  $('#wnNotes').addEventListener('click', (e) => {
    const a = e.target.closest('a[href]')
    if (!a) return
    e.preventDefault()
    window.novedades.openExternal(a.href)
  })

  const res = await window.novedades.data()
  const d = res.ok ? res.data : { version: '', title: 'CapiUploader', html: '', error: res.error.message }
  document.documentElement.dataset.theme = d.theme === 'light' ? 'light' : 'dark'
  releaseUrl = d.url || null
  $('#wnGithub').hidden = !releaseUrl

  $('#wnTitle').textContent = `Versión ${d.version}`
  const date = d.publishedAt ? new Date(d.publishedAt).toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' }) : ''
  // El título del release sin el «CapiUploader v1.4.0:» del principio, que ya dice el encabezado.
  const rest = String(d.title || '').replace(/^capiuploader\s*v?[\d.]+\s*[:—–-]?\s*/i, '')
  const subtitle = rest ? rest[0].toUpperCase() + rest.slice(1) : ''
  $('#wnMeta').textContent = [subtitle, date].filter(Boolean).join(' · ')

  $('#wnLoading').hidden = true
  if (d.html) {
    $('#wnNotes').innerHTML = d.html
    $('#wnNotes').hidden = false
  } else {
    $('#wnEmptyText').textContent = d.error
      ? 'No se pudieron cargar las novedades (¿sin conexión?). Puedes verlas en GitHub.'
      : 'Esta versión todavía no tiene notas publicadas.'
    $('#wnEmpty').hidden = false
  }
  $('#wnClose').focus()
})()
