'use strict'
/**
 * Opt-in Fehlerberichte an Bugsink (#530, PR a) — die Entscheidungen als reine Funktionen,
 * damit sie einen Test ohne laufendes Electron haben (Muster wie `bericht.js`).
 *
 * Drei Zusagen, jede hier statt im SDK:
 *   1. Der Schalter ist eine Datei in `userData` und wird JE EREIGNIS gelesen (`beforeSend`) —
 *      AUS wirkt sofort, ohne Neustart, und eine fehlende oder kaputte Datei heisst AUS
 *      (dieselbe Rueckfallrichtung wie bei jeder Schutzflagge dieses Repos).
 *   2. Was mitgeht, ist maskiert: Schluessel (wie `protokoll.maskiere`), Benutzerpfade
 *      (`<home>`, `<daten>`, `<projekte>`) und die Namen von Projekten und Aufnahmen
 *      (`<projekt>`, `<datei>` — die Endung bleibt). Die Namensliste wird zum Sendezeitpunkt
 *      aus dem Projekte-Ordner gelesen: deterministisch, keine Regex-Vermutung.
 *   3. Keine Breadcrumbs, keine Sitzungen, keine Minidumps, keine Screenshots, keine lokalen
 *      Variablen — nur die Ausnahme selbst, der Kontext der Maschine und die letzten
 *      Protokollzeilen (gefiltert wie beim Mail-Bericht, `bericht.letzteZeilen`).
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const bericht = require('./bericht')
const protokoll = require('./protokoll')

const DATEI = 'fehlerberichte.json'

/**
 * Integrationen, die das SDK per Vorgabe mitbringt und die hier NICHT laufen. Die Namen sind
 * die des installierten 7.18.0 (`main/sdk.js`), nicht die der Doku — `fehlerberichte.test.js`
 * prueft jeden gegen den Quelltext im Paket, sonst waere ein Filter auf einen umbenannten
 * Namen still ein No-op.
 *   SentryMinidump          native Abstuerze — Bugsink kennt keine Minidumps
 *   MainProcessSession      eine Sitzung je Start — Telemetrie ohne Fehler waere Tracking
 *   PreloadInjection        Renderer-Anbindung — kommt erst mit PR (c)
 *   ElectronBreadcrumbs, ElectronNet, Console, NodeFetch — Breadcrumbs (URLs tragen Projektnamen)
 *   LocalVariables          lokale Variablen in Frames — tragen Dateinamen und Text
 *   Screenshots             das Fenster zeigt Transkripttext
 *   RendererEventLoopBlock  Renderer-Haenger — erst mit PR (c)
 */
const RAUS = Object.freeze([
  'SentryMinidump', 'MainProcessSession', 'PreloadInjection', 'ElectronBreadcrumbs',
  'ElectronNet', 'Console', 'NodeFetch', 'LocalVariables', 'Screenshots',
  'RendererEventLoopBlock',
])

/** Namen kuerzer als das werden nicht maskiert — `ab` in jedem Wort zu ersetzen hilft niemandem. */
const MIN_NAME = 3

function pfad(datenDir) { return path.join(datenDir, DATEI) }

/**
 * Fehlend, kaputt oder fremd geformt: AUS und „nie gefragt". Ein fuehrendes BOM wird
 * abgestreift — Notepad und PowerShells `Set-Content -Encoding utf8` schreiben eines, und
 * `JSON.parse` wirft daran; gemessen im gepackten Lauf: Schalter AN in der Datei, gelesen AUS,
 * kein Envelope.
 */
function lesen(schalterPfad) {
  try {
    const d = JSON.parse(fs.readFileSync(schalterPfad, 'utf8').replace(/^﻿/, ''))
    return {
      automatisch: d.automatisch === true,
      gefragt: typeof d.gefragt === 'string' && d.gefragt ? d.gefragt : null,
    }
  } catch {
    return { automatisch: false, gefragt: null }
  }
}

/** tmp + rename, damit ein Absturz mittendrin keine halbe Datei hinterlaesst (= AUS, siehe `lesen`). */
function schreiben(schalterPfad, zustand) {
  const wert = {
    automatisch: zustand.automatisch === true,
    gefragt: typeof zustand.gefragt === 'string' && zustand.gefragt ? zustand.gefragt : null,
  }
  fs.mkdirSync(path.dirname(schalterPfad), { recursive: true })
  const tmp = `${schalterPfad}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(wert, null, 2))
  fs.renameSync(tmp, schalterPfad)
  return wert
}

function ohneEndung(name) {
  const i = name.indexOf('.')
  return i > 0 ? name.slice(0, i) : name
}

/**
 * Projektnamen und Basisnamen der Aufnahmen, wie sie auf der Platte stehen — laengste zuerst,
 * damit `Interview-Mueller` vor `Mueller` ersetzt wird und kein Rest stehen bleibt.
 * Ein fehlender oder unlesbarer Ordner liefert leere Listen, kein Wurf: die Maskierung
 * darf den Bericht nicht verhindern, nur entschaerfen.
 */
function namen(projekteDir) {
  const projekte = new Set()
  const dateien = new Set()
  let ordner = []
  try { ordner = fs.readdirSync(projekteDir, { withFileTypes: true }) } catch { return { projekte: [], dateien: [] } }
  for (const e of ordner) {
    if (!e.isDirectory()) continue
    if (e.name.length >= MIN_NAME) projekte.add(e.name)
    for (const unter of ['audio', 'transkripte']) {
      let eintraege = []
      try { eintraege = fs.readdirSync(path.join(projekteDir, e.name, unter)) } catch { continue }
      for (const datei of eintraege) {
        const basis = ohneEndung(datei)
        if (basis.length >= MIN_NAME) dateien.add(basis)
      }
    }
  }
  const laengsteZuerst = (a, b) => b.length - a.length || a.localeCompare(b)
  return { projekte: [...projekte].sort(laengsteZuerst), dateien: [...dateien].sort(laengsteZuerst) }
}

function regexFrei(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

/**
 * Ein Pfad kommt in drei Schreibweisen vor: wie notiert, mit `/` statt `\`, und
 * JSON-kodiert mit `\\` — eine Fehlermeldung aus einem `JSON.stringify` traegt die dritte.
 * Windows-Pfade unterscheiden keine Gross-/Kleinschreibung, also `i` nur dort.
 */
function pfadMuster(p) {
  const formen = new Set([p, p.replace(/\\/g, '/'), p.replace(/\\/g, '\\\\')])
  const flags = process.platform === 'win32' ? 'gi' : 'g'
  return new RegExp([...formen].map(regexFrei).join('|'), flags)
}

/**
 * Ein String durch alle Masken. `ctx`: { home, daten, projekte, namen: { projekte, dateien } } —
 * jedes Feld darf fehlen. Reihenfolge: Schluessel, dann die laengsten Pfade zuerst
 * (`projekte` liegt gepackt UNTER `daten`), dann Aufnahmen vor Projekten.
 */
function maskiere(text, ctx = {}) {
  if (typeof text !== 'string' || !text) return text
  let t = protokoll.maskiere(text)
  const pfade = [['projekte', '<projekte>'], ['daten', '<daten>'], ['home', '<home>']]
    .filter(([k]) => typeof ctx[k] === 'string' && ctx[k].length >= MIN_NAME)
    .sort((a, b) => ctx[b[0]].length - ctx[a[0]].length)
  for (const [k, ersatz] of pfade) t = t.replace(pfadMuster(ctx[k]), ersatz)
  // Die Laengengrenze gilt HIER, nicht nur beim Sammeln: die Liste kann von anderswo kommen.
  const n = ctx.namen || {}
  const brauchbar = liste => (liste || []).filter(name => typeof name === 'string' && name.length >= MIN_NAME)
  for (const name of brauchbar(n.dateien)) t = t.split(name).join('<datei>')
  for (const name of brauchbar(n.projekte)) t = t.split(name).join('<projekt>')
  return t
}

/**
 * Jeden String in einem Wert, wo er auch steckt. Zyklen werden erkannt und als `[Zyklus]`
 * abgebrochen: die erste Fassung lief endlos, weil das SDK dem Ereignis unter
 * `sdkProcessingMetadata` seine eigenen, zyklischen Objekte anhaengt — `beforeSend` warf
 * einen RangeError, das SDK verwarf das Ereignis still, und im gepackten Lauf kam nichts an.
 */
function maskiereTief(wert, ctx, gesehen = new WeakSet()) {
  if (typeof wert === 'string') return maskiere(wert, ctx)
  if (!wert || typeof wert !== 'object') return wert
  if (gesehen.has(wert)) return '[Zyklus]'
  gesehen.add(wert)
  if (Array.isArray(wert)) return wert.map(w => maskiereTief(w, ctx, gesehen))
  const aus = {}
  for (const [k, v] of Object.entries(wert)) aus[k] = maskiereTief(v, ctx, gesehen)
  return aus
}

/**
 * Die Felder des Ereignisses, die Inhalt tragen und maskiert werden. Alles andere —
 * `sdkProcessingMetadata`, `event_id`, `timestamp`, `platform`, `sdk` — bleibt, wie das SDK
 * es baute: es traegt keinen Nutzertext, und es gehoert dem SDK.
 */
const INHALTSFELDER = Object.freeze([
  'message', 'logentry', 'exception', 'extra', 'contexts', 'tags', 'breadcrumbs', 'request',
  'user', 'transaction', 'modules', 'fingerprint', 'threads', 'debug_meta',
])

/** Ein Ereignis mit maskiertem Inhalt — dieselben Objekte fuer alles, was kein Inhalt ist. */
function ereignisMaskieren(event, ctx) {
  const aus = { ...event }
  for (const feld of INHALTSFELDER) if (feld in aus) aus[feld] = maskiereTief(aus[feld], ctx)
  return aus
}

/** Dieselbe Auswahl wie im Mail-Bericht, dazu die Namensmaske und der Zeilendeckel. */
function protokollZeilen(text, ctx) {
  return bericht.letzteZeilen(text || '').map(z => bericht.kappen(maskiere(z, ctx)))
}

function wert(x) { return typeof x === 'function' ? x() : x }

/**
 * Der `beforeSend`-Riegel. `ctx.schalterPfad` und `ctx.protokollPfad` duerfen Funktionen sein
 * (der Hauptprozess kennt `userData` erst zur Laufzeit). Gibt `null` zurueck, wenn der Nutzer
 * nicht zugestimmt hat — das SDK verwirft das Ereignis dann, ohne dass ein Byte die Maschine
 * verlaesst.
 */
function beforeSend(ctx) {
  return event => {
    if (!lesen(wert(ctx.schalterPfad)).automatisch) return null
    let text = ''
    try { text = fs.readFileSync(wert(ctx.protokollPfad), 'utf8') } catch { /* ohne Protokoll: Ausnahme allein */ }
    const k = { ...ctx, namen: namen(wert(ctx.projekte)), projekte: wert(ctx.projekte) }
    const mitProtokoll = { ...event, extra: { ...(event.extra || {}), protokoll: protokollZeilen(text, k) } }
    return ereignisMaskieren(mitProtokoll, k)
  }
}

/**
 * Die SDK-Optionen. Ohne DSN ist das SDK aus (`enabled: false`) — so laeuft der
 * Entwicklerbetrieb und jeder Testbau ohne Secret, ohne dass irgendwo ein Zweig fehlt.
 * `maxValueLength` 700 statt 250, weil eine Protokollzeile bis 600 Zeichen lang ist
 * (`bericht.MAX_ZEILE`) und die Liste sonst still gekappt wuerde.
 */
function optionen({ dsn, version, gepackt, ctx }) {
  return {
    dsn: dsn || undefined,
    enabled: !!dsn,
    release: `transkribor@${version}`,
    environment: gepackt ? 'gepackt' : 'dev',
    sendDefaultPii: false,
    maxValueLength: Math.max(bericht.MAX_ZEILE + 100, 700),
    beforeBreadcrumb: () => null,
    integrations: vorgaben => vorgaben.filter(i => !RAUS.includes(i.name)),
    beforeSend: beforeSend(ctx),
  }
}

/** Was das Zustimmungsfenster sagt — an EINER Stelle, damit README und Fenster nicht driften. */
const FENSTER = Object.freeze({
  titel: 'Fehler automatisch melden?',
  frage: 'Darf Transkribor Fehler automatisch an uns senden?',
  details: [
    'Mitgeschickt werden: die Fehlermeldung mit Stelle im Programm, die Fassung, dein',
    'Betriebssystem und die letzten Protokollzeilen — Benutzername, Projekt- und',
    'Aufnahmenamen werden vorher unkenntlich gemacht.',
    '',
    'Nie mitgeschickt: Aufnahmen, Transkripte, Einstellungen, Schluessel.',
    '',
    'Du kannst das jederzeit unter „Version" umstellen.',
  ].join('\n'),
  ja: 'Ja, automatisch senden',
  nein: 'Nein',
})

/** Text der absichtlichen Ausnahme (`TRANSKRIBOR_FEHLERPROBE=1`) — daran erkennt man sie in Bugsink. */
const FEHLERPROBE = 'Fehlerprobe: absichtlich geworfen (TRANSKRIBOR_FEHLERPROBE=1)'

/** Nur der Wert `1` zaehlt — `true`, `ja` oder ein leerer Wert nicht; niemand wirft aus Versehen. */
function fehlerprobeGewuenscht(env) { return !!env && env.TRANSKRIBOR_FEHLERPROBE === '1' }

module.exports = {
  DATEI, RAUS, MIN_NAME, FENSTER, FEHLERPROBE, INHALTSFELDER, pfad, lesen, schreiben, namen,
  maskiere, maskiereTief, ereignisMaskieren, protokollZeilen, beforeSend, optionen,
  fehlerprobeGewuenscht,
  _home: () => os.homedir(),
}
