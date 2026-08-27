import type { FilePhase, FileState, FileWork, GlobalPhase, JobPhases } from './types'

export const PHASE_LABEL: Record<FilePhase, string> = {
  diarize: 'Diarisieren', correct: 'Korrigieren', verify: 'Verifizieren', transcribe: 'Transkribieren',
}
export const GLOBAL_LABEL: Record<GlobalPhase, string> = {
  diarize: 'Diarisieren…', prep: 'Vorbereiten…', glossary: 'Glossar wird erstellt…', download: 'Herunterladen…',
}
/** Fallback, solange ein Job noch keine auswertbare Zeile geschrieben hat (Prozessstart, Modell-Ladezeit). */
export const KIND_LABEL: Record<string, string> = {
  transcribe: 'Transkribieren…', correct: 'Korrigieren…', fetch: 'Herunterladen…',
}

// Der correct-Treiber arbeitet Dateien UND Bloecke parallel (correct.py: ThreadPoolExecutor,
// gedeckelt durch _claude_slots) -> mehrere gleichzeitig aktive Dateien, und die stdout-Zeilen
// verschraenken sich. `active` ist darum nach Basisnamen indiziert; jede Zeile traegt ihren
// Basisnamen, sonst liesse sie sich keinem Lauf zuordnen. transcribe bleibt sequentiell (eine GPU).
export function parseJobPhases(kind: string, lines: string[]): JobPhases {
  const perBase: Record<string, FileState> = {}
  const active: Record<string, FileWork> = {}
  // Blocknummern statt Zaehler: ein wiederverwendeter Block meldet '↷ schon vorhanden' UND
  // '✓ fertig' (correct.py faellt nach dem Reuse in dieselbe Pruefung) — ein ++ zaehlte ihn
  // doppelt und der Balken schoesse ueber 100%.
  const blocks: Record<string, { done: Set<number>; total: number }> = {}
  let global: GlobalPhase | null = null
  let cursor: string | null = null            // transcribe: die eine laufende Datei
  let bilanz: JobPhases['bilanz']
  let scope: Set<string> | undefined

  const terminal = (base: string, state: FileState) => {
    if (scope && !scope.has(base)) return
    perBase[base] = state
    delete active[base]
    delete blocks[base]
    if (cursor === base) cursor = null
  }
  // Fortschritt einer gestueckelten Datei = fertige Bloecke. Ein einzelnes 'Block 2/3' taugt
  // dafuer nicht mehr: bei parallelen Bloecken laufen 2 und 3 gleichzeitig.
  const prog = (base: string): Partial<FileWork> => {
    const b = blocks[base]
    if (!b) return {}
    const fertig = Math.min(b.done.size, b.total)
    return { pct: Math.round((fertig / b.total) * 100), detail: `${fertig}/${b.total} Blöcke` }
  }
  const blockDone = (base: string, nr: number) => { blocks[base]?.done.add(nr) }

  for (const rawLine of lines) {
    // NICHT `trim()`: die Leerzeichen am Zeilenende gehoeren zum Basisnamen. `safe_name('Interview ')`
    // laesst den Namen unveraendert, und getrimmt zerfaellt dieselbe Datei in zwei Schluessel —
    // "Interview" aus einer $-verankerten Zeile, "Interview " aus einer mittigen (gemessen).
    // Am Zeilenende ist sonst nichts abzuschneiden: `jobs.py` liest mit `text=True` (Universal
    // Newlines) und `rstrip("\n")` — ein `\r` erreicht diese Funktion nie, ein `[\r\n]+$`
    // waere ein Zweig, den kein Test rot bekommt (nachgemessen).
    // Vorne wird GENAU die Einrueckung abgeschnitten, die correct.py setzt: zwei Leerzeichen vor
    // den Blockzeilen ("  ✓ {base} · Block 1/4 fertig") und den Diagnosen. `/^\s+/` waere hier
    // zu gierig — bei einem Basisnamen mit FUEHRENDEM Leerzeichen (` Interview`, kommt durch
    // `safe_name`) frisst es dessen erstes Zeichen mit, und der Blockbalken faende seinen
    // Eintrag nicht mehr: die eingerueckte Bloecke-Zeile ergaebe "Interview", die nicht
    // eingerueckte `→ Korrigiere`-Zeile " Interview". Dieselbe Spaltung wie oben, andere Kante.
    const l = rawLine.replace(/^ {0,2}/, '')
    let m: RegExpMatchArray | null

    // Nur die ERSTE [scope]-Zeile zaehlt — dieselbe Regel wie im Backend (jobs.py: `bases is
    // None`). Ohne sie kippt ein Projekt namens "scope" den GANZEN Lauf: transcribe.py praefixt
    // jede Zeile mit dem Projektnamen (`[{name}] …`), jede davon wuerde hier als Bereichsmeldung
    // gelesen, und `terminal()` verwuerfe danach jeden echten Dateistatus (gemessen: perBase leer
    // statt {S1:'done'}). Spaetere [scope]-Zeilen fallen durch zu den Regexen unten und werden
    // dort korrekt als Projektzeilen gelesen — dieselbe Falle, die #396 fuer 'fetch' schloss.
    if (scope === undefined && l.startsWith('[scope]')) {
      const payload = l.slice(7).trim()
      scope = new Set(payload ? payload.split('\t').filter(Boolean) : [])
      continue
    }

    // 'fetch' ist der reine Download-Job (app.py: eigene Art, damit er keinen GPU-Slot belegt).
    // Er sendet nur '[fetch] …'-Zeilen. Den kombinierten CLI-Lauf (Download UND Transkription in
    // einem Strom) trug dieser Zweig frueher mit; seit "nur die erste [scope]-Zeile zaehlt" tut
    // er es nicht mehr — dort kaeme zuerst `fetch.py`s LEERE Bereichszeile, und ein leeres Set
    // liesse `terminal()` danach jeden Dateistatus der Transkription verwerfen. Kein Defekt:
    // `app.py` haengt an den Job immer `--download-only`, der kombinierte Lauf wird nie zum Job
    // (und `jobs.py` haette dieselbe Luecke). Benannt, damit es niemand als Zusage liest.
    if (kind === 'transcribe' || kind === 'fetch') {
      // MUSS vor den Regexen unten stehen: '[fetch] FEHLER <url>: …' wuerde sonst von
      // /^\[.+?\] FEHLER (.+?): / als Datei-Fehlschlag mit der URL als Basisnamen gelesen.
      // Aber: Heisst das Projekt 'fetch', sind '[fetch] -> transkribiere/fertig/skip/FEHLER <base>'
      // echte Transkriptionszeilen und keine Download-Zeilen (#379).
      if (l.startsWith('[fetch] ')) {
        if ((m = l.match(/^\[fetch\] (\d+) von (\d+) geladen$/))) {
          bilanz = { ok: +m[1], gesamt: +m[2] }
          global = null
          continue
        }
        if (l.match(/^\[fetch\] FEHLER https?:\/\//)) {
          global = 'download'
          continue
        }
        if (l.match(/^\[fetch\] lade /)) {
          cursor = null
          global = 'download'
          continue
        }
        if (kind === 'fetch') {
          cursor = null
          global = 'download'
          continue
        }
      }
      // Whispers tqdm-Balken (stderr, in jobs.py in stdout gemergt). Jedes \r-Refresh kommt
      // dank Universal-Newlines als eigene Zeile an -> einzige Prozentquelle der Transkription.
      // Whisper haengt UserWarnings OHNE Umbruch an, darum kein $-Anker.
      if ((m = l.match(/^(\d+)%\|/))) {
        if (cursor) active[cursor] = { ...active[cursor], pct: +m[1] }
        continue
      }
      if ((m = l.match(/^\[.+?\] -> transkribiere (.+) …$/))) {
        cursor = m[1]; active[cursor] = { phase: 'transcribe' }; global = null
      }
      else if ((m = l.match(/^\[.+?\] fertig (.+?): /))) terminal(m[1], 'done')
      else if ((m = l.match(/^\[.+?\] skip \(vorhanden\): (.+)$/))) terminal(m[1], 'skipped')
      // 'failed', nicht 'skipped': transcribe.py legt diese Datei in dieselbe `failed_bases`
      // wie den FEHLER-Pfad — sie wurde NICHT transkribiert. Ungelesen blieb sie bis Jobende
      // auf ihrem letzten Zustand stehen, obwohl der Lauf sie laengst aufgegeben hat.
      else if ((m = l.match(/^\[.+?\] skip \(Audio nicht mehr vorhanden\): (.+)$/))) terminal(m[1], 'failed')
      else if ((m = l.match(/^\[.+?\] FEHLER (.+?): /))) terminal(m[1], 'failed')
      continue
    }

    if (kind !== 'correct') continue

    // `(.+?)` + optionaler Zusatz: correct.py haengt seit #264 ` ({n} Sprecher)` an, das gierige
    // `(.+)` verschluckte ihn -> Schluessel "Timeline 13 (5 Sprecher)". Beide Verbraucher schlagen
    // mit dem EXAKTEN Basisnamen nach (ProjectWorkspace, Sidebar), die Phase war damit bei jeder
    // Datei mit gesetzter Sprecherzahl unsichtbar. Der Preis ist derselbe, den `→ Korrigiere`
    // fuer seinen Blockzusatz schon zahlt, und er ist gemessen: eine Aufnahme, die selbst
    // "Runde 2 (3 Sprecher)" heisst, wird OHNE gesetzte Sprecherzahl zu "Runde 2" gekuerzt.
    // Vorher war dieser Fall richtig — getragen, weil der Name absurd und der Normalfall haeufig ist.
    if ((m = l.match(/^→ Diarisiere (.+?)(?: \(\d+ Sprecher\))? …$/))) { active[m[1]] = { phase: 'diarize' }; global = 'diarize' }
    // `[done] {base}` folgt auf JEDEN Ausgang der Diarisierungsschleife (Erfolg, "keine Sprecher",
    // Roh-JSON unlesbar, Ausnahme) und ist damit das einzige Terminal je Datei; aufgeraeumt wurde
    // sonst erst am Phasen-Sweep unten (#379).
    // KEINE Wirkungsbehauptung dazu: die Sammelform „bis zu N-1 Spinner" stammt aus der Zeit der
    // Batch-Diarisierung. Beide lebenden Pfade rufen `cmd_diarize` heute je EINER Datei, die
    // Sweep-Zeile folgt eine Zeile spaeter — mehr als ein Spinner steht nur im CLI-Unterbefehl an,
    // und der wird nie zum Job. Der Zweig bleibt, weil er billig ist und die Zusage einloest.
    else if ((m = l.match(/^\[done\] (.+)$/))) { if (active[m[1]]?.phase === 'diarize') delete active[m[1]] }
    else if ((m = l.match(/^(.+?): \d+ Segmente → (\d+) Blöcke/))) blocks[m[1]] = { done: new Set(), total: +m[2] }
    // ✓ / ↷ / ✗ heissen alle "laeuft nicht mehr" — ob der Block geglueckt ist, sagt am Ende
    // der Terminal-Status der Datei, nicht der Balken.
    else if ((m = l.match(/^[✓✗↷] (.+?) · Block (\d+)\/\d+ (fertig|ohne|schon)/))) blockDone(m[1], +m[2])
    // `leicht`/`zusammenfassung` sind EIN LLM-Aufruf je Datei und tragen dieselbe Phase: fuer den
    // Nutzer ist es die Korrektur, nur ohne Glossar und Treue-Pass. Ohne sie blieb `global` in
    // einem Lauf ohne `voll*`-Datei ueber die gesamte LLM-Dauer auf 'Vorbereiten…' (#374).
    else if ((m = l.match(/^→ (?:Korrigiere|Leichte Korrektur|Nur Zusammenfassung) (.+?)(?: · Block \d+\/\d+)? …$/)))
      { active[m[1]] = { phase: 'correct', ...prog(m[1]) }; global = null }
    else if ((m = l.match(/^→ Verifiziere (.+?)(?: · Block \d+\/\d+)? \(Treue gegen Roh\) …$/)))
      { active[m[1]] = { phase: 'verify', ...prog(m[1]) }; global = null }
    else if ((m = l.match(/^apply: (.+) -> edit\.json/))) terminal(m[1], 'done')
    // Alle DREI Begruendungen, die correct.py druckt — nicht nur `human_edited=`. Die beiden
    // anderen sind die Schutzpfade ("edit.json nicht lesbar" aus #190, "waehrend des Laufs
    // handbearbeitet" aus #278): beide heissen "deine Fassung bleibt stehen", und beide liessen
    // die Datei bis Jobende auf einem Spinner stehen.
    // Die dritte Alternative ist ein RUECKVERWEIS, kein `.+?`, und das ist der Unterschied
    // zwischen Anker und Leerlauf: correct.py druckt dort `{base}.edit.json` (os.path.basename
    // von epath), der Basisname steht also ein zweites Mal in der Zeile. Mit `.+?` lief das
    // greedy `(.+)` bei jedem Namen, der " (" enthaelt, ueber sein Ende hinaus — gemessen an
    // `Interview (Teil 1)`: Schluessel "Interview (Teil 1) (Interview" UND der Spinner blieb
    // stehen, also genau der Zustand, den dieser Zweig beheben soll.
    else if ((m = l.match(/^apply: SKIP (.+) \((?:human_edited=|waehrend des Laufs |\1\.edit\.json nicht lesbar: )/)))
      terminal(m[1], 'skipped')
    else if ((m = l.match(/^↷ SKIP (.+) \(human_edited=/))) terminal(m[1], 'skipped')
    // Der Zwilling MUSS vor der Zeile darunter stehen. Er ist der spezifischere Ausdruck
    // (voller Grundtext, $-verankert); andersherum riesse die kuerzere Regex einen Basisnamen
    // auseinander, der selbst auf `.correction` endet.
    // Der Anker ist der feste SCHLUSSTEXT, nicht die Gier. Ein Rueckverweis wie beim
    // `apply: SKIP`-Zweig geht hier nicht — der Basisname steht nur EINMAL in der Zeile.
    // `\.json - Roh-Transkript nicht gefunden` laesst genau eine Zerlegung zu; damit ueberlebt
    // auch ein Basisname, der selbst auf `.json` endet (`daten.json` -> "daten.json", nicht
    // "daten"). Genau diese Falle war der Grund, den Zweig in #407 zu parken.
    // **`(.+)` und `$` sind daneben REDUNDANT, und das ist gemessen:** gierig und faul liefern
    // auf 11 Handfaellen und 400 000 Zufallseingaben dasselbe — `(.+?)` waere ein AEQUIVALENTER
    // Mutant, kein Defekt. Erst wenn BEIDE Anker fallen, bricht etwas, und nur bei einem
    // Basisnamen, der den Schlusstext selbst enthaelt. Beide bleiben stehen, weil sie nichts
    // kosten; dass kein Test sie rot bekommt, steht hier, damit es niemand fuer eine Luecke
    // haelt. (Die erste Fassung dieses Kommentars schrieb das Ueberleben der GIER zu — falsch,
    // und in einem PR, dessen Thema genau diese Fehlerklasse ist.)
    else if ((m = l.match(/^apply: FEHLT (.+)\.json - Roh-Transkript nicht gefunden$/))) terminal(m[1], 'failed')
    else if ((m = l.match(/^apply: FEHLT (.+?)\.correction\.json/))) terminal(m[1], 'failed')
    else if ((m = l.match(/^✗ FEHLT\/ungültig: (.+?)\.correction\.json/))) terminal(m[1], 'failed')
    else if ((m = l.match(/^✗ Fehler bei (.+?): /))) terminal(m[1], 'failed')
    else if (/^diarize: \d+ Datei/.test(l)) {
      for (const [b, a] of Object.entries(active)) if (a.phase === 'diarize') delete active[b]
      if (global === 'diarize') global = null
    }
    else if (/^prep: \d+ Datei/.test(l)) { global = 'prep' }
    else if (/^(→ Glossar|✓ Glossar|↷ nutze vorhandenes _glossar)/.test(l)) { global = 'glossary' }
    // reuse / diarize-SKIP / prep-SKIP / "Diarisierung deaktiviert" -> bewusst ignoriert
  }

  return { global: Object.keys(active).length ? null : global, scope, active, perBase, bilanz }
}

/** Einzeiler fuer Toast & Co. — nie rohe Log-Zeilen anzeigen, die sind fuer den Parser, nicht fuer Menschen. */
export function describePhases(p: JobPhases): string {
  const laufende = Object.entries(p.active)
  if (!laufende.length) return p.global ? GLOBAL_LABEL[p.global] : ''
  return laufende
    .map(([base, a]) => {
      const wie = a.detail ?? (a.pct != null ? `${a.pct}%` : null)
      return `${PHASE_LABEL[a.phase]} ${base}${wie ? ` · ${wie}` : '…'}`
    })
    .join('  |  ')
}
