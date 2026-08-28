'use strict'
// Die drei Zahlen, die `electron/bericht.js` im Kopfkommentar behauptet — hier nachfahrbar.
//
// Aufruf aus dem Repo-Stamm:
//     node docs/superpowers/specs/2026-08-28-bericht-kappe-messung/monotonie.js
//
// WARUM VERSIONIERT: eine Zahl in einem Kommentar ist eine Behauptung, solange niemand sie
// nachrechnen kann — die haeufigste Fehlerklasse dieses Repos. Und sie veraltet still: der
// Kommentar trug bis 2026-08-28 „75-mal mehr Zeilen", waehrend der Code laengst 68 lieferte
// (die Zahl aenderte sich, als der Doppelpunkt aus `PFAD_AB_SCHEMA` fiel). Gefunden hat das
// erst dieses Skript. Wer die Kappung, die Maskierung oder die Pfad-Ersetzung anfasst, laesst
// es laufen und zieht die Zahlen im Kommentar nach.
//
// Vorbild: die will-navigate-Sonde daneben — Skript und Rohausgabe zusammen abgelegt.
const path = require('node:path')

const STAMM = path.resolve(__dirname, '..', '..', '..', '..')
const b = require(path.join(STAMM, 'electron', 'bericht.js'))
const K = b.kopf({ version: '0.48.1', plattform: 'win32', arch: 'x64',
                   electron: '43', node: '22', gepackt: true })

// --- 1) Was kostet die Kappung im Normalfall? -------------------------------------------
const normal = Array.from({ length: 60 }, (_, i) => `[t] Zeile ${i}: ` + 'x'.repeat(60 + (i % 30)))
const mittel = Math.round(normal.reduce((a, z) => a + z.length, 0) / normal.length)
const lauf = n => {
  for (let i = 0; i < n; i++) {
    b.mailto({ empfaenger: 'a@b.c', betreff: 'x', kopf: K, zeilen: normal, logpfad: 'C:/log.txt' })
  }
}
lauf(200)                                    // aufwaermen, sonst misst man den JIT
const t = process.hrtime.bigint()
lauf(2000)
const jeAufruf = Number(process.hrtime.bigint() - t) / 2000 / 1e6
console.log(`  1) Normalfall: 60 Zeilen, Mittel ${mittel} Zeichen -> ${jeAufruf.toFixed(4)} ms je Aufruf`)

// --- 2) Macht die Kappung den Bericht je SCHLECHTER als die Vorfassung? ------------------
// Die Vorfassung ist hier nachgebaut: dieselbe Schleife, nur ohne `kappen`. Das ist der
// Punkt der Messung — „nie schlechter" ist eine Aussage ueber den VERGLEICH, nicht ueber
// die neue Fassung allein.
function ohneKappe(zeilen, logpfad) {
  const bauen = (v, g, mp = true) => [...K, '', 'Was ist passiert?', '', '',
    logpfad && mp
      ? `Protokolldatei (zum Anhaengen; aeltere Teile liegen als .1 bis .3 daneben):\n${logpfad}`
      : null,
    '', g ? `— letzte ${v.length} Protokollzeilen (gekuerzt) —` : '— Protokoll —', ...v]
    .filter(z => z !== null).join('\n')
  const url = r => 'mailto:a@b.c?subject=' + encodeURIComponent('x') + '&body=' + encodeURIComponent(r)
  const mp = !!logpfad && url(bauen([], true)).length <= b.MAX_URL
  let v = zeilen.slice()
  let f = url(bauen(v, false, mp))
  while (f.length > b.MAX_URL && v.length > 0) { v = v.slice(1); f = url(bauen(v, true, mp)) }
  return v.length
}
let mehr = 0, weniger = 0, gleich = 0
for (let n = 1; n <= 1200; n += 7) {
  const zeilen = Array.from({ length: 20 }, (_, i) => `[t] Z${i}: ` + 'y'.repeat(n))
  const neu = b.mailto({ empfaenger: 'a@b.c', betreff: 'x', kopf: K, zeilen, logpfad: 'C:/log.txt' }).verwendet
  const alt = ohneKappe(zeilen, 'C:/log.txt')
  if (neu > alt) mehr++
  else if (neu < alt) weniger++
  else gleich++
}
console.log(`  2) Monotonie ueber ${mehr + weniger + gleich} Fuelllaengen: `
  + `${mehr}x mehr Zeilen, ${weniger}x weniger, ${gleich}x gleich`)

// --- 3) Wie oft kodiert die binaere Suche eine krankhaft lange Zeile? --------------------
// #426 lieferte den Anlass: 2 MB in EINER Zeile. Linear waere das eine Kodierung je Zeichen.
const echt = global.encodeURIComponent
let n = 0
global.encodeURIComponent = s => { n++; return echt(s) }
b.mailto({ empfaenger: 'a@b.c', betreff: 'x', kopf: K, zeilen: ['z'.repeat(2 * 1024 * 1024)] })
global.encodeURIComponent = echt
console.log(`  3) encodeURIComponent-Aufrufe fuer EINE 2-MB-Zeile: ${n}  (log2(2^21) = 21 Halbierungen)`)
