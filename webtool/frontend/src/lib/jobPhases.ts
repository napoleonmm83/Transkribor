import type { Erreicht, FilePhase, FileState, FileWork, GlobalPhase, JobPhases, Warten } from './types'

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

/** Schwere der Endzustaende. Ein Fehlschlag darf NIE von etwas Harmlosem verdeckt werden;
 *  zwischen 'done' und 'skipped' gewinnt 'done', weil „in diesem Lauf gemacht" mehr aussagt
 *  als „es gab nichts zu tun".
 *
 *  STAND BIS #405 NUR IN `useActiveJob.tsx` und galt damit nur ZWISCHEN Jobs. Innerhalb eines
 *  Jobs gab es den Fall nicht: eine Aufnahme bekam genau ein Terminalurteil. Der gestaffelte
 *  Lauf ist die erste Stelle, an der sie zwei bekommt (Transkription, dann Korrektur) — und
 *  `terminal()` nahm schlicht das letzte. Jetzt ist die Regel hier zuhause und beide fragen
 *  dieselbe; zwei Orte mit derselben Regel driften auseinander. */
export const RANG: Record<FileState, number> = { failed: 3, done: 2, skipped: 1 }

// Der correct-Treiber arbeitet Dateien UND Bloecke parallel (correct.py: ThreadPoolExecutor,
// gedeckelt durch _claude_slots) -> mehrere gleichzeitig aktive Dateien, und die stdout-Zeilen
// verschraenken sich. `active` ist darum nach Basisnamen indiziert; jede Zeile traegt ihren
// Basisnamen, sonst liesse sie sich keinem Lauf zuordnen. transcribe bleibt sequentiell (eine GPU).
/** Liest die stdout-Zeilen EINES Laufs in den Anzeigezustand: welche Aufnahme wo steht
 *  (`perBase`/`active`), was der Lauf anfasst (`scope`/`gesehen`) und wie er ausging (`bilanz`). */
export function parseJobPhases(kind: string, lines: string[],
                               gesehenVomServer?: Iterable<string>,
                               entferntVomServer?: Iterable<string>): JobPhases {
  // `Object.create(null)` statt `{}` — und das ist kein Stil, sondern ein gemessener Absturz:
  // ein Basisname wie `constructor`, `toString` oder `valueOf` kommt durch `safe_name` und
  // findet in einem gewoehnlichen Objekt den PROTOTYP. `blocks['constructor']` ist dann eine
  // Funktion, also truthy, `prog()` liest `b.done.size` und wirft — der Wurf steigt aus
  // `parseJobPhases` bis in `JobProvider.tick()` auf, VOR dem naechsten `setTimeout`: das
  // Polling ALLER Jobs des Projekts steht danach still, die Live-Anzeige ist fuer den Rest des
  // Laufs tot. Gemessen: `TypeError: Cannot read properties of undefined (reading 'size')`.
  // Bei `perBase`/`warten` ist die Wirkung leiser und deshalb schlimmer — dort schluckt ein
  // `in` die Datei still als „hat schon ein Urteil".
  // Vorbestehend (der kalte Diff-Leser fand es an diesem PR), hier mitgenommen, weil dieselben
  // Zeilen angefasst wurden und die neue Karte die Angriffsflaeche sonst vergroessert haette.
  const perBase: Record<string, FileState> = Object.create(null)
  const active: Record<string, FileWork> = Object.create(null)
  // Blocknummern statt Zaehler: ein wiederverwendeter Block meldet '↷ schon vorhanden' UND
  // '✓ fertig' (correct.py faellt nach dem Reuse in dieselbe Pruefung) — ein ++ zaehlte ihn
  // doppelt und der Balken schoesse ueber 100%.
  const blocks: Record<string, { done: Set<number>; total: number }> = Object.create(null)
  let global: GlobalPhase | null = null
  // Eine LISTE, kein Set: die Reihenfolge IST die der Poolschlange (#442). Nie geraeumt —
  // wer heraus muss, faellt in `korrekturSchlange` durch die Filter, und die Historie bleibt
  // der Zaehlung erhalten.
  const eingereiht: string[] = []
  let cursor: string | null = null            // transcribe: die eine laufende Datei
  let bilanz: JobPhases['bilanz']
  let scope: Set<string> | undefined
  // Aufnahmen, die der Lauf nachweislich angefasst hat (aus `[active]`, siehe unten).
  // Waechst nur, wird nie geleert: der Lauf gibt eine Aufnahme per `[done]` wieder frei, aber
  // "gehoerte zum Lauf" bleibt danach wahr - und genau das ist hier die Frage.
  // Vorbelegt aus der Buchfuehrung des Servers, wo sie vorliegt (#475): er sieht jede
  // Zeile, BEVOR sie in den bei MAX_JOB_LINES gedeckelten Puffer wandert, und die
  // Verdraengung trifft die Mitte -- also genau die Anmeldung einer spaet hinzugekommenen
  // Aufnahme. Die Vorbelegung muss HIER stehen und nicht am Ergebnis: `terminal()` prueft
  // die Zulassung waehrend der Schleife und hat das Urteil laengst verworfen, wenn jemand
  // hinterher `phases.gesehen` setzt. Beim `scope`-Rueckweg in `useActiveJob` faellt das
  // nicht auf -- ein FEHLENDER Bereich filtert gar nicht --, hier ist der Bereich da.
  const gesehen = new Set<string>(gesehenVomServer)
  // Aufnahmen, die der Server als geloescht gebucht hat (`jobs.remove_base` -> `entfernt`,
  // #479/#489) — IDENTITAET statt ANWESENHEIT: ein Name, unter dem eine NEUE Datei liegt,
  // darf Urteile und Belege der alten nicht erben. Das Loeschen druckt keine Zeile, also
  // ist der Server der einzige Rueckweg dafuer; die Menge deckelt das Fenster zwischen
  // Loeschen und Reannoncement (andernfalls Minuten, bis der Lauf die Datei wieder
  // erreicht). Die REAKTIVIERUNG ist SERVERSEITIG: jobs.py raeumt die Base beim
  // EINTREFFEN der `[scope+]`-Marke aus der Menge — deckelfest, denn der Server sieht
  // jede Zeile, BEVOR sie in den gedeckelten Puffer wandert. Ein Lift HIER an der
  // Puffer-Marke ware ordnungsblind gewesen (Review W1): im zweiten Loeschzyklus hob die
  // alte Marke des ersten Reuploads die frisch gebuchte Unterdrueckung auf, und die
  // naechste Aufnahme erbte wieder ein Fremd-Urteil (am echten Parser gemessen).
  const ungueltig = new Set<string>(entferntVomServer ?? [])
  // Was ein Endurteil ueber die PLATTE beweist. Die Pille faellt bei `done` auf `ruhe(file)`
  // durch, und `file` kommt aus der ungepollten Dateiliste — im Moment des Urteils also aus
  // einem Schnappschuss, der aelter ist als die Zeile, die das Urteil erzeugt hat. Ohne diese
  // Untergrenze stand „Nur Audio — noch nicht transkribiert" ueber einer gerade fertigen
  // Aufnahme, bis der 4-s-Summenpoll zufaellig etwas nachlud (im Browser gemessen).
  const erreicht: Record<string, Erreicht> = Object.create(null)

  const terminal = (base: string, state: FileState, beleg?: Erreicht) => {
    // Geloescht und (noch) nicht re-angekuendigt: kein Urteil, kein Beleg — die Zeile
    // spricht von einer Datei, die es nicht mehr gibt. Steht VOR der Zulassung, denn
    // `gesehen` bleibt wahr (Historie) und wuerde das alte Urteil sonst durchlassen.
    // Geraeumt wird trotzdem wie im Zulassungsfilter darunter: die Datei laeuft nicht
    // mehr, ein stehenbleibender Spinner waere der #379-Zustand.
    // GETRAGENE GRENZE: `ausgang()` zaehlt eine so unterdrueckte Aufnahme weder als
    // misslungen noch als versucht — ein Lauf, dessen einzige Misslungene die geloeschte
    // war, meldet `erfolg` statt `teil`. Ehrlich: das Urteil gehoerte einer Datei, die es
    // nicht mehr gibt. GILT NICHT im Ghost-Pfad (was-erlaubt-Review, 2026-08-31): war die
    // geloeschte Aufnahme noch nicht verarbeitet, haelt der Initialdateien-Ghost sie in
    // `pending`, `_kennung` liefert None ≠ altes Tupel, und der Lauf druckt `[scope+] X`
    // AUCH OHNE neue Datei — der Server reaktiviert (discard), das folgende `skip (Audio
    // nicht mehr vorhanden)` bucht ganz normal 'failed' (Vorverhalten).
    if (ungueltig.has(base)) {
      delete active[base]
      delete blocks[base]
      if (cursor === base) cursor = null
      return
    }
    // `gesehen` ist die zweite Zulassung neben `scope` (#431): eine Aufnahme, die WAEHREND des
    // Laufs hochgeladen wird, steht nie im Bereich - der ist gedruckt, bevor die Schleife in
    // `transcribe_project` das erste Mal `find_audio` ruft. Verarbeitet wurde sie vollstaendig;
    // ohne diese Bedingung fiel JEDES ihrer Urteile weg: kein perBase-Eintrag, `active` nie
    // geraeumt, Spinner bis Jobende, in der Bilanz nicht vorhanden.
    if (scope && !scope.has(base) && !gesehen.has(base)) return
    // Ein SCHWAECHERES Urteil ueberschreibt kein staerkeres — dieselbe Rangfolge, die
    // `mergePhases` zwischen Jobs anwendet (#377). Innerhalb eines Jobs war das bis #405
    // gegenstandslos: jede Aufnahme bekam genau ein Terminalurteil. Der gestaffelte Lauf
    // gibt ihr zwei — erst die Transkription, dann die Korrektur —, und die zweite ist nicht
    // immer die schwerere: `apply: SKIP … (human_edited=true)` schuetzt die Handarbeit des
    // Nutzers und heisst 'skipped'. Ungefiltert stand eine gerade frisch transkribierte
    // Aufnahme danach auf „Uebersprungen", und weil `ausgang()` die uebersprungenen aus dem
    // NENNER zieht, meldete ein Lauf ueber zwei Aufnahmen „1 von 1 fehlgeschlagen" (an einem
    // echten Lauf gemessen). `done -> failed` bleibt erlaubt und ist der Normalfall dieses
    // Fixes: die Transkription gelang, die Korrektur nicht.
    // `active`/`blocks`/`cursor` werden IMMER geraeumt, auch wenn das Urteil nicht gilt —
    // die Datei laeuft nicht mehr, und ein stehenbleibender Spinner waere der #379-Zustand.
    // `>=` gegen `>` ist ein AEQUIVALENTER Mutant: `RANG` bildet jeden Zustand auf eine eigene
    // Zahl ab, gleicher Rang heisst also derselbe Zustand, und die Zuweisung waere ein No-op.
    // Steht hier, damit es niemand fuer eine Luecke haelt.
    // GEMESSEN (2026-08-30, der Kommentar sagte „nachgemessen" ohne Beleg): diese Zeile auf `>`
    // geaendert, `npx vitest run` ⇒ 826 von 826 gruen. Wer das Argument pruefen will, mutiert
    // genau diese Zeile; wer `RANG` um zwei Zustaende GLEICHEN Rangs erweitert, macht den
    // Mutanten damit nicht-aequivalent und braucht dann einen Test.
    if (!(base in perBase) || RANG[state] >= RANG[perBase[base]]) perBase[base] = state
    // Der Beleg folgt NICHT dem RANG: er sagt, was auf der Platte liegt, nicht wie der Lauf
    // ausging. Er folgt der ZEILENREIHENFOLGE — die spaetere Zeile ist der frischere Beweis.
    //
    // Hier stand zuerst „nur aufwaerts" (`erreicht[base] !== 'edit'`), begruendet mit „eine
    // geschriebene edit.json verschwindet nicht mehr". Das ist FALSCH, und der Fall, in dem es
    // falsch ist, ist genau der, den #485 ausdruecklich zulaesst: `delete_file` prueft
    // `active_only=True` und gibt eine Aufnahme nach ihrem `[done]` frei — wer sie loescht und
    // gleichnamig neu hochlaedt, bekommt spaeter im SELBEN Strom ein zweites `fertig X:`. Das
    // beweist ein frisches Roh-Transkript und widerlegt die alte edit.json; „nur aufwaerts"
    // liess das Urteil dagegen nicht mehr sinken — die Zeile haette bis Jobende „Fertig" ueber
    // einer Aufnahme behauptet, die nur Audio ist, OHNE Selbstheilung.
    //
    // Ein `raw` NACH einem `edit` gibt es im normalen Lauf nicht: `transcribe_project` fasst
    // nur Aufnahmen ohne `.json` an, `fertig X:` kommt also immer VOR `apply: X`. Die
    // umgekehrte Reihenfolge ist damit selbst schon das Signal „diese Datei ist eine andere".
    if (beleg) erreicht[base] = beleg
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
  // Der Balken zog frueher erst bei der NAECHSTEN `→ Korrigiere`-Zeile nach, weil `prog()` nur
  // beim Betreten einer Phase ausgewertet wurde (#347). Sichtbar blieb das beim LETZTEN Block:
  // dort folgt kein `→ Korrigiere` mehr, sondern `apply:`, das die Datei terminal macht — der
  // Balken stand also bis zum Schluss eine Stufe zu niedrig.
  //
  // `if (active[base])` ist tragend, nicht Kosmetik: `terminal()` raeumt `active` UND `blocks`,
  // eine nachlaufende Blockzeile darf den Eintrag nicht WIEDERBELEBEN — das waere der
  // #379-Zustand (Spinner bis Jobende) mit umgekehrtem Vorzeichen. Ohne den Riegel entstuende
  // dabei sogar ein Eintrag ohne `phase`, den `PHASE_LABEL[undefined]` nicht beschriften kann.
  const blockDone = (base: string, nr: number) => {
    blocks[base]?.done.add(nr)
    if (active[base]) active[base] = { ...active[base], ...prog(base) }
  }

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
      // Geschnitten wird GENAU das eine Trennleerzeichen hinter `[scope]`, nicht `trim()`.
      // `trim()` schnitt an den Enden der ganzen Nutzlast, also am ersten und am letzten
      // Basisnamen — ein Name mittendrin blieb heil, die Raender nicht. Und `safe_name` laesst
      // Randleerzeichen durch: `terminal()` filterte die Datei dann ueber `scope.has(base)`
      // weg, es entstand kein perBase-Eintrag und `active` wurde nicht geraeumt. Sie hing bis
      // Jobende auf dem Spinner UND fehlte in der Bilanz — derselbe #376-Zustand, gegen den
      // dieser Stand angetreten ist, nur eine Zeile hoeher als der Zeilenschnitt.
      // Ein Zeilenumbruch ist hier nicht abzuschneiden: `jobs.py` liest mit Universal Newlines
      // und `rstrip("\n")` (dieselbe Begruendung wie beim Zeilenschnitt).
      const roh = l.slice(7)
      const payload = roh.startsWith(' ') ? roh.slice(1) : roh
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
      // Whispers tqdm-Balken (stderr, in jobs.py am eigenen Faden gelesen — seit #481
      // getrennt von stdout, teilt sich keine Zeile mehr mit einer Marke). Jedes \r-Refresh
      // kommt dank Universal-Newlines als eigene Zeile an -> einzige Prozentquelle der
      // Transkription. Whisper haengt UserWarnings OHNE Umbruch an, darum kein $-Anker.
      // Getragene Grenze der Stromtrennung: die Zuordnung laeuft ueber `cursor`, und ein
      // stderr-Refresh, der vor seiner `-> transkribiere`-Zeile im Puffer landet, zaehlt
      // auf die VORHERIGE Datei — fluechtig, anzeigeseitig, ohne Buchungsfolge.
      if ((m = l.match(/^(\d+)%\|/))) {
        if (cursor) active[cursor] = { ...active[cursor], pct: +m[1] }
        continue
      }
      // `[^\]]+` statt `.+?` ist der Riegel gegen Zeilen-Injektion, nicht Kosmetik (#413).
      // `.+?` ist lazy und BACKTRACKT ueber die ganze Zeile bis zu einem spaeteren `]`: die
      // Zeile `[autocorrect] KI-Phase uebersprungen — kaputt] fertig D1: x` erfuellte damit
      // `^\[.+?\] fertig (.+?): ` und meldete D1 als FERTIG, obwohl sie es nicht ist. Das `^`
      // schuetzt hier nichts — das echte Praefix erfuellt den Anker selbst. `[^\]]+` kann das
      // erste `]` nicht ueberspringen, damit ist die Klasse fuer JEDE Zeile zu.
      //
      // Der Riegel gehoert hierher und nicht auf die Druckseite: 13 Druckstellen in
      // transcribe.py, ytdlp_update.py und sperre.py setzen fremden Ausnahmetext hinter ein
      // Klammerpraefix, und die letzten beiden erntet nicht einmal der Vertragstest (#409).
      // Ein Riegel je Drucker waere 13 Riegel, von denen der naechste neue fehlt.
      //
      // Der Preis ist ein GETRAGENER DEFEKT, kein gewollter Vertrag: `paths.safe_name`
      // laesst `]` durch (gemessen, `A]B` kommt unveraendert heraus), ein Projektname mit
      // Klammer verliert also die Live-Anzeige. Solange das so ist, sind ein solcher Name
      // und eine Injektion auf der Zeile NICHT unterscheidbar — die Behebung liegt beim
      // Producer. #416 ist seit dem Namensraum-Riegel (Anlegepfad) geschlossen: NEUE
      // Projekte mit Klammer gibt es nicht mehr, dieser Zweig bleibt der Vorbehalt fuer
      // Namen, die vor dem Riegel angelegt wurden. Bis dahin wiegt „keine Falschaussage"
      // schwerer.
      if ((m = l.match(/^\[[^\]]+\] -> transkribiere (.+) …$/))) {
        cursor = m[1]; active[cursor] = { phase: 'transcribe' }; global = null; continue
      }
      // Der Wurf aus der Vorbereitung, und NUR der mit stehendem KI-Pool: `transcribe.py`
      // druckt fuer den Fall ohne Anbieter eine eigene Form, weil die Korrektur dort
      // absichtlich ausfaellt — sie als Fehlschlag zu melden waere dieselbe Falschaussage
      // wie ein rotes Exitcode fuer eine geschuetzte `human_edited`-Datei (#417-Review).
      else if ((m = l.match(/^\[[^\]]+\] Autocorrect-Fehler bei (.+?): /))) {
        terminal(m[1], 'failed'); continue
      }
      // 'raw': die Zeile wird gedruckt, NACHDEM `<base>.json` geschrieben ist. Damit ist
      // „noch nicht transkribiert" ab hier beweisbar falsch, egal wie alt die Dateiliste ist.
      else if ((m = l.match(/^\[[^\]]+\] fertig (.+?): /))) { terminal(m[1], 'done', 'raw'); continue }
      // 'failed', nicht 'skipped': transcribe.py legt diese Datei in dieselbe `failed_bases`
      // wie den FEHLER-Pfad — sie wurde NICHT transkribiert. Ungelesen blieb sie bis Jobende
      // auf ihrem letzten Zustand stehen, obwohl der Lauf sie laengst aufgegeben hat.
      // Diese Zeile war zuerst gehaertet (sie kam mit dem Buendel neu dazu); ihre vier
      // Geschwister sind es seit #413 ebenfalls — die Klasse ist damit geschlossen.
      else if ((m = l.match(/^\[[^\]]+\] skip \(Audio nicht mehr vorhanden\): (.+)$/))) {
        terminal(m[1], 'failed'); continue
      }
      else if ((m = l.match(/^\[[^\]]+\] FEHLER (.+?): /))) { terminal(m[1], 'failed'); continue }
      // HIER endete der Zweig frueher mit einem unbedingten `continue` — und damit war der
      // correct-Dialekt fuer einen Transkriptions-Job unerreichbar. Seit v0.48.0 (10098e4)
      // laeuft die Korrektur INNERHALB dieses Jobs (gestaffelte Pipeline), also liefen
      // Diarisieren, Korrigieren, Verifizieren und Anwenden ohne jede Phasenanzeige — und
      // eine gescheiterte Korrektur meldete `done`, weil der Zustand aus der Transkription
      // stehenblieb. Am echten Lauf gemessen (#405).
    }

    // WELCHE Job-Arten den correct-Dialekt lesen, entscheidet GENAU DIESE Zeile.
    // `transcribe` faellt seit #405 hierher durch (die Korrektur laeuft in seinem Lauf),
    // `fetch` nicht: der Job faehrt immer `--download-only` (app.py) und hat keine
    // Korrekturphase. Das haelt zugleich die Begruendung des frueheren `continue` aufrecht —
    // er stand wegen `[fetch] FEHLER <url>: …` da (#379).
    //
    // Ein zweiter Riegel `if (kind === 'fetch') continue` stand kurz eine Zeile hoeher und
    // ist WIEDER RAUS: er war redundant, und die Mutationsprobe hat es gezeigt — entfernt
    // blieb jeder Test gruen, weil diese Zeile denselben Fall schon abfaengt. Ein Waechter,
    // den keine Mutation rot bekommt, sieht aus wie Schutz und ist keiner.
    if (kind !== 'correct' && kind !== 'transcribe') continue

    // `(.+?)` + optionaler Zusatz: correct.py haengt seit #264 ` ({n} Sprecher)` an, das gierige
    // `(.+)` verschluckte ihn -> Schluessel "Timeline 13 (5 Sprecher)". Beide Verbraucher schlagen
    // mit dem EXAKTEN Basisnamen nach (ProjectWorkspace, Sidebar), die Phase war damit bei jeder
    // Datei mit gesetzter Sprecherzahl unsichtbar. Der Preis ist derselbe, den `→ Korrigiere`
    // fuer seinen Blockzusatz schon zahlt, und er ist gemessen: eine Aufnahme, die selbst
    // "Runde 2 (3 Sprecher)" heisst, wird OHNE gesetzte Sprecherzahl zu "Runde 2" gekuerzt.
    // Vorher war dieser Fall richtig — getragen, weil der Name absurd und der Normalfall haeufig ist.
    // Aufgeloest wird die Zweideutigkeit an der BEREICHSZEILE, nicht an der Zeile selbst.
    // Aus der Zeile allein geht es nicht: `correct.py:298-300` haengt den Zusatz nur an, also
    // entsteht `→ Diarisiere Runde 2 (3 Sprecher) …` Byte fuer Byte gleich aus base="Runde 2"
    // mit Zahl 3 UND aus base="Runde 2 (3 Sprecher)" ohne Zahl. Der naheliegende Vorschlag
    // (Name und Zahl in getrennte Felder ziehen) scheitert genau daran — die Zahl steht nicht
    // getrennt IN der Zeile, sie ist von ihr nicht unterscheidbar.
    // `[scope]` fuehrt die ECHTEN Basisnamen (`correct.py:1072`, tab-getrennt) und steht vor
    // jeder Diarisiere-Zeile. Steht der VOLLE Text darin, ist er der Name; sonst gilt die
    // gekuerzte Form. Ohne Bereichszeile (`scope === undefined`) bleibt alles wie bisher —
    // dieselbe Rueckfallrichtung wie in `terminal()`.
    // Der Zweig heilt damit auch die Paarung mit `[done] {base}`: das druckt den ROHEN Namen,
    // traf den gekuerzten Schluessel also nicht und liess den Spinner stehen.
    // NICHT genommen, obwohl naeher dran: `correct.py:299` druckt eine Zeile vorher
    // `[active] {base}` mit dem rohen Namen, also eine eindeutige Quelle ganz ohne `[scope]`.
    // Sie wird aber auch in der KORREKTURphase gedruckt (`correct.py:1017`) — ihre Bedeutung
    // wechselt ueber den Lauf, und sie zu lesen hiesse, Zustand zwischen Zeilen mitzufuehren
    // und auf ihre Reihenfolge zu wetten. `scope` ist eine Menge und braucht beides nicht.
    // Ungemessen; wer sie doch nehmen will, misst zuerst.
    if ((m = l.match(/^→ Diarisiere ((.+?)(?: \(\d+ Sprecher\))?) …$/))) {
      // `!scope.has(m[2])` ist Pflicht, nicht Feinschliff — und es ist die Antwort auf „was
      // erlaubt die Rettung NEU?" (CodeRabbit-Bot am PR, hier mit einem roten Test bestaetigt).
      // Liegen `Runde 2` UND `Runde 2 (3 Sprecher)` im selben Projekt und ist fuer `Runde 2`
      // die Zahl 3 gesetzt, steht der volle Text wegen der FREMDEN Datei im Bereich: die Phase
      // landete unter dem falschen Namen, `[done] Runde 2` traf ihn nicht, und die echte Datei
      // zeigte gar keine Phase. Stehen BEIDE Lesarten im Bereich, ist die Zeile wirklich nicht
      // entscheidbar — dann gilt die gekuerzte Form: bisheriges Verhalten, und der haeufigere
      // der beiden Faelle.
      const base = scope?.has(m[1]) && !scope.has(m[2]) ? m[1] : m[2]
      active[base] = { phase: 'diarize' }; global = 'diarize'
    }
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
    // 'edit': `cmd_apply` druckt diese Zeile erst nach dem Schreiben der edit.json — das ist
    // der Fall aus Marcus' Meldung („fertig korrigiertes File wechselt erst auf Audio …").
    else if ((m = l.match(/^apply: (.+) -> edit\.json/))) terminal(m[1], 'done', 'edit')
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
    // 'edit' auch hier, und das ist eine KORREKTUR: hier stand „SKIP traegt nichts ein, denn
    // 'skipped' rendert ueber STATE[] und erreicht `ruhe()` nie". Das gilt nur fuer den reinen
    // `correct`-Job. Im gestaffelten Lauf hat dieselbe Aufnahme vorher `fertig X:` bekommen
    // ('done', RANG 2); das folgende 'skipped' (RANG 1) wird von der Rangregel oben
    // VERSCHLUCKT, der Zustand bleibt 'done' — und 'done' faellt sehr wohl auf `ruhe()` durch.
    // Es gab den Leser also, die alte Begruendung war falsch.
    //
    // Alle drei Gruende belegen eine edit.json: `human_edited=true` und die unlesbare Fassung
    // (#190) existieren VOR dem Lauf, „waehrend des Laufs handbearbeitet" (#278) ist gerade
    // vom Editor geschrieben worden — und genau der ist der Fall, den die Dateiliste noch
    // nicht kennt. `has_edit` im Backend ist reine Existenz, eine unlesbare Datei zaehlt dort
    // mit; 'edit' sagt damit dasselbe wie die Liste, nur frueher.
    else if ((m = l.match(/^apply: SKIP (.+) \((?:human_edited=|waehrend des Laufs |\1\.edit\.json nicht lesbar: )/)))
      terminal(m[1], 'skipped', 'edit')
    else if ((m = l.match(/^↷ SKIP (.+) \(human_edited=/))) terminal(m[1], 'skipped', 'edit')
    // Der Zwilling MUSS vor der Zeile darunter stehen. Er ist der spezifischere Ausdruck
    // (voller Grundtext, $-verankert); andersherum riesse die kuerzere Regex einen Basisnamen
    // auseinander, der selbst auf `.correction` endet.
    // Der Anker ist der feste SCHLUSSTEXT, nicht die Gier. Ein Rueckverweis wie beim
    // `apply: SKIP`-Zweig geht hier nicht — der Basisname steht nur EINMAL in der Zeile.
    // `\.json - Roh-Transkript nicht gefunden` laesst genau eine Zerlegung zu; damit ueberlebt
    // auch ein Basisname, der selbst auf `.json` endet (`daten.json` -> "daten.json", nicht
    // "daten"). Genau diese Falle war der Grund, den Zweig in #407 zu parken.
    // **`(.+)` und `$` sind daneben REDUNDANT**, und das ist am Ausdruck selbst nachlesbar:
    // fester Schlusstext PLUS `$` lassen nur eine Zerlegung zu, und wo es nur eine gibt, ist
    // die Rueckzugsrichtung des Quantors bedeutungslos — `(.+?)` waere ein AEQUIVALENTER
    // Mutant, kein Defekt. (Empirisch gegengeprueft, aber das Argument steht ohne die Zahl:
    // wer es nachrechnen will, liest den Ausdruck.)
    // Erst wenn BEIDE Anker fallen, bricht etwas, und nur bei einem
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
    // `→ Eingereiht {base} (Korrektur) …` — die Uebergabe an den Korrektur-Pool (#442).
    // KEIN `active`-Eintrag und KEIN `global`: die Aufnahme wartet, es arbeitet niemand an ihr.
    // Nur die Reihenfolge wird festgehalten; wer die Schlange verlaesst, entscheidet
    // `korrekturSchlange` an den anderen Feldern.
    // Doppelte Namen werden verworfen, obwohl der Erzeuger heute keine druckt (`processed`
    // in `transcribe_project` laesst eine Base nur einmal durch). Der Grund ist die WIRKUNG
    // eines Duplikats: es verschoebe JEDEN Nachfolger um eins nach hinten — aus „noch 1 vor
    // dieser" wuerde „noch 2", dauerhaft und ohne dass etwas danach aussieht. Eine Zeile
    // gegen eine Klasse falscher Zahlen. (Gefunden vom Was-erlaubt-der-Fix-Pruefer.)
    else if ((m = l.match(/^→ Eingereiht (.+?) \(Korrektur\) …$/))) {
      if (!eingereiht.includes(m[1])) eingereiht.push(m[1])
    }
    else if (/^prep: \d+ Datei/.test(l)) { global = 'prep' }
    else if (/^(→ Glossar|✓ Glossar|↷ nutze vorhandenes _glossar)/.test(l)) { global = 'glossary' }
    // `[active] {base}` - die zweite Quelle fuer "diese Aufnahme gehoert zum Lauf", und seit
    // #431 die einzige fuer eine, die erst waehrend des Laufs dazukam.
    //
    // ZULETZT im Zweig, nicht zuerst - und das ist die Antwort auf einen GEMESSENEN Fehler der
    // ersten Fassung: dort stand er vor den Dialekt-Regexen und frass mit `continue` jede Zeile,
    // die mit `[active] ` beginnt. In einem Projekt namens "active" praefixt `transcribe.py`
    // JEDE Zeile so; gemessen ergab das `perBase={}` statt `{B:'done'}`, und `gesehen` fuellte
    // sich mit Bruchstuecken. Dieselbe Falle wie beim Projekt namens "scope" weiter oben und wie
    // #379 fuer "fetch" - hier gespiegelt geloest: die spezifischen Formen gewinnen, diese
    // greift nur, wenn keine andere passt.
    //
    // Eine MENGE, die nur waechst: kein Zustand ueber Zeilen hinweg, keine Wette auf ihre
    // Reihenfolge. Der Kommentar am `Diarisiere`-Zweig lehnt dieselbe Quelle ab, weil "ihre
    // Bedeutung ueber den Lauf wechselt" - das trifft dort zu, wo der WERT der Zeile gebraucht
    // wird (welche Phase). Hier zaehlt nur ihre Existenz, und die wechselt nicht.
    //
    // GEMESSEN, weil derselbe Kommentar es verlangt ("Ungemessen; wer sie doch nehmen will,
    // misst zuerst"): DREI Endurteile haben KEIN vorangehendes `[active]` fuer ihren Basisnamen
    // - `skip (Audio nicht mehr vorhanden)` in `transcribe_project` (steht VOR dem `[active]`)
    // und zweimal `SKIP (human_edited=true)` in `correct.py` (beide kehren vor ihrem `[active]`
    // zurueck). Fuer Aufnahmen aus dem `[scope]` ist das folgenlos. Fuer spaeter dazugekommene
    // bleibt der erste Fall ungefixt: unveraendert zu vorher, als getragene Grenze benannt.
    //
    // NICHT getrimmt, anders als `jobs.buche_aktive` es tut: `safe_name` laesst Randleerzeichen
    // durch, und die Endurteil-Regexe fangen den Namen roh ein.
    //
    // Was das NEU erlaubt: die Oberflaeche liest `[active]` bis hierher GAR NICHT. Zwei
    // praeparierte Zeilen erzeugen jetzt eine Geisterzeile fuer eine Datei, die es nicht gibt -
    // kein Datenverlust, kein Dateizugriff.
    //
    // NACHGEZOGEN, seit es `erreicht` gibt: „Geisterzeile fuer eine Datei, die es nicht gibt"
    // untertreibt seitdem. Dieselben zwei Zeilen (`[active] X` + `apply: X -> edit.json`)
    // buchen einen BELEG fuer X - und der dreht die Ruheanzeige einer ECHTEN Datei gegen die
    // Platte („Fertig" ueber Nur-Audio), waehrend ein gefaelschtes `done` allein vorher an
    // `ruhe(file)` folgenlos verpuffte. Der WEG ist unveraendert (dieselbe Wache wie fuer
    // `state`), der SCHADEN dahinter ist neu. Die Wurzel bleibt die #416/#413-Klasse - der
    // Erzeuger, der fremden Text hinter ein Klammerpraefix setzt -, und die lebenden Drucker
    // flachen ihn heute mit `_einzeilig` ab; ungeerntete Drucker (#409) bleiben der Restweg. Und die Zulassung rechtfertigt einen ZUSTAND, nie
    // eine Prognose: die Warteschlangen-Anzeige haengt weiter allein am `scope` (siehe Sidebar
    // und ProjectWorkspace), weil das Glossar seit #450 KORPUSWEIT `[active]` meldet.
    else if (l.startsWith('[active] ')) {
      const b = l.slice(9)
      if (b) gesehen.add(b)
    }
    // `[scope+] b1\tb2` - der NACHTRAG zum Wirkungsbereich (transcribe.py). Die eine
    // `[scope]`-Zeile ist gedruckt, BEVOR die Schleife das erste Mal `find_audio` ruft; eine
    // waehrend des Laufs hochgeladene Aufnahme wird aber sehr wohl noch verarbeitet. Ohne
    // diesen Zweig war sie weder im Bereich noch (bis zu ihrem ersten `[active]`) gesehen und
    // stand auf ihrem Ruhezustand "Nur Audio - noch nicht transkribiert", waehrend der Lauf
    // sie sicher noch anfasst.
    //
    // An `scope` und NICHT an `gesehen`: `scope` ist die ZUSAGE ueber den Lauf und
    // rechtfertigt die Prognose "In Warteschlange", `gesehen` ist die Beobachtung je Datei
    // und rechtfertigt nur einen Zustand (siehe `imBereich`/`zugelassen` unten). Ein Nachtrag
    // ist eine Zusage.
    //
    // ZULETZT im Zweig, aus demselben gemessenen Grund wie `[active]` daruber: `safe_name`
    // laesst `+` durch (nur Steuerzeichen, Trenner und `..` fliegen raus), ein Projekt namens
    // "scope+" praefixt also JEDE Zeile von transcribe.py so. Weiter oben mit `continue`
    // gestellt frasse dieser Zweig sie alle. Der Restschaden ist hier kleiner als beim
    // ersetzenden `[scope]`: additiv kommt je ZEILE ein Phantomschluessel dazu, der auf
    // keine Datei passt - die echten Basisnamen bleiben stehen. Negativkontrolle im Test.
    //
    // "Je Zeile" und nicht "hoechstens einer" - hier stand zuerst das Zweite, und es ist
    // falsch: ueber den ganzen Lauf waechst die Menge unbegrenzt (gemessen vom kalten
    // Diff-Leser: Erstbereich plus 500 Projektzeilen ergaben 501 Eintraege). Der Zeilenpuffer
    // ist bei MAX_JOB_LINES gedeckelt, diese Menge nicht. Anzeigefolgen hat sie keine, aber
    // die Wurzel gehoert dem Erzeuger (#416), und die serverseitige Schwester in `jobs.bases`
    // treibt zusaetzlich den 409-Riegel und reist bei jedem Poll mit - als eigener Punkt
    // festgehalten, Geschwister von #478.
    //
    // NUR wenn der Bereich schon steht - dieselbe Bedingung wie serverseitig in `jobs.py`
    // (`bases is not None`). `scope === undefined` heisst fuer `imBereich` "gilt fuer alle";
    // aus einem Nachtrag einen Erstbereich zu machen kehrte das in "gilt nur fuer diese paar"
    // um und verwuerfe die Urteile aller uebrigen. Zwei Leser, eine Regel.
    else if (scope !== undefined && l.startsWith('[scope+] ')) {
      // Wie bei `[scope]`: GENAU das eine Trennleerzeichen hinter der Marke, nie `trim()` -
      // `safe_name` laesst Randleerzeichen durch, und getrimmt zerfiele dieselbe Datei in
      // zwei Schluessel.
      for (const b of l.slice(9).split('\t')) {
        if (!b) continue
        // REANNONCEMENT = Identitaetssignal (#479/#489): transcribe.py meldet eine Base nur
        // nach, wenn ihre Datei-IDENTITAET (`_kennung`) von der zuletzt angekuendigten
        // abweicht — steht die Base schon im Bereich, ist diese Marke der Beweis „eine
        // ANDERE Datei unter diesem Namen".
        //
        // DIE TILGUNG IST DEFENSIV, NICHT TRAGEND (kalter Zweitleser, 2026-08-31): eine
        // Base mit Urteil im Puffer ist in `processed` oder `failed_bases` und damit NIE
        // wieder `pending` — und nur `pending`-Basen werden re-annonciert. Ein Produzent
        // druckt die Sequenz Urteil-dann-Marke also NICHT; die Erbschafts-Vermeidung von
        // #479/#489 traegt heute ausschliesslich `entfernt` samt serverseitigem discard.
        // Die Tilgung hier wacht ueber den Fall, dass jemand die Druckbedingung kuenftig
        // erweitert (z.B. auf mtime-Touch — dann waere die Sequenz erreichbar, und ohne
        // Tilgung ueberstuende ein ranghohes altes 'failed' das neue 'done' bis zum
        // Jobende). `_kennung` ueberfeuert bewusst (None bei unlesbarer Datei), trifft
        // aber ausschliesslich urteilslose Basen: die Tilgung kann kein ehrliches Urteil
        // toeten. Ein zweites Reannoncement tilgt nochmals; eine NEU angemeldete Base hat
        // nichts zu tilgen. Faellt die Marke nach >10 000 Zeilen selbst aus dem Puffer,
        // ist das folgenlos: alles, was sie entwertet haette, war aelter und laengst
        // verdraengt, und die Reaktivierung der Unterdrueckung geschah ohnehin
        // SERVERSEITIG beim Eintreffen der Marke.
        if (scope.has(b)) {
          delete perBase[b]
          delete erreicht[b]
          delete active[b]
          delete blocks[b]
          if (cursor === b) cursor = null
        }
        // KEIN `ungueltig.delete(b)` hier — die Reaktivierung ist SERVERSEITIG (siehe
        // Seed-Kommentar oben): nur der Server weiss, ob diese Marke VOR oder NACH der
        // letzten Loeschung angekommen ist.
        scope.add(b)
      }
    }
    // reuse / diarize-SKIP / prep-SKIP / "Diarisierung deaktiviert" -> bewusst ignoriert
  }

  // `gesehen` nur, wenn wirklich etwas darin steht: ein immer vorhandenes leeres Set waere
  // eine Feldaenderung in JEDER Antwort, fuer einen Fall, den es meist gar nicht gibt.
  return { global: Object.keys(active).length ? null : global, scope,
           gesehen: gesehen.size ? gesehen : undefined,
           entfernt: ungueltig.size ? ungueltig : undefined,
           erreicht: Object.keys(erreicht).length ? erreicht : undefined,
           eingereiht: eingereiht.length ? eingereiht : undefined,
           active, perBase, bilanz }
}

/** Zwei Fragen, die drei Oberflaechen-Stellen bisher je selbst beantwortet haben (#431) --
 *  und genau deshalb dreimal: Sidebar, ProjectWorkspace und der Parser. Zwei davon standen
 *  falsch, die dritte fand erst ein Review. Hier stehen sie einmal.
 *
 *  Der Unterschied ist keine Feinheit, sondern der Kern:
 *  - `scope` ist eine ZUSAGE ueber den ganzen Lauf ("diese Aufnahmen fasse ich an"). Sie
 *    rechtfertigt eine PROGNOSE: "steht in der Warteschlange".
 *  - `gesehen` ist eine BEOBACHTUNG je Datei ("diese habe ich angefasst"). Sie rechtfertigt
 *    einen ZUSTAND, aber keine Prognose -- das Glossar meldet seit #450 KORPUSWEIT `[active]`,
 *    ein Einzeldatei-Korrekturlauf stellte sonst den ganzen Korpus auf "In Warteschlange..."
 *    (gemessen: 3 statt 1). */
export function imBereich(phases: JobPhases | undefined, base: string, jobRunning: boolean): boolean {
  if (!jobRunning) return false
  return phases?.scope ? phases.scope.has(base) : true
}

/** Darf fuer `base` ein ZUSTAND (Phase, Endurteil) angezeigt werden? Bereich ODER Beobachtung. */
export function zugelassen(phases: JobPhases | undefined, base: string, jobRunning: boolean): boolean {
  if (!jobRunning) return false
  return imBereich(phases, base, jobRunning) || (phases?.gesehen?.has(base) ?? false)
}

export const WARTE_LABEL: Record<Warten['art'], string> = {
  transcribe: 'Wartet auf Transkription', correct: 'Wartet auf Korrektur',
}

/** Die Reihenfolge, in der ein Lauf seine Aufnahmen abarbeitet.
 *
 *  Die naheliegende Annahme („das Set bewahrt die Einfuegereihenfolge, also steht dort die
 *  Laufordnung") ist FALSCH, und zwar genau fuer den Standardweg dieser App:
 *  `transcribe.py` sortiert seine `pending`-Liste in JEDER Runde neu (`pending.sort(...)` in
 *  `transcribe_project`), eine waehrend des Laufs hochgeladene Aufnahme wird also einsortiert —
 *  der Leser haengt sie per `[scope+]` aber ans ENDE (`scope.add(b)` im `[scope+]`-Zweig
 *  weiter oben). Dazu vereinigt `useActiveJob` den Bereich mit `r.bases`, und das ist
 *  serverseitig ein Set (`jobs.bases`), kommt also in Hash-Ordnung an.
 *
 *  Belege, getrennt nach Herkunft — der Satz „beides gemessen" stand hier ohne sie:
 *  - GEMESSEN am laufenden Server (Wegwerf-Projekt, 3 Aufnahmen): `GET /api/projects` lieferte
 *    `bases` als `["Interview-2","Zebra","Interview"]`, also weder Alphabet noch Laufordnung.
 *  - GEMESSEN am Erzeuger: `sorted(['Interview.wav','Interview-2.wav'], key=basename)` ergibt
 *    `Interview-2` zuerst, `sorted(['Interview','Interview-2'])` das Gegenteil.
 *  - AM CODE BELEGT (nicht zur Laufzeit ausgefuehrt): dass `[scope+]` ans Ende haengt, steht
 *    im Zweig oben; dass die Schleife neu sortiert, in `transcribe.py`.
 *
 *  Sortiert wird deshalb hier.
 *
 *  EIN Schluessel fuer beide Laeufe, und das ist keine Vereinfachung, sondern die Reparatur
 *  einer geratenen: hier stand `base + "."` fuer transcribe, weil dessen Schleife nach
 *  DATEINAME MIT ENDUNG sortierte. Das ist fuer `Interview` / `Interview-2` richtig und fuer
 *  jede Base MIT PUNKT falsch (`Aufnahme` / `Aufnahme.1` laeuft andersherum, gemessen) — und
 *  die Endung kennt die Oberflaeche gar nicht, `ProjectFile` traegt nur die Base. Statt den
 *  Schluessel des Erzeugers nachzubauen, sortiert der Erzeuger jetzt selbst nach der Base
 *  (`transcribe.py`, `pending.sort(key=splitext(basename)[0])`); `correct.py` tat es ohnehin
 *  (`paths.transcript_bases` endet auf `sorted(out)`). Gefunden vom kalten Diff-Leser.
 *
 *  GETRAGENE GRENZE: JS vergleicht UTF-16-Code-UNITS, Python Code-POINTS. Fuer Zeichen
 *  oberhalb der BMP (Emoji im Dateinamen) koennen die Ordnungen auseinanderlaufen; ein
 *  code-point-genauer Vergleicher waere mehr Code als der Fall wert ist. */
export function laufOrdnung(bases: Iterable<string>): string[] {
  return [...bases].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/** Worauf die noch nicht begonnenen Aufnahmen EINES Laufs warten, und wie viele vor ihnen
 *  liegen (#370/#442).
 *
 *  Ausstehend heisst: im Bereich UND ohne Endurteil. Die gerade laufende Datei zaehlt MIT —
 *  sie liegt vor den wartenden, auch wenn sie selbst keine Wartezeile zeigt.
 *
 *  Ohne Bereich entsteht nichts: `imBereich` liest ein fehlendes `scope` als „gilt fuer alle",
 *  und daraus liesse sich keine Zahl bilden, die nicht geraten waere. Der URL-Import faellt
 *  aus demselben Grund heraus — er kennt gar keine Basisnamen (`jobPhases` verwirft jede
 *  `[fetch] `-Zeile), also gibt es dort nichts zu zaehlen. */
export function warteKarte(phases: JobPhases, kind: string): Record<string, Warten> {
  if (!phases.scope || (kind !== 'transcribe' && kind !== 'correct')) return {}
  // Drei Gruende, NICHT mehr zu warten — und alle drei sind noetig:
  // (1) ein Endurteil im Puffer · (2) die Aufnahme ist geloescht (dann unterdrueckt `terminal()`
  // ihr Urteil, und die blosse Abwesenheit hiesse sonst „steht noch aus" — gemessen: das
  // Loeschen EINER fertigen Aufnahme verlaengerte die Warteschlange aller uebrigen, dauerhaft)
  // · (3) der Zeilendeckel hat ihr Urteil verdraengt (siehe `schonDurch`).
  const ausstehend = laufOrdnung(phases.scope).filter(
    b => !Object.hasOwn(phases.perBase, b) && !phases.entfernt?.has(b) && !schonDurch(phases, kind, b))
  const karte: Record<string, Warten> = Object.create(null)
  ausstehend.forEach((base, i) => { karte[base] = { art: kind, vor: i } })
  return karte
}

/** Wer im gestaffelten Lauf auf einen Korrektur-Slot wartet (#442).
 *
 *  Das ist ein Zustand NACH dem Endurteil, und deshalb steht er hier statt in `warteKarte`:
 *  deren Vertrag lautet „ausstehend = im Bereich UND ohne Endurteil", und der ist richtig.
 *  Eine Aufnahme, die auf ihre Korrektur wartet, hat ihr Transkriptions-Urteil dagegen
 *  laengst (`fertig X:` ⇒ `done`/`raw`) — sie faellt aus `ausstehend` heraus, und genau das
 *  war die getragene Grenze aus PR #500.
 *
 *  Die Menge kommt aus `eingereiht` und NICHT aus `scope`: nur die Uebergabezeile weiss, wer
 *  wirklich in der Schlange steht, und ihre Reihenfolge ist die des Pools. Aus `scope`
 *  hergeleitet waere beides geraten — die Menge, weil eine Aufnahme auch ohne Anbieter
 *  transkribiert wird, und die Ordnung, weil ein Nachzuegler alphabetisch vorne stehen kann.
 *
 *  Wer die Schlange VERLAESST, sind drei Faelle, und jeder braucht seine Bedingung:
 *  - `active`: ein Arbeiter hat sie uebernommen (`→ Korrigiere`). Ihre Pille zeigt die Phase.
 *  - `erreicht === 'edit'`: `apply:` hat geschrieben, die Korrektur ist durch.
 *  - ein Urteil ausser `done`: `failed` oder `skipped` heisst, dass keine Korrektur mehr
 *    kommt. `done` allein reicht NICHT als Ausschluss — es ist das Urteil der
 *    TRANSKRIPTION und steht bei jeder Wartenden.
 *  Dazu `entfernt`: eine geloeschte Aufnahme wartet nicht mehr (dieselbe Regel wie in
 *  `warteKarte`, dort gemessen — ohne sie verlaengerte eine Loeschung die Schlange dauerhaft).
 *
 *  GETRAGENE GRENZE: laeuft daneben ein eigener `correct`-Job, zaehlt `mergePhases` beide
 *  Schlangen unter derselben Art zusammen, obwohl es zwei Pools sind — die Zahl ist dann zu
 *  gross. Der Normalweg schliesst das aus (`app.py` gibt 409), erreichbar bleibt es ueber die
 *  Gegenrichtung aus #496. */
export function korrekturSchlange(phases: JobPhases, kind: string): Record<string, Warten> {
  if (kind !== 'transcribe' || !phases.eingereiht) return {}
  const wartend = phases.eingereiht.filter(
    b => !Object.hasOwn(phases.active, b) && phases.erreicht?.[b] !== 'edit'
      && (!Object.hasOwn(phases.perBase, b) || phases.perBase[b] === 'done')
      && !phases.entfernt?.has(b))
  const karte: Record<string, Warten> = Object.create(null)
  wartend.forEach((base, i) => { karte[base] = { art: 'correct', vor: i } })
  return karte
}

/** Zweiter Beleg dafuer, dass eine Aufnahme NICHT mehr wartet — neben ihrem Endurteil.
 *
 *  Noetig wegen des Zeilendeckels: `fuege_zeile_an` verdraengt bei MAX_JOB_LINES aus der
 *  MITTE des Puffers, und an einem echten Lauf sind 10.560 Zeilen gemessen (#475). Genau die
 *  `fertig X:`-Zeilen frueher Aufnahmen fallen dort heraus — `perBase` verliert sie, und ohne
 *  diese zweite Frage zaehlte die Karte laengst FERTIGE Dateien als wartend: sie bekaemen
 *  „Wartet auf Transkription", und die wirklich wartende Datei bekaeme eine zu grosse Zahl.
 *  Aus einem fehlenden Etikett wuerde damit eine falsche Zahl. Gefunden vom kalten Diff-Leser,
 *  am echten Parser gemessen.
 *
 *  Der Rueckweg ist derselbe, den #475 dafuer gebaut hat: `gesehen` kommt aus der
 *  Serverbuchfuehrung, waechst nur und ueberlebt den Deckel.
 *
 *  NUR fuer `transcribe`, und das ist die ganze Feinheit: dort ist `[active] X` gleichbedeutend
 *  mit „diese eine Datei ist jetzt dran" (der Lauf ist sequentiell, eine GPU), „gesehen und
 *  nicht mehr aktiv" heisst also „durch". Im `correct`-Lauf meldet das Glossar seit #450
 *  KORPUSWEIT `[active]` — dort waere jede Aufnahme von der ersten Sekunde an „gesehen", und
 *  die Karte bliebe fuer immer leer. */
function schonDurch(phases: JobPhases, kind: string, base: string): boolean {
  return kind === 'transcribe' && !!phases.gesehen?.has(base) && !Object.hasOwn(phases.active, base)
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
