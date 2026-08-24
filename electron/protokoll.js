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
const MAX_GENERATIONEN = 3          // bis zu .3 beiseitelegen -> max 8 MB auf der Platte (#371)

const SENSIBLE_MUSTER = [
  /sk-[a-zA-Z0-9_-]{12,}/g,          // OpenAI / OpenRouter / generic API keys
  /sk-ant-[a-zA-Z0-9_-]{12,}/g,      // Anthropic API keys
  /AIzaSy[a-zA-Z0-9_-]{20,}/g,       // Google Gemini API keys
  /gsk_[a-zA-Z0-9_-]{20,}/g,         // Groq API keys
  /hf_[a-zA-Z0-9_-]{20,}/g,          // Hugging Face Tokens
]

function pfad() {
  return path.join(P.daten, 'transkribor.log')
}

/** Maskiert API-Keys und Token fuer sichere Fehlerberichte (#371). */
function maskiere(zeile) {
  if (typeof zeile !== 'string') return zeile
  let ergebnis = zeile
  for (const muster of SENSIBLE_MUSTER) {
    ergebnis = ergebnis.replace(muster, '***[API-KEY]***')
  }
  return ergebnis
}

/** Ueber MAX: bis zu MAX_GENERATIONEN rotieren (.3 <- .2 <- .1 <- .log). */
function rotieren(datei) {
  try {
    if (fs.statSync(datei).size <= MAX) return
    for (let i = MAX_GENERATIONEN - 1; i >= 1; i--) {
      const alt = `${datei}.${i}`
      const neu = `${datei}.${i + 1}`
      try {
        if (fs.existsSync(alt)) {
          if (i === MAX_GENERATIONEN - 1 && fs.existsSync(neu)) {
            try { fs.unlinkSync(neu) } catch {}
          }
          fs.renameSync(alt, neu)
        }
      } catch {}
    }
    fs.renameSync(datei, `${datei}.1`)
  } catch { /* Datei gibt es noch nicht — der Normalfall beim ersten Start */ }
}

function schreiben(zeile) {
  const datei = pfad()
  try {
    fs.mkdirSync(path.dirname(datei), { recursive: true })
    rotieren(datei)
    fs.appendFileSync(datei, `[${new Date().toISOString()}] ${maskiere(zeile)}\n`)
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

module.exports = { pfad, schreiben, kopf, befund, maskiere, MAX, MAX_GENERATIONEN }
