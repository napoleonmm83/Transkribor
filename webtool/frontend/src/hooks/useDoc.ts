import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { EditDoc, Segment } from '@/lib/types'
import { renameSpeaker as renameInDoc } from '@/lib/grouping'
import { getDoc, saveDoc, exportText, type ExportFmt } from '@/lib/api'
import { streichungenVergessen } from '@/lib/streichen'

const MIME: Record<ExportFmt, string> = { md: 'text/markdown', srt: 'application/x-subrip' }

/** Ruhe nach der letzten Aenderung, bevor gespeichert wird. */
const AUTOSAVE_MS = 800
/** Wann der Autosave es nach einem Fehlschlag erneut versucht (#107). Wachsender Abstand,
 *  damit ein kurzer Serverneustart Zeit zum Abklingen hat; nach dem letzten Versuch kommt der
 *  finale Toast, nicht bei jedem einzelnen.
 *
 *  Gesamt-Budget ~14 s. Bei einem KALTEN Serverneustart (uvicorn importiert torch, laedt die
 *  Diarisierung) kann das laenger dauern — dann steht der finale Toast, und der Nutzer stoesst
 *  per frischem Tastendruck eine neue Episode an (beruehrt setzt den Zaehler zurueck). */
const RETRY_BACKOFF_MS = [2000, 4000, 8000]

/**
 * Was die Anzeige ueber den Speicherstand sagen darf.
 *
 * `ruhig` heisst „seit dem Laden nichts angefasst“ und wird bewusst NICHT als „gespeichert“
 * gezeigt: liegt noch keine `edit.json` auf der Platte, baut der Server das Dokument beim
 * Oeffnen aus dem Rohtranskript — „gespeichert“ waere dort schlicht falsch.
 */
export type SpeicherStand = 'ruhig' | 'offen' | 'speichert' | 'gespeichert' | 'fehler'

export function useDoc(project: string | null, base: string | null) {
  const [doc, setDoc] = useState<EditDoc | null>(null)
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(false)
  const [stand, setStand] = useState<SpeicherStand>('ruhig')
  /** Zaehlt Aenderungen. Nur so laesst sich erkennen, ob waehrend eines Speicherlaufs getippt wurde. */
  const fassung = useRef(0)
  /** Zaehlt aufeinanderfolgende Fehlschlaege dieser Episode (#107). State (nicht Ref), damit der
   *  Retry-Effekt pro Fehlschlag neu ansetzt und seinen Timer mit dem jeweils groesseren Abstand legt. */
  const [fehlerZaehler, setFehlerZaehler] = useState(0)
  /** Letzte Fehlermeldung — fuer den finalen Toast, der erst nach erschoepftem Retry kommt. */
  const letzterFehler = useRef('')
  /** Verhindert den finalen Toast zweimal (StrictMode double-invoke in dev). */
  const finalToastGezeigt = useRef(false)

  const reload = useCallback(() => {
    // ZUERST, vor jedem frühen Rückkehren: ein offener „Rückgängig“-Toast zeigt auf das
    // Dokument, das dieser Lauf gerade ersetzt. `updateDoc`/`updateSegment` sind stabil und
    // schreiben per Updater ins JEWEILS offene Dokument — der Rückruf träfe also die neue
    // Datei mit dem Eintrag der alten (gemessen im Review zu #154: Dateiwechsel UND `reload()`
    // nach einer fertigen Korrektur). Dieselbe Achse wie #116.
    streichungenVergessen()
    if (!project || !base) { setDoc(null); setDirty(false); setStand('ruhig'); return }
    haengt.current = false   // neue Datei → nichts baumelt in der Tipppause
    // SYNCHRON gesetzt, und `save` liest ihn synchron: ein faelliger Autosave traegt in seiner
    // Closure die Fassung, die dieser Lauf gerade ersetzt — schriebe er noch, ginge die frisch
    // geholte Fassung auf der Platte verloren, waehrend der Editor sie anzeigt.
    //
    // Der Fall ist nicht theoretisch, er ist der Alltagsfall von #123: die Rueckfrage
    // („korrigierte Fassung laden?“) ist ein `window.confirm` und blockiert den Hauptfaden.
    // Waehrenddessen laeuft der 800-ms-Timer des letzten Tastendrucks ab; beim Zurueckkommen
    // ist er IMMER faellig und feuert unmittelbar nach `reload()`. Alle bestehenden Waechter in
    // `save` lassen ihn durch: `fassung` ist unveraendert (niemand tippt in einen Dialog),
    // `meins()` stimmt (dieselbe Datei), `neuester` auch. Ergebnis waere: Editor zeigt die
    // Korrektur und meldet „gespeichert“, auf der Platte steht die Fassung davor.
    //
    // Ein blosses `setDirty(false)` hier reicht NICHT: es raeumt den Timer erst ueber den
    // Effekt-Cleanup ab, und React flusht passive Effekte ueber den Scheduler (MessageChannel)
    // — also ebenfalls als Makrotask. Gegen einen bereits abgelaufenen Timer ist die
    // Reihenfolge damit nicht zugesichert. Nur ein Ref, den `save` selbst liest, ist es.
    // ZAEHLER, kein Bool: zwei Ladelaeufe koennen sich ueberlappen (zwei fertige Korrekturen,
    // oder Menue und Editor laden zusammen). Mit einem Bool raeumte der ZUERST zurueckkehrende
    // — also womoeglich der aeltere — den Schutz weg, waehrend der juengere noch unterwegs ist;
    // ein faelliger Autosave duerfte dann wieder schreiben. Und seine Antwort setzte obendrein
    // den aelteren Inhalt ueber den neueren. Nur der jeweils juengste Lauf darf anfassen.
    const meiner = ++ladeLauf.current
    const juengster = () => meiner === ladeLauf.current
    setLoading(true)
    getDoc(project, base).then(d => { if (juengster()) { setDoc(d); setDirty(false); setStand('ruhig') } })
      // `setStand('ruhig')` auch im Fehlerfall (#121): sonst bleibt ein 'fehler' aus der
      // Episode der VORHERIGEN Datei ueber einem leeren Editor stehen — eine Speicher-Warnung
      // fuer ein Dokument, das gar nicht mehr da ist. Der Stand gilt dem Speichern; ohne
      // geladenes Dokument gibt es nichts zu speichern.
      // Mit Meldung, seit `getDoc` ein Zeitlimit hat: ohne sie wird der Editor nach 30 s leer
      // und behauptet „Keine Datei geöffnet." (`Transcript.tsx`) — obwohl eine offen ist und
      // der Nutzer nichts falsch gemacht hat. Vorher drehte dieselbe Anfrage endlos weiter,
      // was schlecht war, aber wenigstens nicht log. `setDoc(null)` bleibt (#121s bewusste
      // Wahl); es fehlte nur das Signal. Abbruch und 500 landen beide hier — eine gemeinsame
      // Meldung reicht, eine Sonderbehandlung waere Ausbau ohne Gegenwert.
      .catch(e => {
        if (!juengster()) return
        setDoc(null); setDirty(false); setStand('ruhig')
        toast.error(`Laden fehlgeschlagen (${base}): ${e instanceof Error ? e.message : String(e)}`)
      })
      // Der Schutz faellt erst mit dem JUENGSTEN Lauf — bis dahin ist jedes Schreiben aus der
      // alten Fassung falsch.
      .finally(() => { if (juengster()) { fertig.current = meiner; setLoading(false) } })
  }, [project, base])
  // `setDirty(false)` VOR dem Laden, und zwar hier: der ungespeicherte Stand gehoert der Datei,
  // die man verlaesst — mit ihr faellt er weg. `reload()` ersetzt das Dokument erst, wenn
  // `getDoc` zurueckkommt; bis dahin gilt `doc` = A, `project`/`base` = B, `dirty` = true (aus
  // A). Der Entprellungs-Timer wird durch den `base`-Wechsel neu gesetzt und feuerte dann
  // `saveDoc(B-Pfad, A-Dokument)`: Bs `edit.json` wird durch A ersetzt, `b.md` daraus neu
  // gerendert, und `human_edited=true` landet auf B — Bs Editierarbeit ist weg, nur das
  // Rohtranskript ueberlebt. `meins()` faengt das NICHT: der Lauf traegt Bs Pfad und gilt damit
  // als „seiner“; die Ungleichheit liegt innerhalb der Closure, zwischen `doc` und dem Pfad.
  // Ein Waechter (`doc.base !== base`) waere die schlechtere Wahl: laufen die Felder je
  // auseinander (Umbenennen schreibt sie), speicherte der Editor still gar nicht mehr.
  // Der Effekt haengt an der Identitaet von `reload`, laeuft also nur beim Wechsel — das
  // `reload()` nach einem Korrekturlauf fuer dieselbe Datei geht nicht durch ihn.
  useEffect(() => { setDirty(false); reload() }, [reload])

  const beruehrt = useCallback(() => {
    haengt.current = true
    fassung.current++; setDirty(true); setStand('offen')
    // Ein neuer Tastendruck beginnt eine neue Episode (#107): alter Zaehler und ein vielleicht
    // noch ausstehender finaler Toast sind hinfällig. Der Retry-Effekt räumt seinen Timer über
    // die stand-Aenderung selbst ab.
    setFehlerZaehler(0); finalToastGezeigt.current = false
  }, [])

  const updateSegment = useCallback((id: number, patch: Partial<Segment>) => {
    setDoc(d => d && ({ ...d, segments: d.segments.map(s => s.id === id ? { ...s, ...patch } : s) }))
    beruehrt()
  }, [beruehrt])

  // Dokumentfelder ausserhalb der Segmente (Kontext, Zusammenfassung, Anmerkungen). Bewusst
  // ueber dasselbe `beruehrt()` wie eine Segmentaenderung: ein zweiter Speicherweg waere eine
  // zweite Wahrheit darueber, wann ein Dokument als gesichert gilt.
  // Absichtlich aufgezaehlt statt `Partial<EditDoc>`: durch eine weitere Tuer liessen sich
  // sonst `segments` oder `human_edited` schieben und der Segment-Pfad umgehen. `annotations`
  // kam mit #112 dazu (die Liste ist editierbar); `segments[].note` NICHT — die haengt am
  // Segment und geht ueber `updateSegment`.
  const updateDoc = useCallback((patch: Partial<Pick<EditDoc, 'context' | 'summary' | 'annotations'>>) => {
    setDoc(d => d && ({ ...d, ...patch }))
    beruehrt()
  }, [beruehrt])

  const renameSpeaker = useCallback((from: string, to: string) => {
    if (!from || !to || from === to) return   // Guard hier, nicht im setDoc-Updater: der muss rein bleiben
    // Offene Rueckwege entwerten (#226-Review M2). `renameInDoc` schreibt `context`/`summary`
    // MIT um — das ist der ganze Zweck von #90. Ein gestrichener Absatz liegt zu dem Zeitpunkt
    // aber nicht mehr im Dokument, die Umbenennung erreicht ihn also nicht; ein Klick auf
    // „Rueckgaengig" danach setzte den ALTEN Namen wieder oben ins Dokument und in den Export —
    // genau der Zustand, der in `01394435.md` gemessen wurde (67 Zeilen „Fuhat Aras", die ersten
    // beiden Absaetze „Buad Aras").
    //
    // Der Preis ist bewusst: der Rueckweg faellt auch dann weg, wenn die Umbenennung das
    // gestrichene Feld gar nicht betroffen haette. Ein verlorener Rueckweg ist sichtbar (das
    // Feld steht leer da), ein falscher Name im Export ist es nicht.
    streichungenVergessen()
    setDoc(d => d && renameInDoc(d, from, to))
    beruehrt()
  }, [beruehrt])

  /**
   * Die Kette der Speicherlaeufe. Ohne sie konnten zwei `PUT` gleichzeitig unterwegs sein: Lauf
   * A startet, 800 ms spaeter Lauf B mit dem neueren Dokument — traf A DANACH beim Server ein,
   * stand der aeltere Stand auf der Platte. Schlimmer als der Verlust war der Zustand danach: B
   * kehrt zurueck, `fassung` stimmt, also `dirty = false` und „gespeichert“; dann kehrt A zurueck
   * und meldet „offen“. Der Autosave-Effekt kehrt bei `!dirty` sofort zurueck — es fasst also nie
   * wieder etwas nach, und die Rueckfrage beim Verlassen greift nicht, weil das Dokument als
   * sauber gilt.
   *
   * Verkettet statt per Riegel abgewiesen: ein abgewiesener Lauf muesste neu angesetzt werden,
   * und dafuer gibt es keinen Ausloeser — die Abhaengigkeiten des Effekts (`dirty`, `save`)
   * aendern sich dabei nicht. Ein wartender Lauf braucht keinen.
   */
  const kette = useRef<Promise<void>>(Promise.resolve())

  /**
   * Welches Dokument gerade offen ist. `kette` und `fassung` sind Refs — sie ueberleben einen
   * Dateiwechsel, `doc`/`dirty` nicht. Ein wartender Lauf fuer Datei A kann deshalb erst
   * losgehen, wenn der Editor laengst Datei B zeigt: er liest `fassung` beim Start, sieht Bs
   * Tastendruck als seinen eigenen Stand und meldet ihn als gesichert — Bs Aenderung gaelte als
   * geschrieben, ohne es je gewesen zu sein. Dieses Fenster hat die Verkettung selbst
   * aufgemacht (vorher raeumte die Effekt-Bereinigung den Timer beim Wechsel ab).
   *
   * Geschrieben wird trotzdem: der Lauf traegt As Inhalt und As Pfad, der gehoert in As Datei.
   * Nur die Buchfuehrung (dirty/stand) gilt dem offenen Dokument und wird uebersprungen.
   *
   * `useLayoutEffect`, nicht `useEffect`: der laeuft synchron im Commit. Ein passiver Effekt
   * laeuft in einem eigenen Scheduler-Durchlauf — dazwischen liegt ein Fenster, in dem React
   * schon B zeigt, dieser Ref aber noch A sagt, und ein wartender A-Lauf die Buchfuehrung von B
   * doch anfasst. Gegen einen verworfenen Concurrent-Render ist er genauso sicher wie ein
   * passiver (der Einwand gilt nur dem Setzen WAEHREND des Renderns), und er kostet hier nichts
   * — eine Ref-Zuweisung, kein Layout-Lesen. **Nicht reproduziert:** `act()` flusht passive
   * Effekte vor jedem Timer-Rueckruf, das Fenster laesst sich in dieser Testumgebung nicht
   * aufziehen. Hergeleitet aus der Ausfuehrungsreihenfolge, nicht gemessen.
   *
   * `\n` als Trenner, nicht das Leerzeichen: Projektnamen enthalten Leerzeichen („US Car Treff
   * Rthi“), womit „A B“/„C“ und „A“/„B C“ denselben Schluessel ergaeben.
   */
  const offen = useRef('')
  useLayoutEffect(() => { offen.current = `${project}\n${base}` }, [project, base])

  /**
   * Juengster save()-Aufruf JE DOKUMENT (#117). Bei einem langsamen Server staut sich die Kette:
   * der erste PUT haengt, jede weitere Tipppause reiht einen Lauf an. Ohne diese Faellung riefen
   * alle fuenf Laeufe saveDoc auf (vier veraltet, jeder loest render_md aus) — fuer den Nutzer
   * minutenlang „speichert", obwohl nur der letzte Stand zaehlt. Ein wartender Lauf, fuer den ein
   * juengerer in der Kette steht, ueberspringt saveDoc also.
   *
   * JE DOKUMENT (Schluessel wie `offen`/`meins`): ein globaler Zaehler wuerde einen wartenden
   * A-Lauf uebersprungen, weil ein B-Lauf ihn hochtrieb — As Inhalt waere nie geschrieben
   * (Datenverlust, dasselbe wie die #116-Achse). Der Schluessel im Lauf ist der EIGENE
   * project/base, nicht `offen.current` — so bleibt der Vergleich unbeeindruckt davon, welche
   * Datei gerade offen ist.
   *
   * ponytail: die Map wird nie ausgeraeumt (ein Eintrag je (project,base) je Sitzung). Bei
   * dutzenden geoeffneten Dateien sind das wenige KB; erst bei nicht-menschlichen
   * Dokument-IDs wuerde das zaehlen — dann beim Schliessen praegen.
   */
  const neuester = useRef<Record<string, number>>({})
  /** Juengste Werte zum Lesen im Flush-Cleanup (#106). Im Render-Koerper zugewiesen: der passive
   *  Effekt-Cleanup laeuft NACH dem Render, bekommt also den Stand von JUST DIESER Datei —
   *  reload()s setDoc/setDirty greifen erst in einem spaeteren Effekt / asynchron. */
  const docRef = useRef(doc); docRef.current = doc
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty
  const standRef = useRef(stand); standRef.current = stand
  /** Laeuft die Tipppause noch (save noch nicht gerufen)? Nur dann muss der Verlassens-Flush
   *  etwas uebernehmen — ist der debounce-Timer abgelaufen, traegt die Kette den Stand schon,
   *  und ein zusaetzlicher Flush waere eine Doppelung, die #117s Zaehler-Erwartung bricht. */
  const haengt = useRef(false)
  /** Laufende Nummer des juengsten `reload()`; `fertig` die des zuletzt abgeschlossenen.
   *  Solange sie auseinanderliegen, ist ein Ladelauf offen und ein faelliger Autosave darf
   *  NICHT schreiben (Begruendung in `reload`). Refs und kein State, weil `save` sie im selben
   *  Tick lesen muss, in dem `reload` sie setzt. */
  const ladeLauf = useRef(0)
  const fertig = useRef(0)

  const save = useCallback(async () => {
    if (!doc || !project || !base) return
    // Ein Ladelauf ersetzt das Dokument gerade — was diese Closure traegt, ist die Fassung
    // davor. `dirty` bleibt oben; `reload` setzt es beim Eintreffen zurueck (der Normalfall)
    // oder im Fehlerzweig (#121). Ein `getDoc`, das NIE zurueckkommt, gaebe es als dritten
    // Fall — dagegen steht das Zeitlimit in `api.getDoc`, sonst bliebe der Autosave fuer den
    // Rest der Sitzung aus, waehrend die Leiste weiter „wird gespeichert“ zeigt.
    //
    // BEWUSST IN KAUF GENOMMEN: was der Nutzer WAEHREND des Ladelaufs tippt, ist beim
    // Eintreffen weg — `setDoc` ersetzt das Dokument als Ganzes, und dieser Lauf hat es nicht
    // mehr geschrieben. Das galt fuer den Inhalt schon immer (das Ersetzen ist der Zweck von
    // `reload`); neu ist nur, dass es auch nicht mehr auf die Platte kommt. Der Confirm-Text
    // deckt es nicht ab — er spricht von dem, was VOR dem OK stand. Bewusst kein zweiter
    // Hinweis: das Fenster ist die Antwortzeit eines lokalen GET.
    if (ladeLauf.current !== fertig.current) return
    haengt.current = false   // #106: debounce abgelaufen — dieser Aufruf traegt den Stand in die Kette
    // Angehaengt, nicht nebenher gestartet — und bewusst INNERHALB von `save`: eine ausgelagerte
    // Hilfsfunktion waere entweder eine Abhaengigkeit, die bei jedem Render wechselt (womit der
    // Entprellungs-Effekt seinen Timer endlos neu setzt und nie speichert), oder ein
    // Lint-Suppress. `speichern` wirft nicht, die Kette kann also nicht vergiften.
    // HIER gelesen, nicht im Rueckruf: `v` gehoert zu dem `doc`, das dieser Aufruf einfaengt.
    // Im Rueckruf waere es der Zaehlerstand der STARTZEIT — ein wartender Lauf saehe damit
    // Tastendruecke, die nach seinem Anhaengen kamen, als seinen eigenen Stand und meldete sie
    // als gesichert. Genau die Zeile unten (`fassung.current !== v`) waere dann wirkungslos,
    // und der zuletzt getippte Stand ginge verloren — mit „gespeichert“ in der Leiste. Vor der
    // Verkettung lagen beide im selben Tick; der Fehler entstand durch das Verschieben der
    // Zeile und ist deshalb in keinem Diff zu sehen.
    const v = fassung.current
    const meinKey = `${project}\n${base}`   // derselbe Schluessel wie `offen`/`meins`
    const meine = (neuester.current[meinKey] ?? 0) + 1
    neuester.current[meinKey] = meine
    const lauf = kette.current.then(async () => {
      // Ueberholt? Ein juengerer Lauf fuer DASSELBE Dokument wartet bereits in der Kette — dann
      // zaehlt dieser hier nicht mehr, saveDoc und Buchfuehrung entfallen (der juengste schreibt
      // denselben Inhalt ohnehin zuletzt). Der AKTIVE Lauf besteht den Check: sein then-Body lief
      // als Microtask, sobald er angehaengt wurde — bevor ein weiterer save() den Zaehler trieb.
      if (meine !== neuester.current[meinKey]) return
      /** Gilt dieser Lauf noch dem Dokument, das der Editor zeigt? */
      const meins = () => offen.current === meinKey
      if (meins()) setStand('speichert')
      try {
        await saveDoc(project, base, doc)
        // Zwischen Start und Rueckkehr kann die Datei gewechselt haben — dann gehoert die
        // Buchfuehrung einem anderen Dokument und darf hier nicht angefasst werden.
        if (!meins()) return
        // Wurde waehrend des Laufs weitergetippt, ist das Geschriebene schon wieder alt: `dirty`
        // muss stehen bleiben, sonst faellt genau diese Aenderung lautlos unter den Tisch. Die
        // Entprellung unten hat fuer sie bereits einen neuen Lauf angesetzt.
        if (fassung.current !== v) { setStand('offen'); return }
        setDirty(false); setStand('gespeichert')
        setFehlerZaehler(0); finalToastGezeigt.current = false   // Erfolg beendet die Fehler-Episode
      } catch (e) {
        // Fehlerzaehler und Meldung nur fuer das offene Dokument (#107): ein Lauf fuer A, der nach
        // einem Wechsel zu B fehlschlaegt, ist fuer B ohne Belang. Der finale Toast kommt im
        // Retry-Effekt, nicht hier — sonst Dauerfeuer bei jedem der bis zu drei Versuche.
        if (meins()) {
          setStand('fehler')   // dirty bleibt -> Rueckfragen beim Verlassen greifen
          letzterFehler.current = e instanceof Error ? e.message : String(e)
          setFehlerZaehler(n => n + 1)
        }
      }
    })
    // `.catch` an der Kette, nicht am Rueckgabewert: lehnte `kette.current` je ab, reichte
    // jedes weitere `.then()` die Ablehnung durch und ALLE folgenden Speicherlaeufe der Sitzung
    // fielen still aus. Der `catch` oben deckt das nicht ab — er dereferenziert `e` selbst und
    // kann damit seinerseits werfen (ein Reject mit `null` genuegt). Darum auch die
    // `instanceof`-Pruefung oben. **Die beiden Haertungen verdecken einander:** jede allein
    // rettet den Fall, der Test wird also erst rot, wenn BEIDE fehlen. Wer eine davon anfasst,
    // bekommt kein rotes Signal — der Schutz ist die Kombination, nicht die einzelne Zeile.
    kette.current = lauf.catch(() => {})
    return lauf
  }, [doc, project, base])

  // Flush beim Verlassen einer Datei (#106). In der 800-ms-Pause hatte die Oberflaeche "wird
  // gespeichert" versprochen; eine "Verwerfen?"-Rueckfrage beim Wechseln widerspricht dem. Der
  // Cleanup dieses Effekts laeuft beim Dateiwechsel (Key [project, base]) UND beim Unmount und
  // schreibt den neuesten Stand der VERLASSENEN Datei — ueber die Kette, damit ein noch
  // laufender Autosave VOR dem Flush steht und der juengste Stand zuletzt gewinnt.
  //
  // project/base als CLOSURE (nicht aus Ref): der Cleanup-Schluss stammt vom Effekt-SETUP
  // (Render, als diese Datei aktuell wurde) — er traegt die VERLASSENE Datei. Ein Ref wuerde beim
  // Cleanup schon die NEUE Datei tragen, denn der passive Effekt-Cleanup laeuft erst NACH Render
  // N+1. docRef/dirtyRef/standRef hingegen gehoeren beim Cleanup noch zur ALTEN Datei: reload()s
  // setDoc/setDirty greifen erst in einem spaeteren Effekt / asynchron, stehen also beim Cleanup
  // noch nicht. `haengt` schliesst den Doppel-Fire aus, wenn die Kette den Stand schon traegt;
  // stand!=='fehler', weil der Nutzer auf 'fehler' an der Leiste explizit verwirft (#106-Review).
  useEffect(() => {
    return () => {
      // VOR allen Wächtern, und deshalb hier zusätzlich zu `reload()`: dieser Cleanup ist der
      // einzige Weg, der auch das **Unmount** deckt (Editor verlassen, Datei gelöscht oder neu
      // transkribiert — `DateiMenue.wegVomEditor`). Dort schriebe der Rückweg nicht falsch,
      // sondern **gar nicht**: React verwirft `setDoc` auf einem abgebauten Hook kommentarlos.
      // Ein Knopf, der stumm nichts tut, nimmt dem Nutzer den Anlass, den Eintrag von Hand
      // nachzutragen — schlechter als kein Angebot.
      streichungenVergessen()
      if (!project || !base) return
      if (!dirtyRef.current || standRef.current === 'fehler' || !haengt.current) return
      // Und nicht, solange ein Ladelauf offen ist. Ohne diese Zeile umgeht der Flush den
      // Waechter in `save` genau dort, wo er am meisten weh tut: ein uebersprungener Lauf
      // laesst `haengt` oben (der Guard steht VOR `haengt.current = false`), und beim
      // Dateiwechsel schriebe der Cleanup `docRef.current` — die Fassung VOR der Korrektur —
      // ueber die frische `edit.json`. Derselbe Schaden, den dieser Wachposten verhindern
      // soll, nur ueber den Nachbarpfad; und der Ausgang haenge davon ab, ob der Nutzer
      // wegnavigiert oder bleibt. `haengt.current = false` in `save` waere die Alternative,
      // behauptete aber „die Kette traegt den Stand jetzt“ — was gerade nicht stimmt.
      // ZWEITER, unabhaengiger Grund fuer dieselbe Zeile (damit sie niemand als redundant
      // wegnimmt): Wechsel A→B, Bs Ladelauf noch offen, der Nutzer tippt — gepatcht wird dabei
      // As `doc`, denn B ist noch nicht da. Wechselt er nun B→C, schriebe der Cleanup
      // `docRef.current` = A-Dokument unter B-Pfad. Das ist die #116-Katastrophe, nur ueber den
      // Flush statt ueber den Autosave.
      // Die Zaehler zeigen hier noch auf die VERLASSENE Datei: React fuehrt erst alle
      // Cleanups aus, dann die Setups (und erst das Setup ruft `reload()` fuer die neue) —
      // belegt durch den bestehenden Test „spuelt beim Dateiwechsel in der Tipppause den
      // neuesten Stand", der genau diese Reihenfolge faehrt und gruen bleibt.
      //
      // Die Lint-Regel warnt, ein Ref koenne sich bis zum Cleanup geaendert haben. Genau
      // darauf beruht diese Zeile: gebraucht wird der Stand ZUM ZEITPUNKT des Verlassens,
      // nicht der beim Aufsetzen des Effekts. Ihn oben in eine lokale Variable zu kopieren —
      // was die Regel vorschlaegt — machte den Waechter wirkungslos, weil der Effekt-Koerper
      // lief, bevor es den Ladelauf gab. Dieselbe Ueberlegung wie bei `dirtyRef`/`standRef`
      // zwei Zeilen weiter unten, die aus demselben Grund hier gelesen werden.
      // oxlint-disable-next-line react-hooks/exhaustive-deps
      if (ladeLauf.current !== fertig.current) return
      const dokument = docRef.current
      if (!dokument) return
      kette.current = kette.current
        .then(() => saveDoc(project, base, dokument))
        .catch((e) => {
          toast.error(`Speichern beim Verlassen fehlgeschlagen (${base}): ${e instanceof Error ? e.message : String(e)}`)
        })
    }
  }, [project, base])

  // Autosave. `save` haengt an `doc`, wechselt also mit jedem Tastendruck die Identitaet — der
  // Effekt raeumt den alten Timer ab und legt einen neuen. Genau das IST die Entprellung, ein
  // zweiter Zeitgeber waere daneben nur eine zweite Wahrheit.
  // Nach einem Fehlschlag aendert sich keine Abhaengigkeit mehr: es wird also nicht in einer
  // Schleife nachgetreten, der naechste Tastendruck versucht es erneut.
  useEffect(() => {
    if (!dirty) return
    const t = setTimeout(() => { void save() }, AUTOSAVE_MS)
    return () => clearTimeout(t)
  }, [dirty, save])

  // Retry nach Fehlschlag (#107). Separater Effekt (nicht self-scheduling im catch): der
  // Effekt-Cleanup loest drei Dinge automatisch — (1) ein Wechsel des Dokuments aendert die
  // save-Identitaet und setzt stand zurueck → der Timer des alten Dokuments wird abgeraeumt,
  // keine Retries fuer ein Dokument, das gar nicht mehr offen ist; (2) ein neuer Tastendruck
  // (beruehrt) setzt stand='offen' → derselbe Abraeum-Effekt; (3) ein gelingender Retry setzt
  // fehlerZaehler=0 → der Effekt kehrt frueh zurueck. `fehlerZaehler` ist State, damit jeder
  // Fehlschlag den Effekt neu ansetzt und den naechsten Timer mit groesserem Abstand legt.
  // `meins()` braucht es hier nicht: stand='fehler' wird nur bei meins() gesetzt, gilt also
  // immer dem offenen Dokument; ein Wechsel setzt stand zurueck und bricht den Effekt ab.
  useEffect(() => {
    if (stand !== 'fehler') { finalToastGezeigt.current = false; return }
    // #116-Achse unter #107: doc gehoert noch zum alten Dokument, waehrend base schon neu ist
    // (getDoc fuer mehrere MB kann laenger als der Backoff dauern). Ohne diesen Guard wuerde ein
    // Retry saveDoc(neuer-Pfad, alter-Inhalt) schreiben. CLAUDE.md warnt vor `doc.base !== base`
    // im AUTOSAVE (Umbenennen legt ihn still) — hier ist er richtig, weil der Retry NUR laufen
    // soll, wenn doc zum offenen base passt, und ein gleichzeitiger Fehler+Umbenenn-Fall nicht real ist.
    if (doc?.base !== base) return
    if (fehlerZaehler > RETRY_BACKOFF_MS.length) {
      // Alle Retries aufgebraucht: ein finaler Toast, dann Schluss (kein weiterer Timer).
      // Bewusst OHNE Dateinamen (anders als der alte, sofortige Fehler-Toast): stand='fehler'
      // wird nur bei meins() gesetzt, gehoert also immer zum offenen Dokument. Kehrseite: wechselt
      // der Nutzer im ~14-s-Fenster auf eine andere Datei, unterdrueckt der doc?.base-Guard den
      // finalen Toast — A's ungespeicherter Stand bleibt unbemerkt. Das ist dieselbe Luecke, die
      // der Wechsel schon immer aufreisst (reload setzt dirty=false), nur verzögert. Issue #107
      // verbietet den Ausweg „Toast bei jedem Versuch" (Dauerfeuer) ausdruecklich.
      if (!finalToastGezeigt.current) {
        finalToastGezeigt.current = true
        toast.error(`Speichern fehlgeschlagen: ${letzterFehler.current}`)
      }
      return
    }
    const t = setTimeout(() => { void save() }, RETRY_BACKOFF_MS[fehlerZaehler - 1])
    return () => clearTimeout(t)
  }, [stand, fehlerZaehler, save, doc, base])

  const exportDownload = useCallback(async (fmt: ExportFmt, sprecher = true) => {
    if (!project || !base) return
    try {
      const text = await exportText(project, base, fmt, sprecher)
      const a = document.createElement('a')
      a.href = URL.createObjectURL(new Blob([text], { type: MIME[fmt] }))
      a.download = `${base}.${fmt}`; a.click()
      // Erst im naechsten Task freigeben: click() stoesst den Download nur an, sofort
      // widerrufen zieht ihm die URL unter den Fuessen weg. Ohne das Freigeben haelt der
      // Editor jeden je exportierten Blob bis zum Reload fest.
      setTimeout(() => URL.revokeObjectURL(a.href), 0)
    } catch (e) { toast.error('Export fehlgeschlagen: ' + (e as Error).message) }
  }, [project, base])

  /** #106-Review C1/C2: destruktive Aktionen (Loeschen / Neu transkribieren / Umbenennen) rufen
   *  das VOR dem Server-Aufruf, der die Datei zerstoert oder verschiebt. Ohne das spuelte der
   *  Verlassens-Flush die Datei als Waise wieder auf — der Backend-Save legt eine geloeschte
   *  Datei bedingungslos neu an (`makedirs exist_ok` + `atomic_write`). `setDirty(false)` bricht
   *  auch den haengenden Autosave-Timer ab; der Flush-Guard greift danach ueber dirtyRef. */
  const vergiss = useCallback(() => {
    // Auch die offenen Rueckwege (#154, CodeRabbit): zwischen `vergiss()` und dem Ende der
    // Aktion liegt ein ganzer Server-Aufruf, und der Editor steht dabei noch — der Cleanup
    // greift erst beim Navigieren bzw. beim Wechsel von `base`. Ein Klick in diesem Fenster
    // ruft `updateDoc` -> `beruehrt()` -> `dirty` und traegt den Autosave 800 ms spaeter in
    // eine Datei, die gerade geloescht oder verschoben wird. Genau die Waise, gegen die
    // `vergiss` selbst gebaut ist (#106-Review C1/C2).
    streichungenVergessen()
    setDirty(false); haengt.current = false
  }, [])

  // `save` wandert bewusst NICHT nach draussen: es gibt keinen Speichern-Knopf mehr, und eine
  // zweite Ausloesestelle waere eine, die neben der Entprellung herlaeuft.
  return { doc, dirty, stand, loading, updateSegment, updateDoc, renameSpeaker, exportDownload, reload, vergiss }
}
