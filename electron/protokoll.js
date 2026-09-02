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
/**
 * Bis zu `.3` beiseitelegen — vier Generationen à `MAX` ⇒ max 8 MB auf der Platte (#371).
 *
 * **Diese Zusage stimmte bis #436 nicht.** `rotieren` prueft die Groesse VOR dem Anhaengen:
 * eine Datei knapp unter `MAX` bestand die Pruefung, und die naechste Zeile kam in voller
 * Laenge obendrauf — jede Generation konnte `MAX + Zeilenlaenge` gross werden. Gemessen an
 * zwoelf `window.open`-Aufrufen mit je einer 2-MB-URL (#426): **15,26 MB statt der zugesagten
 * 8**. Seitdem bekommt `rotieren` die Laenge der Zeile mit, die gleich angehaengt wird, und
 * rotiert, BEVOR sie den Deckel sprengt.
 *
 * **Der eine Rest, benannt statt verschwiegen:** eine EINZELNE Zeile groesser als `MAX` passt
 * in keine Generation und steht dann allein in ihrer eigenen. Die Grenze ist also genau
 * `4 × max(MAX, laengste geschriebene Zeile)`. Der laengste bekannte Erzeuger ist eine
 * `window.open`-URL mit Chromiums Obergrenze von 2 MB — also `MAX` selbst, und seit #426
 * ohnehin auf 200 Zeichen gedeckelt. Fuer jede heute geschriebene Zeile halten die 8 MB.
 */
const MAX_GENERATIONEN = 3

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

/**
 * Ueber MAX: bis zu MAX_GENERATIONEN rotieren (.3 <- .2 <- .1 <- .log).
 *
 * `zusatz` ist die Laenge der Zeile, die gleich angehaengt wird, und sie zaehlt MIT (#436) —
 * sonst rotiert erst die Datei, die den Deckel bereits gerissen hat. `groesse === 0` haelt
 * eine leere Datei zurueck: eine ueberlange erste Zeile legte sonst eine 0 Byte grosse
 * Generation `.1` an und schoebe damit eine echte aus dem Fenster.
 *
 * **Der Preis, gemessen und benannt statt verschwiegen:** eine Zeile groesser als `MAX` kostet
 * jetzt ZWEI Generationen statt einer — eine Rotation davor (sie passt nicht mehr dazu) und
 * eine beim naechsten Schreiben (sie hat den Deckel allein schon gerissen). Vorher wurde sie
 * einfach angehaengt und kostete nur die eine Rotation danach. Die `groesse === 0`-Wache nimmt
 * davon ausschliesslich die LEERE Datei aus; schon bei einem Byte wird die Generation
 * weggedreht. Bewusst nicht verallgemeinert: eine Schwelle „ab wann lohnt das Wegdrehen" waere
 * geraten, und einen Erzeuger fuer Zeilen ueber `MAX` gibt es heute nicht (200-Zeichen-Deckel
 * in `main.js`). Die Wache bleibt, weil sie einen echten, wenn auch seltenen Verlust
 * verhindert — sie deckt nur eben nicht den ganzen Fall ab, und genau das steht hier.
 *
 * **Im Normalbetrieb aendert sich dadurch nichts**, und das ist der Befund, der die Aenderung
 * traegt: bei 60 000 Zeilen à 200 Byte liegen alt 7 745 478 und neu 7 745 876 Byte auf der
 * Platte (gemessen gegen `880e2d7:electron/protokoll.js`). Erst bei Zeilen im MB-Bereich
 * faellt der Rueckhalt — bei zwoelf 2-MB-Zeilen von 16 777 208 auf 8 388 604 Byte. Das ist
 * genau der Sinn von #436 und zugleich sein Preis: die Obergrenze wird eingehalten, indem
 * weniger Spur aufbewahrt wird.
 */
function rotieren(datei, zusatz = 0) {
  try {
    const groesse = fs.statSync(datei).size
    if (groesse === 0 || groesse + zusatz <= MAX) return
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
    const text = `[${new Date().toISOString()}] ${maskiere(zeile)}\n`
    fs.mkdirSync(path.dirname(datei), { recursive: true })
    // BYTES, nicht Zeichen: geschrieben wird UTF-8, `.length` zaehlt UTF-16-Einheiten — ein
    // Umlaut waere um ein Byte zu klein gerechnet, ein Emoji um zwei (#436).
    rotieren(datei, Buffer.byteLength(text))
    fs.appendFileSync(datei, text)
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
