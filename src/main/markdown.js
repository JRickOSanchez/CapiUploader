/**
 * Markdown de las notas de los releases → HTML seguro para la ventana de novedades.
 * Primero se escapa todo el texto y después se agregan solo las etiquetas conocidas: nada del
 * release puede meter HTML ni scripts. Los enlaces solo pueden ser http(s) y se abren afuera.
 *
 * Cubre lo que usan las notas: títulos, párrafos, listas (anidadas, con viñetas o numeradas), citas,
 * bloques de código, tablas, separadores, **negrita**, *cursiva*, `código` y [enlaces](https://…).
 */

const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Formato dentro de una línea (sobre texto ya escapado). */
function inline(text) {
  const codes = []
  let s = escape(text).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`)
  s = s
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => `<a href="${url}" data-external>${label}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_([^_\s][^_]*)_(?!\w)/g, '$1<em>$2</em>')
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`)
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l)
const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())

/** Lista (con sus sublistas) a partir de la línea i. Devuelve { html, next }. */
function list(lines, i) {
  const items = []
  const baseIndent = LIST_ITEM.exec(lines[i])[1].length
  const ordered = /\d/.test(LIST_ITEM.exec(lines[i])[2])
  while (i < lines.length) {
    const m = LIST_ITEM.exec(lines[i])
    if (!m || m[1].length < baseIndent) break
    if (m[1].length > baseIndent) {
      const sub = list(lines, i)
      if (items.length) items[items.length - 1] += sub.html
      i = sub.next
      continue
    }
    let text = m[3]
    i++
    // Continuación del mismo punto en la línea siguiente (sin viñeta, con sangría).
    while (i < lines.length && lines[i].trim() && !LIST_ITEM.test(lines[i]) && /^\s{2,}/.test(lines[i])) text += ` ${lines[i++].trim()}`
    items.push(inline(text))
  }
  const tag = ordered ? 'ol' : 'ul'
  return { html: `<${tag}>${items.map((it) => `<li>${it}</li>`).join('')}</${tag}>`, next: i }
}

function render(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    const fence = /^\s*```/.exec(line)
    if (fence) {
      const code = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++])
      i++
      out.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`)
      continue
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) { out.push(`<h${h[1].length}>${inline(h[2].replace(/\s+#+\s*$/, ''))}</h${h[1].length}>`); i++; continue }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push('<hr>'); i++; continue }
    if (LIST_ITEM.test(line)) { const l = list(lines, i); out.push(l.html); i = l.next; continue }
    if (/^\s*>/.test(line)) {
      const quote = []
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''))
      out.push(`<blockquote>${render(quote.join('\n'))}</blockquote>`)
      continue
    }
    if (isTableRow(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const head = cells(line)
      i += 2
      const rows = []
      while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]))
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>`
        + `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`)
      continue
    }
    const para = []
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*>|\s*```)/.test(lines[i]) && !LIST_ITEM.test(lines[i]) && !isTableRow(lines[i])) para.push(lines[i++].trim())
    out.push(`<p>${inline(para.join(' '))}</p>`)
  }
  return out.join('\n')
}

/**
 * Notas para quien ya actualizó: sin el título principal (la ventana muestra el suyo) ni las
 * secciones de instalación, descargas o requisitos.
 */
function releaseNotes(md) {
  const SKIP = /^(descargas?|instalaci[oó]n|c[oó]mo instalar|requisitos|archivos)\b/i
  const kept = []
  let skipping = false
  for (const line of String(md || '').replace(/\r\n?/g, '\n').split('\n')) {
    const h = /^(#{1,2})\s+(.*)$/.exec(line)
    if (h) {
      if (h[1] === '#') continue
      skipping = SKIP.test(h[2].replace(/[^\p{L}\s]/gu, '').trim())
      if (skipping) continue
    }
    if (!skipping) kept.push(line)
  }
  return render(kept.join('\n'))
}

module.exports = { render, releaseNotes }
