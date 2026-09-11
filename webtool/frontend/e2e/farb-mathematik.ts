/**
 * Farb-Mathematik für die Browser-Wächter — EINE Quelle, zwei Welten.
 *
 * Dieselbe Bauart wie `zustands-probe.mjs` des design-beweis-Skills: der Rechenkern liegt
 * als QUELLE vor, wird in der Seite installiert (page.evaluate(MATH_QUELLE)) und im Test
 * über `TKFarbe` geladen — zwei Kopien derselben Rechnung wären der zweite Extraktor,
 * an dem genau das Muster dieses Repos sonst festgenagelt wird.
 *
 * Warum hier mehr geparst wird als in der Sonde: Tailwind v4 übersetzt Deckkraft-
 * Modifikatoren (`border-foreground/50`) über `color-mix(in oklab, …)`, und Chromium
 * serialisiert das Ergebnis als OKLCH. Wer OKLCH nicht zerlegen kann, ist auf jeder
 * Tailwind-4-Seite blind für genau die Konturen, die der #515-Fix baut — die Sonde
 * meldet das ehrlich als UNBEKANNT, ein Wächter darf an seiner eigenen Messgrösse
 * nicht blind sein. Die Umrechnung ist Ottossons OKLab→linear-sRGB-Matrix.
 */

export const MATH_QUELLE = `
globalThis.TKFarbe = {
  // oklab(L a b [/ A]) -> linear sRGB -> sRGB. GetComputedStyle liefert nur
  // darstellbare Ergebnisse; das Klemmen ist fuer Rundungsfehler da.
  _oklab(L, oa, ob, a) {
    const l_ = L + 0.3963377774 * oa + 0.2158037573 * ob
    const m_ = L - 0.1055613458 * oa - 0.0638541728 * ob
    const s_ = L - 0.0894841775 * oa - 1.2914855480 * ob
    const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_
    const lin = [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    ]
    const gamma = (x) => {
      const v = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055
      return Math.min(255, Math.max(0, Math.round(v * 255)))
    }
    return { r: gamma(lin[0]), g: gamma(lin[1]), b: gamma(lin[2]), a }
  },
  _oklch(L, C, H, a) {
    const rad = H * Math.PI / 180
    return this._oklab(L, C * Math.cos(rad), C * Math.sin(rad), a)
  },
  rgba(s) {
    if (!s) return null
    s = String(s).trim()
    if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
    let m = s.match(/^#([0-9a-f]+)$/i)
    if (m) {
      const h = m[1]
      const n = (h.length === 3 || h.length === 4) ? h.split('').map((c) => c + c).join('') : h
      if (n.length !== 6 && n.length !== 8) return null
      return {
        r: parseInt(n.slice(0, 2), 16), g: parseInt(n.slice(2, 4), 16), b: parseInt(n.slice(4, 6), 16),
        a: n.length === 8 ? parseInt(n.slice(6, 8), 16) / 255 : 1,
      }
    }
    m = s.match(/^rgba?\\(([^)]+)\\)/i)
    if (m) {
      // Kanäle: getComputedStyle liefert 0-255, Prozentangaben (Autoren-CSS) brauchen
      // die Umrechnung. Alpha ist SEPARAT zu behandeln — sie skaliert 0-1, auch als
      // Prozent (kalter Review: 'rgb(0 0 0 / 50%)' gab a=127.5, ueber() rechnete dann
      // auf r=-32257). Latent (computed styles tragen dezimales Alpha), aber der
      // Zweig existiert laut eigenem Kommentar genau fuer Prozentangaben.
      const roh = m[1].split(/[\\s,/]+/).filter(Boolean)
      const kanal = (t) => (t.endsWith('%') ? (parseFloat(t) / 100) * 255 : parseFloat(t))
      const alphaWert = (t) => (t.endsWith('%') ? parseFloat(t) / 100 : parseFloat(t))
      if (roh.length < 3 || roh.slice(0, 4).some((v) => Number.isNaN(parseFloat(v)))) return null
      return { r: kanal(roh[0]), g: kanal(roh[1]), b: kanal(roh[2]), a: roh.length > 3 ? alphaWert(roh[3]) : 1 }
    }
    m = s.match(/^oklch\\(\\s*([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)(?:\\s*\\/\\s*([\\d.]+%?))?\\s*\\)/i)
    if (m) {
      const alpha = m[4] === undefined ? 1 : parseFloat(m[4]) / (m[4].endsWith('%') ? 100 : 1)
      return this._oklch(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), alpha)
    }
    // color-mix(in oklab, …) serialisiert als OKLAB — Tailwind-v4-Deckkraft-Modifikatoren
    // (border-foreground/50) kommen GENAU SO aus getComputedStyle heraus; ohne diesen
    // Zweig bliebe die Kontur des #515-Fixes unmessbar (gemessen: kontur=null).
    m = s.match(/^oklab\\(\\s*([\\d.-]+)\\s+([\\d.-]+)\\s+([\\d.-]+)(?:\\s*\\/\\s*([\\d.%]+))?\\s*\\)/i)
    if (m) {
      const alpha = m[4] === undefined ? 1 : parseFloat(m[4]) / (m[4].endsWith('%') ? 100 : 1)
      return this._oklab(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), alpha)
    }
    m = s.match(/^color\\(\\s*srgb\\s+([\\d.-]+)\\s+([\\d.-]+)\\s+([\\d.-]+)(?:\\s*\\/\\s*([\\d.%]+))?\\s*\\)/i)
    if (m) {
      const k = (x) => Math.min(255, Math.max(0, Math.round(x * 255)))
      const alpha = m[4] === undefined ? 1 : parseFloat(m[4]) / (m[4].endsWith('%') ? 100 : 1)
      return { r: k(parseFloat(m[1])), g: k(parseFloat(m[2])), b: k(parseFloat(m[3])), a: alpha }
    }
    return null
  },
  leuchtdichte(c) {
    const f = (v) => {
      const x = v / 255
      return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
  },
  verhaeltnis(a, b) {
    const la = this.leuchtdichte(a), lb = this.leuchtdichte(b)
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
  },
  ueber(fg, bg) {
    const a = fg.a
    return {
      r: fg.r * a + bg.r * (1 - a),
      g: fg.g * a + bg.g * (1 - a),
      b: fg.b * a + bg.b * (1 - a),
      a: a + bg.a * (1 - a),
    }
  },
  // Alle Farben aus einem box-shadow — Tailwind-Ringe sind 0-0-0-Npx-Schatten; ein
  // dekorativer Schlagschatten liefert weitere Farben, der Aufrufer nimmt das Maximum.
  // Die Klammer MUSS mitgefasst werden: rgb(79, 70, 229) enthaelt Kommas — ein Muster
  // bis zum naechsten Komma liefert nur rgb(79, und genau so verschwand der Ring.
  schattenFarben(schatten) {
    if (!schatten || schatten === 'none') return []
    const raus = []
    for (const m of String(schatten).matchAll(/(?:oklch|oklab|rgba?)\\([^)]*\\)|color\\(srgb[^)]*\\)|#[0-9a-f]+/gi)) {
      const c = this.rgba(m[0].trim())
      if (c) raus.push(c)
    }
    return raus
  },
}
`

/** Node-Seite derselben Quelle — für Selbstprüfungen ausserhalb des Browsers. */
const KERN: Record<string, unknown> = {}
new Function('globalThis', MATH_QUELLE).call(KERN, KERN)

/** Der Rechenkern, in Node geladen — identisch zu dem, was die Seite bekommt. */
export const TKFarbe = KERN.TKFarbe as {
  rgba(s: string): { r: number; g: number; b: number; a: number } | null
  verhaeltnis(a: { r: number; g: number; b: number; a: number }, b: { r: number; g: number; b: number; a: number }): number
  ueber(fg: { r: number; g: number; b: number; a: number }, bg: { r: number; g: number; b: number; a: number }): { r: number; g: number; b: number; a: number }
  schattenFarben(s: string): { r: number; g: number; b: number; a: number }[]
}
