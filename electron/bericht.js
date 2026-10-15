'use strict'
/**
 * Auswahl fuer Bugsink-Fehlerberichte. Der lokale Log bleibt vollstaendig; fuer einen
 * Bericht gehen hoechstens 60 relevante, je Zeile gekappte Eintraege in die Vorschau.
 */
const ZEILEN = 60
const MAX_ZEILE = 600
const KAPPMARKE = ' […]'
const AUSSORTIEREN = [
  /\bPATH\s*:/,
  / - "(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS) [^"]*" [23]\d\d/,
]
// Die Schlusszeile ZUERST und am Zeilenanfang (nach dem Zeitstempel) verankert: sie traegt die
// rohe Ziel-URL, und die darf den Text des Detailmusters enthalten (#520, Kalt-Review).
const ABWEISUNG = [
  /^(?:\[[^\]]*\] )?Weitere Abweisungen werden nicht mehr protokolliert/,
  / abgewiesen \([^)]*\): /,
]
const ABWEISUNGEN_IM_BERICHT = 1
const PFAD_AB_SCHEMA = /(^|[^A-Za-z0-9+.\-/\\])file:[\/\\]{1,3}.*/i
const PFAD_ERSATZ = '$1file:///… (Pfad entfernt)'

function kappen(zeile, max = MAX_ZEILE) {
  if (encodeURIComponent(zeile).length <= max) return zeile
  const budget = max - encodeURIComponent(KAPPMARKE).length
  const zeichen = Array.from(zeile)
  const passt = n => encodeURIComponent(zeichen.slice(0, n).join('')).length <= budget
  let lo = 0
  let hi = zeichen.length
  while (lo < hi) {
    const mitte = Math.ceil((lo + hi) / 2)
    if (passt(mitte)) lo = mitte
    else hi = mitte - 1
  }
  return zeichen.slice(0, lo).join('') + KAPPMARKE
}

function letzteZeilen(text, n = ZEILEN) {
  const alle = String(text || '').split(/\r?\n/)
    .filter(z => z.trim() !== '' && !AUSSORTIEREN.some(r => r.test(z)))
  const gewaehlt = []
  // Je Muster ein eigener Zaehler: seit #520 kann nach der Schlusszeile noch eine reservierte
  // Detailzeile kommen, und die wuerde sie sonst als juengste Abweisung aus dem Bericht verdraengen.
  const gezaehlt = ABWEISUNG.map(() => 0)
  for (let i = alle.length - 1; i >= 0 && gewaehlt.length < n; i--) {
    const k = ABWEISUNG.findIndex(r => r.test(alle[i]))
    if (k >= 0 && ++gezaehlt[k] > ABWEISUNGEN_IM_BERICHT) continue
    gewaehlt.push(alle[i])
  }
  return gewaehlt.reverse().map(z => z.replace(PFAD_AB_SCHEMA, PFAD_ERSATZ))
}

function kopf({ version, plattform, arch, electron, node, gepackt }) {
  return [
    `Transkribor : ${version}`,
    `Plattform   : ${plattform} ${arch}`,
    `Electron    : ${electron} | Node ${node}`,
    `Gepackt     : ${gepackt}`,
  ]
}

module.exports = {
  letzteZeilen, kopf, kappen, MAX_ZEILE, ZEILEN, AUSSORTIEREN,
  ABWEISUNG, ABWEISUNGEN_IM_BERICHT,
}