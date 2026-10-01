import { createContext, useContext } from 'react'
import { korrekturSchlange, laufOrdnung, RANG, schonDurch, warteKarte } from '@/lib/jobPhases'
import type { GlobalPhase, JobPhases, Warten } from '@/lib/types'

/** Zwei Zustaende, die der SERVER nie sendet — sie entstehen hier, aus dem Ausbleiben einer
 *  Antwort (#382). Deshalb stehen sie in `Job.status` und NICHT im Antworttyp `JobStatus`:
 *  dort waeren sie eine Behauptung ueber den Server, die er nie aufstellt. */
export const UNERREICHBAR = 'unerreichbar'   // dreimal keine Antwort — der Lauf laeuft weiter
export const VERSCHWUNDEN = 'verschwunden'   // Server antwortet 404 — Kennung unbekannt, Ausgang unbekannt

/** Zaehlt dieser Zustand fuer die ANZEIGE als „es laeuft etwas"?
 *
 *  EINE Stelle fuer eine Regel, die sonst an sieben Lesern haengt: waehrend eines Hängers
 *  soll die Oberflaeche stehenbleiben und nicht auf „Bereit" springen und zurueck. */
export const zeigtLauf = (status: string) => status === 'running' || status === UNERREICHBAR

export type Job = { id: string; project: string; kind: string; status: string; phases: JobPhases }
export type Ctx = {
  jobs: Job[]
  adopt: (id: string, project: string, kind: string, bases?: string[]) => void
  /** Eine Vormerkung verfolgen, bis daraus ein Lauf wird (#381). Aufzurufen ueberall dort,
   *  wo ein Start mit `started: false` antwortet — die Job-Kennung ist dann wertlos. */
  verfolge: (nummer: string) => void
  // Nutzlast statt leerem Aufruf: ein Zuhoerer, der wissen muss WAS terminal wurde, kann sich
  // nicht auf `jobs` aus seinem eigenen Render-Closure verlassen -- der Aufruf unten kommt
  // synchron vor dem eigenen Rerender, der Closure-Stand ist zu diesem Zeitpunkt noch alt.
  onSettled: (fn: (beendet: Job[]) => void) => () => void
}
export const JobContext = createContext<Ctx | null>(null)

// `RANG` steht seit #405 in `lib/jobPhases.ts`: dieselbe Regel gilt jetzt auch INNERHALB
// eines Laufs (der gestaffelte Job gibt einer Aufnahme zwei Terminalurteile), und zwei Orte
// mit derselben Regel driften auseinander.

/** Transkription und Korrektur duerfen gleichzeitig laufen (jobs.py: Dedupe je Projekt UND Art),
 *  also mehrere Jobs zusammenfuehren. NUR Jobs EINES Projekts hineingeben — `active` ist nach
 *  Basisnamen indiziert, und derselbe Basisname existiert durchaus in mehreren Projekten.
 *
 *  Drei Regeln, ohne die die Anzeige von der Job-Reihenfolge abhinge:
 *  - Ein perBase-Eintrag weicht, wenn dieselbe Datei in einem anderen Job gerade laeuft — sonst
 *    maskiert das 'Fertig' der Transkription die laufende Korrektur (FileStatusPill prueft state zuerst).
 *  - Kollidieren zwei aktive Phasen auf derselben Datei, gewinnt 'transcribe': dann wird das
 *    Transkript gerade ersetzt, und die Korrektur arbeitet auf gleich veralteten Daten.
 *  - Kollidieren zwei TERMINALE Ausgaenge, gewinnt der schwerere (`RANG`). Hier stand ein
 *    `Object.assign`, also "der spaetere Job im Array" — und diese Reihenfolge ist nicht
 *    zufaellig, sondern systematisch die schlechte: `jobs.py:273` sortiert `active_for` nach
 *    `kind`, also `correct` vor `transcribe`, und `useProjektDaten` adoptiert in dieser
 *    Reihenfolge. Ein Transkriptionslauf druckte beim Start fuer JEDE bereits transkribierte
 *    Datei `skip (vorhanden)` — womit sein 'skipped' jedes 'failed' des parallelen
 *    Korrekturlaufs ueberschrieb. Gemessen an genau dieser Paarung, beide Richtungen.
 *    NACHTRAG: diese Druckform gibt es seit dem gestaffelten Lauf nicht mehr (die dynamische
 *    `pending`-Liste filtert fertige Dateien vorher heraus, sie erzeugen gar keine Zeile).
 *    Die Regel bleibt richtig und noetig — 'skipped' kommt jetzt aus `correct`s `apply: SKIP`
 *    und kann dieselbe Kollision erzeugen —, nur der genannte Ausloeser ist historisch.
 *
 *  `global` bleibt reihenfolgeabhaengig (`?? `) und ist es bewusst: die globalen Phasen sind
 *  keine Rangfolge ("Glossar" ist nicht schwerer als "Vorbereiten"), und der erste laufende
 *  Job ist die naheliegendste Auskunft. Der Satz "ohne die Regeln haenge die Anzeige von der
 *  Reihenfolge ab" galt hier nie — er stand trotzdem da. */
export function mergePhases(jobs: Job[]): JobPhases {
  // `Object.create(null)` aus demselben Grund wie in `parseJobPhases` — und die Stelle war
  // beim ersten Anlauf uebersehen: dort ist der Schaden ein Wurf, hier ist er STILL. Fuer eine
  // Aufnahme namens `constructor` ist `base in warten` ueber den Prototyp wahr, die
  // Kollisionsregel eine Zeile darunter greift, und die Datei bekaeme gar keine Warteauskunft.
  // Gefunden von der CodeRabbit-CLI, nachdem der kalte Diff-Leser die Klasse im Parser fand.
  const active: JobPhases['active'] = Object.create(null)
  const perBase: JobPhases['perBase'] = Object.create(null)
  const globalPerBase: Record<string, GlobalPhase> = Object.create(null)
  const warten: Record<string, Warten> = Object.create(null)
  // Getrennt gesammelt und ERST NACH der Raeumung eingemischt (#442): die Eintraege der
  // Korrektur-Schlange tragen per Konstruktion ein Endurteil (`done` aus ihrer Transkription),
  // die Schleife `for (base of keys(perBase)) delete warten[base]` weiter unten loeschte sie
  // also samt und sonders wieder. Hier oben eingehaengt waere der ganze Fix wirkungslos —
  // und zwar lautlos, weil das Ergebnis dann einfach dem Vorzustand gleicht.
  const korrWarten: Record<string, Warten> = Object.create(null)
  // Wer den Lauf hinter sich hat (#581). Gesammelt je Job, weil `schonDurch` die ART braucht,
  // beschnitten erst ganz am Ende — `warten` steht bis dahin nicht fest.
  const durch = new Set<string>()
  // Die geloeschten Basen aller Jobs — gesammelt wie `durch`, gebraucht erst beim Beschnitt
  // unten. `mergePhases` reicht `entfernt` selbst NICHT heraus (die Pille braucht es nicht);
  // hier drin wird es sehr wohl gebraucht, und das ist nicht dieselbe Frage.
  const geloescht = new Set<string>()
  // JEMALS geloescht, bis eine neue [active]-Zeile der Base (#591) — dieselbe Sammlung,
  // ein Schnitt weiter unten. Die LIVEN Menge `entfernt` hoert an der `[scope+]`-Marke auf
  // (Identitaetssignal, #479/#489), die MONOTONE hoert erst auf, wenn die neue Datei
  // laeuft; zwischen beidem liegt das Fenster von #591.
  const jeGeloescht = new Set<string>()
  let global: JobPhases['global'] = null
  let allScoped = jobs.length > 0
  let scope: Set<string> | undefined
  // Rein additiv, ohne `allScoped`-Vorbehalt: `scope` ist eine ZUSAGE ueber den ganzen Lauf
  // (faellt sie bei einem Job weg, taugt die vereinigte Menge nicht mehr als Filter),
  // `gesehen` dagegen ist eine BEOBACHTUNG je Datei - die bleibt wahr, egal was die anderen
  // Jobs melden.
  let gesehen: Set<string> | undefined
  // Wie `gesehen` rein additiv und ohne `allScoped`-Vorbehalt: ein Beweis ueber die Platte
  // bleibt wahr, egal was die anderen Jobs melden.
  //
  // `edit` schlaegt `raw` — und das ist hier ein TIE-BREAK, keine Regel wie in `terminal()`.
  // Dort entscheidet die Zeilenreihenfolge (die spaetere Zeile ist der frischere Beweis);
  // ueber JOBS hinweg gibt es keine solche Ordnung, `jobs.py:273` sortiert nach `kind` und
  // die Adoptionsreihenfolge sagt nichts ueber die Zeit. Der Fall ist praktisch unerreichbar:
  // ein Projektlauf fasst nur Aufnahmen OHNE `.json` an, kann also keinen `raw`-Beleg fuer
  // eine Datei erzeugen, die ein parallel laufender `correct`-Job gerade beschreibt; und der
  // Loesch-plus-Neu-Upload-Weg landet entweder im SELBEN Strom (dann entscheidet `terminal`)
  // oder in einem Job, der erst startet, wenn dieser hier laengst terminal ist.
  //
  // TRAGENDE INVARIANTE (kalter Plan-Review zu K1 Glied 3): diese Vereinigung darf nur
  // LAUFENDE Jobs sehen — alle drei Konsumenten filtern vorher auf `running`
  // (ProjectWorkspace.tsx, AppShell.tsx, useDokumentTitel.ts). Ein kuenftiger Konsument,
  // der ueber ALLE Jobs merged, holte `erreicht[X]='edit'` aus einem terminalen
  // Vorlaeufer zurueck, und der TIE-BREAK darunter (`edit` schlaegt `raw`) machte es
  // schlimmer: genau der Beleg, den `parseJobPhases` fuer geloeschte Aufnahmen tilgt,
  // kaeme hier ein zweites Mal herein.
  const erreicht: NonNullable<JobPhases['erreicht']> = Object.create(null)
  for (const j of jobs) {
    for (const [base, e] of Object.entries(j.phases.erreicht ?? {})) {
      if (erreicht[base] !== 'edit') erreicht[base] = e
    }
    if (j.phases.gesehen) {
      gesehen = gesehen ?? new Set()
      for (const b of j.phases.gesehen) gesehen.add(b)
    }
    if (j.phases.scope) {
      scope = scope ?? new Set()
      for (const b of j.phases.scope) {
        scope.add(b)
        if (j.phases.global && !Object.hasOwn(j.phases.active, b) && !Object.hasOwn(j.phases.perBase, b)) {
          globalPerBase[b] = j.phases.global
        }
      }
    } else {
      allScoped = false
      global = global ?? j.phases.global
    }
    for (const [base, work] of Object.entries(j.phases.active)) {
      if (Object.hasOwn(active, base) && j.kind !== 'transcribe') continue
      active[base] = work
    }
    for (const [base, zustand] of Object.entries(j.phases.perBase)) {
      const da = perBase[base]
      if (!da || RANG[zustand] > RANG[da]) perBase[base] = zustand
    }
    // Die Warteauskunft entsteht HIER und nicht im Parser (#370/#442) — Pflicht, nicht
    // Geschmack: `parsed.scope` wird eine Handvoll Zeilen weiter oben mit `r.bases`
    // VEREINIGT (der Rueckweg gegen den Zeilendeckel, #475/#483). Im Parser gerechnet
    // kennte die Karte genau die Aufnahmen nicht, fuer die es diesen Rueckweg gibt, und
    // zwei Dateien im selben Wartezustand traegen zwei verschiedene Texte.
    //
    // Je Job, weil nur der Job die ART seiner Arbeit kennt (`j.kind`) — nach dem Merge ist
    // sie weg. Kollisionsregel wie bei `active` daneben: `transcribe` gewinnt. Sie ist
    // heute unerreichbar (die Bereiche sind disjunkt: der Transkriptionslauf nimmt die
    // Aufnahmen OHNE Roh-JSON, der Korrekturlauf die MIT), steht aber da, damit die
    // Reihenfolge der Jobs nie entscheidet.
    for (const [base, eintrag] of Object.entries(warteKarte(j.phases, j.kind))) {
      if (Object.hasOwn(warten, base) && j.kind !== 'transcribe') continue
      warten[base] = eintrag
    }
    Object.assign(korrWarten, korrekturSchlange(j.phases, j.kind))
    // Aus `gesehen` und nicht aus `scope`, und der Grund ist schlicht: `schonDurch` verlangt
    // `gesehen` ohnehin, jede andere Menge waere nur eine groessere Schleife mit demselben
    // Ergebnis. (Hier stand zuerst „eine waehrend des Laufs hochgeladene Aufnahme steht nie im
    // Bereich (#431)" — das war die Lage VOR dem Bereichs-Nachtrag: seitdem haengt der Parser
    // sie per `[scope+]` an `scope`, und weiter unten wird zusaetzlich mit `r.bases` vereinigt.
    // Die Entscheidung bleibt richtig, ihre zweite Begruendung war widerlegt. Gefunden vom
    // gegnerischen Pruefer.)
    //
    // Die Menge ist deckelfest, soweit sie es sein kann — `gesehen` kommt vom Server, `active`
    // (die zweite Haelfte von `schonDurch`) nicht. Was das offen laesst, teilen sich der
    // `warten`-Schnitt unten und der Plattenbeleg in der Pille; wer welchen Fall haelt, steht
    // bei `durch` in `types.ts`.
    for (const b of j.phases.gesehen ?? []) if (schonDurch(j.phases, j.kind, b)) durch.add(b)
    // Geloeschte Aufnahmen sammeln — beschnitten wird unten, aus demselben Grund wie bei
    // `warten`: die Mengen stehen erst nach der Job-Schleife fest.
    for (const b of j.phases.entfernt ?? []) geloescht.add(b)
    for (const b of j.phases.entferntJe ?? []) jeGeloescht.add(b)
  }
  for (const base of Object.keys(active)) {
    delete perBase[base]
    delete globalPerBase[base]
    // `warten` wird hier BEWUSST NICHT geraeumt, anders als `globalPerBase` daneben — und die
    // erste Fassung tat es, was ein Rechenfehler war (Bot-Befund): die laufende Aufnahme LIEGT
    // VOR den wartenden, sie gehoert also in die Zaehlung. Ihre Pille zeigt ohnehin die Phase,
    // nicht den Wartetext (`FileStatusPill` prueft `active` vor dem Wartezweig) — die
    // Anwesenheit im Datensatz kostet nichts und haelt die Zahl richtig. `warteKarte` fuehrt
    // die laufende Datei aus demselben Grund innerhalb eines Jobs mit.
  }
  for (const base of Object.keys(perBase)) {
    delete globalPerBase[base]
    delete warten[base]     // fertig heisst: liegt vor niemandem mehr
  }
  // ... ausser, die Aufnahme steht jetzt in der ZWEITEN Schlange (#442). Ihr Urteil `done`
  // gilt der Transkription; auf ihre Korrektur wartet sie noch. `active` schlaegt das hier
  // NICHT aus — `korrekturSchlange` hat aktive Aufnahmen bereits ausgenommen, und die
  // Raeumung darueber fasst `warten` ohnehin nicht an.
  Object.assign(warten, korrWarten)
  // Nach dem Raeumen NEU durchzaehlen. `warteKarte` vergibt die Positionen je Job, die
  // Raeumung darueber nimmt einzelne Basen heraus — die Luecke bliebe sonst als zu grosse Zahl
  // stehen. Gemeldet vom Bot mit genau diesem Beispiel: Bereich A/B/C, B in einem zweiten Job
  // fertig ⇒ C behielt `vor: 2`, obwohl nur noch A vor ihm liegt.
  //
  // Je ART getrennt, weil zwei Laeufe zwei Schlangen sind. Dass ihre Bereiche disjunkt sind
  // (transcribe nimmt die Aufnahmen OHNE Roh-JSON, correct die MIT), macht die Trennung nicht
  // ueberfluessig: sie ist der Grund, warum hier ueberhaupt nach `art` gruppiert werden DARF.
  //
  // ZWEI Ordnungen, nicht eine — und die zweite ist mit #442 dazugekommen. Die
  // Transkriptions-Schlange sortiert nach NAMEN, weil ihr Erzeuger das tut
  // (`transcribe.py`: `pending.sort(key=basename)`). Die Korrektur-Schlange darf das NICHT:
  // dort arbeitet ein ThreadPoolExecutor nach SUBMIT-Reihenfolge, und eine waehrend des Laufs
  // hochgeladene Aufnahme kann alphabetisch vorne stehen und trotzdem hinten anstehen. Ihre
  // Ordnung steckt bereits im `vor`, das `korrekturSchlange` aus der Zeilenfolge gebildet hat
  // — hier wird nur die LUECKE geschlossen, die eine herausgenommene Base hinterlaesst.
  //
  // Der Fehler war in `korrekturSchlange` unsichtbar: die Funktion lieferte die richtige
  // Ordnung, diese Schleife warf sie danach weg. Gefunden von der CodeRabbit-CLI, festgehalten
  // von einem Test AN DIESER Stelle — der an der Funktion allein blieb gruen.
  const stabil = (b: string) => warten[b].vor
  for (const art of ['transcribe', 'correct'] as const) {
    const bases = Object.keys(warten).filter(b => warten[b].art === art)
    const geordnet = art === 'transcribe'
      ? laufOrdnung(bases)
      : [...bases].sort((a, b) => stabil(a) - stabil(b))
    geordnet.forEach((b, i) => { warten[b] = { art, vor: i } })
  }
  // ERST HIER beschneiden, nicht beim Sammeln: `warten` ist bis zu dieser Zeile nicht fertig —
  // `korrWarten` kommt oben erst nach der Job-Schleife dazu.
  //
  // Der Schnitt an `warten` ist der Befund, der die erste Fassung dieses Fixes gesperrt hat
  // (kalter Plan-Leser): eine Aufnahme in der KORREKTUR-Schlange hat ihr `[active]` in der
  // Transkriptionsphase laengst gedruckt und laeuft gerade nicht — `schonDurch` ist fuer sie
  // also wahr, obwohl sie sehr wohl wartet. Ohne diese Zeile haette #581 genau die
  // #442-Auskunft „Wartet auf Korrektur · noch N vor dieser" geloescht, und zwar bei den
  // Aufnahmen, die sie am laengsten brauchen.
  //
  // `active` daneben ist der billige Teil: eine laufende Aufnahme zeigt ohnehin ihre Phase,
  // aber `durch` soll nichts behaupten, was der Lauf gerade widerlegt.
  for (const b of Object.keys(warten)) durch.delete(b)
  for (const b of Object.keys(active)) durch.delete(b)
  // Und wer geloescht ist, ist nicht „durch" — der teuerste der drei Schnitte, obwohl er wie
  // der beilaeufigste aussieht. `remove_base` raeumt `gesehen` NICHT (Historie, #475), der
  // Parser unterdrueckt fuer eine entfernte Base aber `perBase` UND `erreicht` (#479/#489):
  // damit ist sie `schonDurch`-wahr, ohne Urteil, ohne Wartegrund — also in `durch`. Wird sie
  // gleichnamig neu hochgeladen, zeigt die DATEILISTE eines zweiten Fensters bis zum naechsten
  // Summenpoll (bis 4 s) noch die ALTE `has_edit`, und der Plattenbeleg der Pille faengt das
  // nicht ab: er prueft, ob etwas da ist, nicht ob es dasselbe ist. Ergebnis waere „Fertig"
  // ueber einer Aufnahme, die nur Audio ist — genau die Klasse aus #489, durch eine neue Tuer.
  // Vorher stand dort der Wartetext, und der war in diesem Fall richtig.
  //
  // Der Plattenbeleg deckt die Liste also nur in EINE Richtung ab (zu alt in Richtung
  // „weniger da"); diese Zeile deckt die andere.
  for (const b of geloescht) durch.delete(b)
  // Der zweite Loesch-Schnitt, und er trifft eine Base, die der erste gerade
  // freigegeben hat (#591): das Reannoncement `[scope+] A` nahm A aus `entfernt` heraus
  // und tilgte sein altes Urteil — `gesehen` aber bleibt stehen (Historie, #475), also
  // ist A `schonDurch`-wahr und stuende OHNE diesen Schnitt wieder in `durch`. Ein
  // zweites Fenster mit alter `has_edit`-Dateiliste zeigte dann „Fertig" ueber einer
  // Aufnahme, die nur Audio ist. Erst eine NEUE `[active]`-Zeile der Base hebt die
  // monotone Menge auf (serverseitig, `buche_aktive`) — ohne den Lift regredierte #581
  // in das Zweitleben der Datei: auch ihr Urteil kann verdraengt sein.
  for (const b of jeGeloescht) durch.delete(b)
  // KEINE `bilanz` im Ergebnis, und das ist Absicht: sie gehoert EINEM Lauf (dem URL-Import),
  // und ihr einziger Leser — der Ausgang — bekommt ihn einzeln aus der `onSettled`-Nutzlast.
  // Hier stand ein `bilanz ?? j.phases.bilanz` mit der Begruendung „zwei fetch-Jobs desselben
  // Projekts kann es nicht geben"; die haelt der Code nicht (jobs.py dedupliziert nur
  // LAUFENDE, der Provider behaelt terminale Jobs), und gelesen hat es ohnehin niemand —
  // die Zeile zu entfernen liess alle Tests gruen. Erster-gewinnt haette bei terminalem
  // Eingang die Bilanz des AELTESTEN Laufs gemeldet.
  return {
    global: Object.keys(active).length ? null : global,
    globalPerBase,
    scope: allScoped ? scope : undefined,
    gesehen,
    // Bewusst NICHT ueber `active` geraeumt wie `perBase` gleich darueber: das Urteil weicht,
    // wenn die Datei wieder laeuft, der geschriebene Inhalt auf der Platte nicht.
    erreicht: Object.keys(erreicht).length ? erreicht : undefined,
    // Wie `gesehen`/`erreicht` nur, wenn wirklich etwas darin steht — ein immer vorhandenes
    // leeres Objekt waere eine Feldaenderung in JEDER Antwort, fuer einen Fall, den es meist
    // gar nicht gibt (kein Bereich, kein wartender Rest).
    warten: Object.keys(warten).length ? warten : undefined,
    // Wie `gesehen`/`erreicht`/`warten` nur, wenn wirklich etwas darin steht.
    durch: durch.size ? durch : undefined,
    active,
    perBase,
  }
}


export function useActiveJob(): Ctx {
  const c = useContext(JobContext)
  if (!c) throw new Error('useActiveJob ausserhalb JobProvider')
  return c
}
