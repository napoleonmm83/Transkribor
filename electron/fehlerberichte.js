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
 * Die Integrationen, die laufen DUERFEN — eine Erlaubnisliste, keine Verbotsliste. Die erste
 * Fassung verbot Namen (`LocalVariables`, …) und liess damit `LocalVariablesAsync` durch: auf
 * Node >= 19 installiert das SDK die Async-Variante unter anderem Namen, und im gepackten
 * Envelope stand sie in `sdk.integrations` (gegnerisches Review). Eine Verbotsliste veraltet
 * mit jedem SDK-Update still; eine Erlaubnisliste laesst Neues erst durch, wenn jemand es
 * hier eintraegt. Gemessene Vorgabe-Liste des 7.18.0 im gepackten Lauf, minus die eine:
 *   ElectronContext, Context, AdditionalContext, GpuContext  Geraet, OS, App, GPU — kein Nutzertext
 *   OnUncaughtException, OnUnhandledRejection               der Zweck
 *   ChildProcess                                             Electrons eigene Kindprozesse (GPU, Utility)
 *   EventFilters, LinkedErrors, FunctionToString, ContextLines, NormalizePaths  Aufbereitung
 * Bewusst NICHT dabei: SentryMinidump (Bugsink kann keine Minidumps), MainProcessSession
 * (eine Sitzung je Start waere Tracking), PreloadInjection und RendererEventLoopBlock (Renderer
 * erst mit PR c), ElectronBreadcrumbs/ElectronNet/Console/NodeFetch (Breadcrumbs mit URLs),
 * LocalVariables UND LocalVariablesAsync (Variablenwerte tragen Text), Screenshots (das Fenster
 * zeigt Transkript). `fehlerberichte.test.js` prueft jeden erlaubten Namen gegen den
 * Paketquelltext und die beiden Variablen-Namen gegen die Liste.
 */
const ERLAUBT = Object.freeze([
  'ElectronContext', 'Context', 'AdditionalContext', 'GpuContext',
  'OnUncaughtException', 'OnUnhandledRejection', 'ChildProcess',
  'EventFilters', 'LinkedErrors', 'FunctionToString', 'ContextLines', 'NormalizePaths',
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

/**
 * Alle Punkt-Praefixe eines Dateinamens, nicht nur der bis zum ersten Punkt: `Dr. Mueller
 * Interview.m4a` traegt seinen Namen HINTER einem Punkt, `Interview 12.03.2026.m4a` mitten in
 * einer Zahl — der erste Punkt allein liess beide unmaskiert durch (Kalt-Review). Die
 * Laengste-zuerst-Sortierung in `namen()` ersetzt dann `Dr. Mueller Interview` vor `Dr`.
 */
function basen(name) {
  const aus = []
  for (let i = name.indexOf('.'); i > 0; i = name.indexOf('.', i + 1)) aus.push(name.slice(0, i))
  return aus.length ? aus : [name]
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
        for (const basis of basen(datei)) if (basis.length >= MIN_NAME) dateien.add(basis)
      }
    }
  }
  const laengsteZuerst = (a, b) => b.length - a.length || a.localeCompare(b)
  return { projekte: [...projekte].sort(laengsteZuerst), dateien: [...dateien].sort(laengsteZuerst) }
}

function regexFrei(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

/**
 * Ein Pfad kommt in vier Schreibweisen vor: wie notiert, mit `/` statt `\`, JSON-kodiert mit
 * `\\` (eine Meldung aus `JSON.stringify`) und URL-kodiert (`C:%5CUsers%5C…` in einer
 * Zugriffszeile). Windows-Pfade unterscheiden keine Gross-/Kleinschreibung, also `i` nur dort.
 */
function pfadMuster(p) {
  const vorwaerts = p.replace(/\\/g, '/')
  // URL-kodiert in beiden Lesarten: `encodeURIComponent` kodiert auch den Doppelpunkt (`C%3A`),
  // eine Zugriffszeile traegt ihn meist roh (`C:%5CUsers`).
  const kodiert = [p, vorwaerts].flatMap(f => [encodeURIComponent(f), encodeURIComponent(f).replace(/%3A/g, ':')])
  const formen = new Set([p, vorwaerts, p.replace(/\\/g, '\\\\'), ...kodiert])
  const flags = process.platform === 'win32' ? 'gi' : 'g'
  return new RegExp([...formen].map(regexFrei).join('|'), flags)
}

/**
 * Ein Name in allen Formen, in denen er in einer Meldung stehen kann: roh, NFC und NFD (macOS
 * legt Dateinamen zerlegt ab, eine Meldung aus dem Server kann sie zusammengesetzt tragen)
 * und jede davon URL-kodiert (Zugriffszeilen mit 4xx/5xx bleiben im Bericht).
 */
function namensFormen(name) {
  const roh = [name, name.normalize('NFC'), name.normalize('NFD')]
  return [...new Set([...roh, ...roh.map(encodeURIComponent)])]
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
  // Und jeder Name in BEIDEN Formen: in den uvicorn-Zeilen (4xx/5xx bleiben im Bericht) steht
  // er URL-kodiert — `Interview%20Mueller` traf die Rohform nicht (Kalt-Review).
  const n = ctx.namen || {}
  const brauchbar = liste => (liste || []).filter(name => typeof name === 'string' && name.length >= MIN_NAME)
  for (const name of brauchbar(n.dateien)) for (const f of namensFormen(name)) t = t.split(f).join('<datei>')
  for (const name of brauchbar(n.projekte)) for (const f of namensFormen(name)) t = t.split(f).join('<projekt>')
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
 * `maxValueLength` kuerzt im SDK nur `message`, `exception.values[].value` und `request.url`
 * (`extra` bleibt ungekuerzt) — 700 statt 250, damit eine Fehlermeldung in Laenge einer
 * Protokollzeile (`bericht.MAX_ZEILE`) ganz ankommt.
 * `ipcMode` kommt vom Hauptprozess (`Sentry.IPCMode.Classic`): die Vorgabe `Both` registriert
 * ein privilegiertes `sentry-ipc://`-Schema fuer die ganze Session; ohne Renderer-SDK (PR c)
 * braucht das niemand, also bleibt die Flaeche zu.
 */
function optionen({ dsn, version, gepackt, ctx, ipcMode }) {
  return {
    dsn: dsn || undefined,
    enabled: !!dsn,
    release: `transkribor@${version}`,
    environment: gepackt ? 'gepackt' : 'dev',
    sendDefaultPii: false,
    // Die Electron-SDK erzwingt das selbst (main/sdk.js, NACH dem userOptions-Spread) — der
    // Rechnername ist PII. Die Zeile hier haelt, falls die Vorgabe mit einem Upgrade kippt.
    includeServerName: false,
    maxValueLength: Math.max(bericht.MAX_ZEILE + 100, 700),
    beforeBreadcrumb: () => null,
    ...(ipcMode !== undefined ? { ipcMode } : {}),
    integrations: vorgaben => vorgaben.filter(i => ERLAUBT.includes(i.name)),
    beforeSend: beforeSend(ctx),
    // Der Transport ist ein OFFLINE-Transport mit Warteschlange auf Platte: ein Ereignis, das
    // bei AN ohne Netz erfasst wurde, ginge nach einem spaeteren AUS beim naechsten Start
    // trotzdem raus (Kalt-Review). Deshalb liest auch der Transport den Schalter — beim
    // Ablegen UND beim Senden; `shouldSend` allein liesse es in der Schlange kreisen.
    transportOptions: {
      shouldStore: () => lesen(wert(ctx.schalterPfad)).automatisch,
      shouldSend: () => lesen(wert(ctx.schalterPfad)).automatisch,
    },
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
  DATEI, ERLAUBT, MIN_NAME, FENSTER, FEHLERPROBE, INHALTSFELDER, pfad, lesen, schreiben, namen,
  namensFormen, maskiere, maskiereTief, ereignisMaskieren, protokollZeilen, beforeSend, optionen,
  fehlerprobeGewuenscht,
  _home: () => os.homedir(),
}
