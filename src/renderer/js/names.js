'use strict'

/* =========================================================
   Detección del número, el tomo, el título y la obra a partir
   de los nombres de las carpetas (funciones puras).
   ========================================================= */

// «Vol 3», «Tomo 2», «v1» y «Cap 12», «Capítulo 12.5», «Ch 20», «Ep 4»…
const VOL_RE = /\b(?:vol(?:umen|ume)?|tomo|v)\s*[.#:-]?\s*(\d+)\b/i
const CAP_RE = /\b(?:cap(?:[ií]tulo|itulo)?|chapter|chap|ch|ep(?:isodio|isode)?|c)\s*[.#:-]?\s*(\d+(?:[.,]\d+)?)/i
// «Extra 2», «Especial», «Omake 1», «Bonus»… Solo cuenta si va antes del «Cap N», para no tomar
// como extra un «Cap 12 - Un día especial».
const EXTRA_RE = /\b(?:extras?|especial(?:es)?|specials?|omake|bonus)\b(?:\s*[.#:-]?\s*(\d+(?:[.,]\d+)?))?/i

/**
 * Interpreta nombres de carpeta como «Cap 12», «Capítulo 12.5 - El regreso»,
 * «Vol 3 Ch 20», «[Scan] Kirara 015», «013» o «Extra 2 - Ilustraciones».
 */
function parseChapterName(raw) {
  const name = raw.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim()
  const clean = name.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()
  const titleAfter = (rest) => {
    const m = rest.match(/^\s*[-–—:|]\s*(.+)$/)
    return m ? m[1].trim().slice(0, 256) : ''
  }

  const vol = clean.match(VOL_RE)
  const cap = clean.match(CAP_RE)
  const ex = clean.match(EXTRA_RE)
  let number = null
  let title = ''
  if (ex && (!cap || ex.index < cap.index)) {
    return {
      number: ex[1] ? parseFloat(ex[1].replace(',', '.')) : null,
      volume: vol ? parseInt(vol[1], 10) : null,
      title: titleAfter(clean.slice(ex.index + ex[0].length)),
      extra: true,
    }
  }
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
  return { number, volume: vol ? parseInt(vol[1], 10) : null, title, extra: false }
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

/** Quita guiones bajos y lo que va entre corchetes, paréntesis o llaves: «Choujin X [Scan] (2023)» → «Choujin X». */
const cleanFolderName = (raw) => String(raw || '').replace(/_+/g, ' ').replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, ' ').replace(/\s+/g, ' ').trim()

/** La parte del nombre de un capítulo que nombra a la obra: «Choujin X Cap 12 - Título» → «Choujin X». */
function workHintFromName(raw) {
  let s = cleanFolderName(raw)
  // «Choujin X Extra 2» → «Choujin X»
  const ex = s.match(EXTRA_RE)
  if (ex) s = s.slice(0, ex.index)
  const cap = s.match(CAP_RE)
  if (cap) s = s.slice(0, cap.index)
  else if (!ex) {
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
