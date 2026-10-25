'use strict'
/**
 * Opt-in Nutzungszaehlung — wie viele Geraete Transkribor benutzen. Muster wie
 * `fehlerberichte.js`: die Entscheidungen als reine Funktionen, `main.js` bleibt eine Leitung.
 *
 * Drei Zusagen, jede hier statt in `main.js`:
 *   1. Ohne ausdrueckliches JA geht nichts raus. Fehlende oder kaputte Schalterdatei heisst AUS.
 *   2. Gesendet werden genau drei Felder (`nutzlast`), sonst nichts — der Test prueft die
 *      Schluesselliste erschoepfend, und die App zeigt dem Nutzer genau dieses Objekt.
 *   3. Die Rechnerkennung des Betriebssystems verlaesst diese Datei nie: gesendet wird nur
 *      sha256(SALZ + Kennung). Das Salz macht den Wert nur fuer Transkribor gueltig — mit der
 *      Kennung eines anderen Dienstes laesst er sich nicht verknuepfen.
 */
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const DATEI = 'nutzung.json'
const SALZ = 'transkribor-nutzung-v1:'
const URL_VORGABE = 'https://transcribor.martini.digital/v1/ping'
const FRIST_MS = 10_000

function pfad(datenDir) { return path.join(datenDir, DATEI) }

function zustandAus(d) {
  return {
    an: d.an === true,
    gefragt: typeof d.gefragt === 'string' && d.gefragt ? d.gefragt : null,
    zuletzt: typeof d.zuletzt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.zuletzt) ? d.zuletzt : null,
  }
}

/** Fehlend, kaputt oder fremd geformt: AUS und „nie gefragt" (BOM wie in fehlerberichte.lesen). */
function lesen(schalterPfad) {
  try { return zustandAus(JSON.parse(fs.readFileSync(schalterPfad, 'utf8').replace(/^﻿/, ''))) }
  catch { return zustandAus({}) }
}

/** tmp + rename — ein Absturz mittendrin hinterlaesst keine halbe Datei. */
function schreiben(schalterPfad, zustand) {
  const wert = zustandAus(zustand)
  fs.mkdirSync(path.dirname(schalterPfad), { recursive: true })
  const tmp = `${schalterPfad}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(wert, null, 2))
  fs.renameSync(tmp, schalterPfad)
  return wert
}

/** Die vom Betriebssystem vergebene Rechnerkennung, oder null. `aufruf` ist fuer den Test. */
function rechnerKennung(plattform = process.platform, aufruf = execFileSync, lies = fs.readFileSync) {
  try {
    if (plattform === 'win32') {
      const aus = aufruf('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
        { encoding: 'utf8', windowsHide: true, timeout: 5000 })
      return (aus.match(/MachineGuid\s+REG_SZ\s+(\S+)/) || [])[1] || null
    }
    if (plattform === 'darwin') {
      const aus = aufruf('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 5000 })
      return (aus.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/) || [])[1] || null
    }
    return lies('/etc/machine-id', 'utf8').trim() || null
  } catch { return null }
}

function fingerabdruck(kennung) {
  return crypto.createHash('sha256').update(SALZ + kennung).digest('hex')
}

/** Genau das, was gesendet wird — und genau das, was die App dem Nutzer zeigt. */
function nutzlast({ kennung, version, plattform, arch }) {
  if (!kennung) return null
  return { geraet: fingerabdruck(kennung), version: String(version), plattform: `${plattform}-${arch}` }
}

/** Lokaler Kalendertag, JJJJ-MM-TT. */
function tag(jetzt = new Date()) {
  const z = n => String(n).padStart(2, '0')
  return `${jetzt.getFullYear()}-${z(jetzt.getMonth() + 1)}-${z(jetzt.getDate())}`
}

function faellig(zustand, heute) { return zustand.an === true && zustand.zuletzt !== heute }

/**
 * Ein Tick: liest den Schalter, sendet hoechstens einmal je Kalendertag, merkt sich den Tag nur
 * nach einer 2xx-Antwort. Wirft nie — ein fehlender Server darf die App nicht stoeren.
 * Gibt zurueck, was passiert ist ('aus' | 'erledigt' | 'ohne-kennung' | 'gesendet' | 'fehler').
 */
async function tick({ schalterPfad, url, last, holen = fetch, jetzt = new Date() }) {
  const z = lesen(schalterPfad)
  const heute = tag(jetzt)
  if (z.an !== true) return 'aus'
  if (!faellig(z, heute)) return 'erledigt'
  // Eine Funktion wird erst hier gerufen: tick() selbst liest die Kennung nur, wenn gesendet wird.
  // (Die Versionsseite liest sie zur Anzeige ohnehin, ueber nutzung:status in main.js.)
  const l = typeof last === 'function' ? last() : last
  if (!l) return 'ohne-kennung'
  try {
    const antwort = await holen(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(l),
      signal: AbortSignal.timeout(FRIST_MS),
    })
    // 4xx (ausser 429) heisst: der Server nimmt DIESE Nutzlast nie an — bis morgen nicht wieder fragen.
    const abgelehnt = antwort.status >= 400 && antwort.status < 500 && antwort.status !== 429
    if (abgelehnt) { schreiben(schalterPfad, { ...lesen(schalterPfad), zuletzt: heute }); return 'abgelehnt' }
    if (!antwort.ok) return 'fehler'
    // Neu lesen: der Nutzer kann waehrend der Anfrage abgeschaltet haben.
    schreiben(schalterPfad, { ...lesen(schalterPfad), zuletzt: heute })
    return 'gesendet'
  } catch { return 'fehler' }
}

module.exports = { DATEI, SALZ, URL_VORGABE, pfad, lesen, schreiben, rechnerKennung, fingerabdruck, nutzlast, tag, faellig, tick }
