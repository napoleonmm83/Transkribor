'use strict'
/**
 * Jede Log-Zeile zusaetzlich in eine Datei.
 *
 * Bisher lebte das Protokoll nur im Fenster: wer es schliesst — oder wessen App abstuerzt —
 * nimmt die einzige Fehlerspur mit. Auf einem fremden Rechner ist aber genau diese Spur das,
 * was man braucht, und "bei mir kam eine Fehlermeldung" ist keine.
 *
 * Protokollieren darf die App nie zum Absturz bringen: jeder Schreibfehler wird geschluckt.
 * Ein fehlendes Log ist ein Aergernis, ein Absturz beim Loggen waere ein Defekt.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const P = require('./paths')

const MAX = 2 * 1024 * 1024        // darueber wird rotiert — ein Log fuellt nie die Platte

function pfad() {
  return path.join(P.daten, 'transkribor.log')
}

/** Ueber MAX: die alte Datei als .1 beiseite legen. Genau eine Generation reicht. */
function rotieren(datei) {
  try {
    if (fs.statSync(datei).size > MAX) fs.renameSync(datei, datei + '.1')
  } catch { /* Datei gibt es noch nicht — der Normalfall beim ersten Start */ }
}

function schreiben(zeile) {
  const datei = pfad()
  try {
    fs.mkdirSync(path.dirname(datei), { recursive: true })
    rotieren(datei)
    fs.appendFileSync(datei, `[${new Date().toISOString()}] ${zeile}\n`)
  } catch { /* siehe Modulkopf */ }
}

/**
 * Der Kopf jedes Laufs: was man in einem Fehlerbericht ZUERST wissen will.
 *
 * PATH steht bewusst vollstaendig drin. Der teuerste Fehler dieses Projekts war, dass eine
 * aus dem Finder gestartete .app launchds PATH erbt und Homebrew darin fehlt — mit dieser
 * Zeile im Protokoll ist so etwas in Sekunden erkannt statt in Stunden.
 */
function kopf() {
  const z = [
    '',
    '='.repeat(72),
    `Transkribor startet — ${new Date().toISOString()}`,
    `Plattform : ${process.platform} ${process.arch} (${os.release()})`,
    `Electron  : ${process.versions.electron} | Node ${process.versions.node}`,
    `Gepackt   : ${P.istPaket}`,
    `venv      : ${P.venv}`,
    `Projekte  : ${P.projekte}`,
    `Daten     : ${P.daten}`,
    `PATH      : ${process.env.PATH || '(leer)'}`,
    '='.repeat(72),
  ]
  z.forEach(schreiben)
}

/** Ein Objekt lesbar ins Protokoll — fuer den Umgebungsbefund aus setup.status(). */
function befund(titel, obj) {
  schreiben(`${titel}:`)
  for (const [k, v] of Object.entries(obj || {})) {
    schreiben(`  ${k} = ${v === '' ? '(leer)' : v}`)
  }
}

module.exports = { pfad, schreiben, kopf, befund, MAX }
