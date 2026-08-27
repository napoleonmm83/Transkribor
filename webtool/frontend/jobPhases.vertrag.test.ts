import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseJobPhases } from './src/lib/jobPhases'

// ─────────────────────────────────────────────────────────────────────────────────────────
// Der Vertrag zwischen den gedruckten Statuszeilen der Laufskripte und ihrem Parser (#375).
//
// ~20 Regexe in jobPhases.ts spiegeln ~95 print()-Aufrufe in drei Python-Dateien, und nichts
// hielt die beiden Seiten zusammen: wer eine Druckzeile aendert oder eine neue einfuehrt,
// bekam keinen Fehler — die Datei blieb in der Oberflaeche einfach im falschen Zustand stehen.
// Vier solche Luecken hat eine Gegenueberstellung von Hand gefunden (#374), eine fuenfte diese
// Datei beim Bau (`skip (Audio nicht mehr vorhanden)`, seit dem gestaffelten Lauf die einzige
// skip-Form, die transcribe.py ueberhaupt noch druckt).
//
// Die Formen werden hier GEERNTET, nicht abgetippt. Das ist der Kern: handgetippte Fixtures
// bestaetigen genau die Annahme, die man beim Schreiben hatte — sie koennen nicht auffallen
// lassen, dass eine fuenfte Form existiert. Die Beispielzeilen sind von Hand geschrieben, aber
// an ihre geerntete Form gebunden (dritter Test unten): aendert sich der f-String, wird das
// Beispiel rot statt still falsch.
//
// WARUM DIESE DATEI IM FRONTEND-STAMM LIEGT und nicht unter `src/`: sie liest die
// Python-Quellen ueber `node:fs`, und `tsconfig.app.json` fuehrt bewusst `"types":
// ["vite/client"]` — App-Code soll keine node-APIs importieren koennen.
// Preis, benannt statt verschwiegen: diese Datei wird von `npm run build` NICHT typgeprueft.
// `rollbalken.test.ts` liegt zwar auch hier, ist aber KEIN Praezedenzfall, sondern der
// Gegenfall: es steht in `tsconfig.node.json`s `include` und wird typgeprueft — weil es
// nichts aus `src/` importiert. Diese Datei tut das (`parseJobPhases`), und sie dorthin
// aufzunehmen zoege `src/lib/jobPhases.ts` samt `./types` in das node-Projekt (TS2835,
// nachgemessen). Der Preis ist also echt, nur nicht aus dem Grund, der hier zuerst stand.
//
// ZWEI GRENZEN, die diese Datei NICHT deckt:
// (1) Sie geht nur in EINE Richtung — von der Druckseite zum Parser. Ein Regex-Zweig, dessen
//     Druckform verschwindet, faellt hier nicht auf (genau das ist `skip (vorhanden)` passiert,
//     entfernt in 10098e4). Die Gegenrichtung braeuchte eine Liste der Zweige, und die waere
//     wieder von Hand gepflegt.
// (2) Geerntet werden die DREI Laufskripte. In dieselben Job-Stroeme drucken auch
//     `ytdlp_update.py` (`[ytdlp] …`, ueber `fetch.py`), `sperre.py` (`[sperre] …`, ueber
//     `cmd_apply`) und die Pfad-/Einstellungsmodule. Keine ihrer heutigen Formen kollidiert mit
//     einem Parser-Regex (einzeln gegengeprueft) — aber der Waechter unten sagt "jede gedruckte
//     Form", und gemeint ist "jede aus QUELLEN".
// ─────────────────────────────────────────────────────────────────────────────────────────

const HIER = path.dirname(fileURLToPath(import.meta.url))
const WURZEL = path.resolve(HIER, '..', '..')
const QUELLEN = ['transcribe.py', 'webtool/correct.py', 'webtool/fetch.py']

/** Die erste Zeichenkette eines print(...) — f-String oder normal, so wie sie im Quelltext steht. */
function ersteZeichenkette(zeile: string): string | null {
  const i = zeile.indexOf('print(')
  if (i < 0) return null
  let j = i + 'print('.length
  while (j < zeile.length && (zeile[j] === ' ' || zeile[j] === 'f')) j++
  const q = zeile[j]
  if (q !== '"' && q !== "'") return null
  const raus: string[] = []
  for (j++; j < zeile.length; j++) {
    if (zeile[j] === '\\' && j + 1 < zeile.length) { raus.push(zeile.slice(j, j + 2)); j++; continue }
    if (zeile[j] === q) return raus.join('')
    raus.push(zeile[j])
  }
  return null
}

// Was `ersteZeichenkette` nicht lesen kann, bekommt DIESE Signatur — sie steht bewusst nicht im
// INVENTAR, der Gleichheitstest wird also rot. Ohne sie waere ein `print(meldung)` oder ein
// `print(` mit der Zeichenkette in der naechsten Zeile eine Form, die der Ernter still
// ueberspringt: Test gruen, Form unklassifiziert — genau das Loch, gegen das diese Datei gebaut
// ist. Die Form gibt es im Repo bereits (`webtool/whispercpp.py`: `lambda z: print(z, …)`), nur
// heute in keiner der QUELLEN. Preis, benannt: ein `print(` in einem Kommentar loest jetzt
// Fehlalarm aus — die umgekehrte Fehlbarkeit steckt ohnehin schon drin (ein `print("x")` in
// einem Kommentar WIRD geerntet).
const UNLESBAR = '<<print( ohne lesbare Zeichenkette>>'

/** Signatur = Literal mit allen Platzhaltern auf `{}` normalisiert -> stabil gegen Umbenennungen. */
function ernte(): Map<string, string[]> {
  const formen = new Map<string, string[]>()
  for (const datei of QUELLEN) {
    const zeilen = fs.readFileSync(path.join(WURZEL, datei), 'utf-8').split(/\r?\n/)
    zeilen.forEach((zeile, nr) => {
      const lit = ersteZeichenkette(zeile)
      if (lit === null) {
        if (zeile.includes('print(')) formen.set(UNLESBAR, [...(formen.get(UNLESBAR) ?? []), `${datei}:${nr + 1}`])
        return
      }
      const sig = lit.replace(/\{[^{}]*\}/g, '{}')
      formen.set(sig, [...(formen.get(sig) ?? []), `${datei}:${nr + 1}`])
    })
  }
  return formen
}

type Art = 'gelesen' | 'gelesen_anderswo' | 'ignoriert' | 'luecke'
type Eintrag = {
  art: Art
  /** Nur bei 'gelesen': eine konkrete Zeile, die im Parser etwas bewirken MUSS. */
  beispiel?: string
  kind?: string
  /** Erwarteter Basisname im Ergebnis. Ohne ihn genuegte dem Wirkungstest JEDE Aenderung —
   *  auch eine unter dem FALSCHEN Schluessel, und genau das war #374 Punkt 1. */
  basis?: string
  /** Zeilen davor/danach, ohne die die Wirkung nicht sichtbar waere (Blockfortschritt, Sweeps). */
  vor?: string[]
  nach?: string[]
  notiz?: string
}

// Klassifikation aller gedruckten Formen. Wer eine Zeile aendert oder hinzufuegt, traegt sie
// hier ein — und beantwortet damit die Frage, die bisher niemand gestellt hat: liest das jemand?
const INVENTAR: Record<string, Eintrag> = {
  // ── gelesen von parseJobPhases ────────────────────────────────────────────────────────
  '[scope] ': { art: 'gelesen', beispiel: '[scope] A\tB' },
  '[{}] -> transkribiere {} …': { art: 'gelesen', kind: 'transcribe', beispiel: '[Demo] -> transkribiere A …', basis: 'A' },
  '[{}] fertig {}: {}s, {} Segmente, ': {
    art: 'gelesen', kind: 'transcribe', beispiel: '[Demo] fertig A: 12s, 30 Segmente, 1.2x Echtzeit', basis: 'A',
  },
  '[{}] FEHLER {}: {}': { art: 'gelesen', kind: 'transcribe', beispiel: '[Demo] FEHLER A: kaputt', basis: 'A' },
  '[{}] skip (Audio nicht mehr vorhanden): {}': {
    art: 'gelesen', kind: 'transcribe', beispiel: '[Demo] skip (Audio nicht mehr vorhanden): A', basis: 'A',
    notiz: 'seit 10098e4 die einzige skip-Form; transcribe.py zaehlt sie in failed_bases -> failed',
  },
  '[fetch] {} von {} geladen': { art: 'gelesen', kind: 'fetch', beispiel: '[fetch] 2 von 3 geladen' },
  '[fetch] lade {} …': { art: 'gelesen', kind: 'fetch', beispiel: '[fetch] lade Video …' },
  '[fetch] FEHLER {}: {}': { art: 'gelesen', kind: 'fetch', beispiel: '[fetch] FEHLER https://x/y: tot' },
  '[fetch] fertig {}': { art: 'gelesen', kind: 'fetch', beispiel: '[fetch] fertig Video' },
  '[fetch] roh ({}, extraktor-verdacht=': {
    art: 'gelesen', kind: 'fetch', beispiel: '[fetch] roh (DownloadError, extraktor-verdacht=True)',
  },
  '[fetch] yt-dlp aktualisiert — versuche {} noch einmal': {
    art: 'gelesen', kind: 'fetch', beispiel: '[fetch] yt-dlp aktualisiert — versuche https://x noch einmal',
  },
  '[done] {}': {
    art: 'gelesen', beispiel: '[done] A', vor: ['→ Diarisiere A …'],
    notiz: 'einziges Terminal je Datei in der Diarisierungsphase; jobs.py liest es ausserdem',
  },
  '→ Diarisiere {}{} …': { art: 'gelesen', beispiel: '→ Diarisiere A (5 Sprecher) …', basis: 'A' },
  '→ Korrigiere {}{} …': { art: 'gelesen', beispiel: '→ Korrigiere A · Block 1/4 …', basis: 'A' },
  '→ Verifiziere {}{} (Treue gegen Roh) …': { art: 'gelesen', beispiel: '→ Verifiziere A (Treue gegen Roh) …', basis: 'A' },
  '→ Leichte Korrektur {} …': { art: 'gelesen', beispiel: '→ Leichte Korrektur A …', basis: 'A' },
  '→ Nur Zusammenfassung {} …': { art: 'gelesen', beispiel: '→ Nur Zusammenfassung A …', basis: 'A' },
  '→ Glossar (gemeinsame Namen/Begriffe) …': { art: 'gelesen', beispiel: '→ Glossar (gemeinsame Namen/Begriffe) …' },
  '✓ Glossar: {} Eigennamen, ': { art: 'gelesen', beispiel: '✓ Glossar: 4 Eigennamen, 2 Korrekturen' },
  '↷ nutze vorhandenes _glossar.json': { art: 'gelesen', beispiel: '↷ nutze vorhandenes _glossar.json' },
  '  {}: {} Segmente → {} Blöcke à max. {}': {
    art: 'gelesen', beispiel: '  A: 540 Segmente → 4 Blöcke à max. 150', basis: 'A',
    nach: ['→ Korrigiere A · Block 1/4 …'],
  },
  '  ✓ {}{} fertig': {
    art: 'gelesen', beispiel: '  ✓ A · Block 1/4 fertig', basis: 'A',
    vor: ['  A: 540 Segmente → 4 Blöcke à max. 150'], nach: ['→ Korrigiere A · Block 2/4 …'],
  },
  '  ✗ {}{} ohne gültiges Ergebnis': {
    art: 'gelesen', beispiel: '  ✗ A · Block 1/4 ohne gültiges Ergebnis', basis: 'A',
    vor: ['  A: 540 Segmente → 4 Blöcke à max. 150'], nach: ['→ Korrigiere A · Block 2/4 …'],
  },
  '  ↷ {}{} schon vorhanden': {
    art: 'gelesen', beispiel: '  ↷ A · Block 1/4 schon vorhanden', basis: 'A',
    vor: ['  A: 540 Segmente → 4 Blöcke à max. 150'], nach: ['→ Korrigiere A · Block 2/4 …'],
  },
  'apply: {} -> edit.json + md ({} Segmente)': { art: 'gelesen', beispiel: 'apply: A -> edit.json + md (12 Segmente)', basis: 'A' },
  'apply: SKIP {} (human_edited=true; --force zum Ueberschreiben)': {
    art: 'gelesen', beispiel: 'apply: SKIP A (human_edited=true; --force zum Ueberschreiben)', basis: 'A',
  },
  'apply: SKIP {} ({} nicht lesbar: ': {
    art: 'gelesen',
    beispiel: 'apply: SKIP A (A.edit.json nicht lesbar: JSONDecodeError: x; --force zum Ueberschreiben)', basis: 'A',
  },
  'apply: SKIP {} (waehrend des Laufs handbearbeitet; ': {
    art: 'gelesen', beispiel: 'apply: SKIP A (waehrend des Laufs handbearbeitet; --force zum Ueberschreiben)', basis: 'A',
  },
  'apply: FEHLT {}.correction.json - erst Korrektur-Workflow laufen lassen': {
    art: 'gelesen', beispiel: 'apply: FEHLT A.correction.json - erst Korrektur-Workflow laufen lassen', basis: 'A',
    notiz: 'im Job-Protokoll nur ueber ein TOCTOU-Fenster erreichbar (one() prueft _valid_correction '
      + 'vor cmd_apply); der Zweig bleibt, weil sein Wegfall dort einen Dauer-Spinner hinterliesse',
  },
  '↷ SKIP {} (human_edited=true; --force zum Neu-Korrigieren)': {
    art: 'gelesen', beispiel: '↷ SKIP A (human_edited=true; --force zum Neu-Korrigieren)', basis: 'A',
  },
  '✗ FEHLT/ungültig: {}.correction.json — überspringe': {
    art: 'gelesen', beispiel: '✗ FEHLT/ungültig: A.correction.json — überspringe', basis: 'A',
  },
  '✗ Fehler bei {}: {} — überspringe': { art: 'gelesen', beispiel: '✗ Fehler bei A: RuntimeError — überspringe', basis: 'A' },
  'diarize: {} Datei(en) diarisiert in {}s': {
    art: 'gelesen', beispiel: 'diarize: 2 Datei(en) diarisiert in 45s', vor: ['→ Diarisiere A …'],
  },
  'prep: {} Datei(en) getaggt in {}': { art: 'gelesen', beispiel: 'prep: 3 Datei(en) getaggt in /x' },

  // ── gelesen, aber von einem ANDEREN Verbraucher ───────────────────────────────────────
  '[active] {}': { art: 'gelesen_anderswo', notiz: 'jobs.py (Backend): welche Datei gerade geschrieben wird' },
  '  [diagnose] {}\\t{}\\t{}': { art: 'gelesen_anderswo', notiz: 'useJobAusgang.ts: Grund einer gescheiterten Korrektur' },

  'apply: FEHLT {}.json - Roh-Transkript nicht gefunden': {
    art: 'gelesen', beispiel: 'apply: FEHLT A.json - Roh-Transkript nicht gefunden', basis: 'A',
    notiz: 'Erreichbar nur ueber ein TOCTOU-Fenster — und ueber ein WEITES: correct_ai_single '
      + 'prueft die Roh-JSON beim Eintritt (correct.py:1009) und steigt aus, bevor [active] '
      + 'gedruckt wird; dazwischen liegt die ganze KI-Korrektur samt Treue-Pass, also Minuten. '
      + 'Ungelesen war das nicht bloss ein Spinner: cmd_apply liefert "missing", correct_ai_single '
      + 'verwirft den Rueckgabewert (correct.py:1041) und meldet True — ohne perBase-Eintrag faellt '
      + 'ausgang() auf {art:"erfolg"}, also ERFOLG ueber eine nie geschriebene edit.json',
  },

  // ── bewusst ignoriert: Umgebung, Messung, Diagnose — kein Datei-Ereignis ───────────────
  '  KI-Anbieter: {}': { art: 'ignoriert' },
  '  claude Timeout nach {}s': { art: 'ignoriert' },
  '  claude exit {}: {}': { art: 'ignoriert' },
  '  keine .raw.txt gefunden — überspringe Glossar': { art: 'ignoriert' },
  '  {}': { art: 'ignoriert' },
  '  {}  ({} Audio)': { art: 'ignoriert' },
  '  {}: {} Fenster, ': { art: 'ignoriert' },
  '  ⚠ {}: {} Segment(e) ohne Korrektur — bleiben auf Rohstand': { art: 'ignoriert' },
  '  ✓ {}: {} Blöcke zusammengeführt ({} Segmente)': { art: 'ignoriert' },
  '  ✗ {}: Block 1 gescheitert — die weiteren Blöcke braeuchten seine ': { art: 'ignoriert' },
  '  ✗ {}: {} von {} Blöcken fehlgeschlagen — Teil-Dateien ': { art: 'ignoriert' },
  'Projekt nicht gefunden: {}': { art: 'ignoriert' },
  'TRANSKRIBOR_PARALLEL={} ist nicht der wirksame Wert — ': { art: 'ignoriert' },
  'WARN: ffmpeg nicht gefunden. Installiere: winget install Gyan.FFmpeg': { art: 'ignoriert' },
  'WARN: ffmpeg nicht gefunden. Installiere: {}': { art: 'ignoriert' },
  '[{}] -> {}': { art: 'ignoriert' },
  '[{}] Autocorrect-Fehler bei {}: {}': {
    art: 'ignoriert', notiz: 'die Datei IST transkribiert — nur die angehaengte Korrektur scheiterte',
  },
  '[{}] Modell {}, {} Datei(en)': { art: 'ignoriert' },
  '[{}] Warte auf verbleibende KI-Korrekturen…': { art: 'ignoriert' },
  '[{}] device={} ({}){}': { art: 'ignoriert' },
  '[{}] engine=whisper.cpp (Metal)': { art: 'ignoriert' },
  '[{}] keine Audiodateien in {}': { art: 'ignoriert' },
  '[{}] nichts zu tun — {} Datei(en) bereits transkribiert': { art: 'ignoriert' },
  '[{}] ⚠ {}: {} Abschnitt(e) ohne Transkript ': { art: 'ignoriert' },
  'diarize: SKIP {} (Roh-JSON unlesbar: {})': { art: 'ignoriert' },
  'diarize: SKIP {} (kein Audio gefunden)': { art: 'ignoriert' },
  'diarize: SKIP {} (keine Sprecher erkannt)': { art: 'ignoriert' },
  'diarize: SKIP {} ({}: {}) — Korrektur ohne Cluster': { art: 'ignoriert' },
  'prep: SKIP {} ({}: {})': { art: 'ignoriert' },
  'run: FEHLER — 0 von {} versuchten Datei(en) korrigiert ': { art: 'ignoriert' },
  'run: fertig — {}/{} Datei(en) korrigiert': { art: 'ignoriert' },
  'run: keine Roh-Transkripte — erst transkribieren': { art: 'ignoriert' },
  'run: keine solche Datei: {}': { art: 'ignoriert' },
  'run: {} Datei(en) in Projekt {}': { art: 'ignoriert' },
  '↷ Diarisierung deaktiviert (TRANSKRIBOR_DIARIZE=0)': { art: 'ignoriert' },
  '↷ nutze vorhandene {}.correction.json': { art: 'ignoriert' },
  '↷ nutze vorhandene {}.diar.json': { art: 'ignoriert' },
  '⏱ Phasen: glossar {}s · pipeline {}s · ': { art: 'ignoriert' },
  '⏱ [{}]: {} Datei(en) transkribiert in {}s ': { art: 'ignoriert' },
  '⏱ {}: Diarisierung {}s': { art: 'ignoriert' },
  '⏱ {}{}: Korrektur {}s{}': { art: 'ignoriert' },
  '⚠ Glossar fehlt/ungültig — fahre ohne gemeinsames Glossar fort': { art: 'ignoriert' },
  '⚠ Verifikation ungültig — behalte unverifizierte {}.correction.json': { art: 'ignoriert' },
  '⚠ kontext.md nicht lesbar ({}: {}) — fahre ohne ': { art: 'ignoriert' },
  '⚠ {} nicht lesbar ({}: {}) — gilt ': { art: 'ignoriert' },
}

const fest = (w: unknown) => JSON.stringify(w, (_k, v) => (v instanceof Set ? [...v].sort() : v))

describe('Vertrag: gedruckte Statuszeilen <-> jobPhases.ts (#375)', () => {
  it('jede gedruckte Form ist klassifiziert — und keine klassifizierte ist verschwunden', () => {
    // Der eigentliche Waechter. Eine NEUE Druckzeile ist hier unbekannt und macht den Test rot;
    // wer sie eintraegt, muss dabei entscheiden, ob der Parser sie lesen soll. Eine GEAENDERTE
    // Zeile aendert ihre Signatur und wirkt wie eine neue. Eine ENTFERNTE faellt als
    // ueberzaehliger Inventareintrag auf.
    const geerntet = [...ernte().keys()].sort()
    expect(geerntet).toEqual(Object.keys(INVENTAR).sort())
  })

  it('jede als „gelesen" markierte Form bewirkt im Parser auch etwas', () => {
    // Ohne diesen Test waere „gelesen" eine Behauptung. Gemessen wird die einzige Frage, auf die
    // es ankommt: aendert die Zeile den geparsten Zustand? Genau das taten die vier Formen aus
    // #374 nicht — sie standen im Protokoll und liefen ins Leere.
    const tot: string[] = []
    for (const [sig, e] of Object.entries(INVENTAR)) {
      if (e.art !== 'gelesen') continue
      expect(e.beispiel, `Beispielzeile fehlt fuer ${sig}`).toBeTruthy()
      const kind = e.kind ?? 'correct'
      const mit = parseJobPhases(kind, [...(e.vor ?? []), e.beispiel!, ...(e.nach ?? [])])
      const ohne = parseJobPhases(kind, [...(e.vor ?? []), ...(e.nach ?? [])])
      if (fest(mit) === fest(ohne)) { tot.push(`${sig} (ohne Wirkung)`); continue }
      if (e.basis && ![...Object.keys(mit.active), ...Object.keys(mit.perBase)].includes(e.basis))
        tot.push(`${sig} (Wirkung, aber nicht unter '${e.basis}')`)
    }
    expect(tot).toEqual([])
  })

  it('jede Beispielzeile passt noch zu ihrer geernteten Form', () => {
    // Bindet die von Hand geschriebenen Beispiele an die geerntete Wahrheit: die festen Teile
    // der Signatur muessen der Reihe nach im Beispiel vorkommen. Ohne das koennte ein Beispiel
    // eine Form beschreiben, die es so nicht mehr gibt — und der Test darueber bliebe gruen,
    // waehrend er nichts mehr bewacht.
    const schief: string[] = []
    for (const [sig, e] of Object.entries(INVENTAR)) {
      if (!e.beispiel) continue
      let pos = 0
      for (const stueck of sig.split('{}')) {
        if (!stueck) continue
        const gefunden = e.beispiel.indexOf(stueck, pos)
        if (gefunden < 0) { schief.push(`${sig} -> ${e.beispiel}`); break }
        pos = gefunden + stueck.length
      }
    }
    expect(schief).toEqual([])
  })

  it('die geernteten Formen stammen aus allen drei Laufskripten', () => {
    // Negativkontrolle zur Ernte selbst: ein kaputter Pfad oder ein zu enger Parser liefert
    // eine leere oder halbe Menge, und die beiden Tests darueber waeren dann gruen, ohne je
    // etwas geprueft zu haben — dieselbe Falle wie ein Fixture, das nie geladen wird.
    const orte = [...ernte().values()].flat()
    for (const datei of QUELLEN) expect(orte.some((o) => o.startsWith(datei))).toBe(true)
    expect(orte.length).toBeGreaterThan(80)
  })
})
