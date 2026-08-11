import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { EditDoc, Segment } from '@/lib/types'
import { renameSpeaker as renameInDoc } from '@/lib/grouping'
import { getDoc, saveDoc, exportText, type ExportFmt } from '@/lib/api'

const MIME: Record<ExportFmt, string> = { md: 'text/markdown', srt: 'application/x-subrip' }

/** Ruhe nach der letzten Aenderung, bevor gespeichert wird. */
const AUTOSAVE_MS = 800

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

  const reload = useCallback(() => {
    if (!project || !base) { setDoc(null); setDirty(false); setStand('ruhig'); return }
    setLoading(true)
    getDoc(project, base).then(d => { setDoc(d); setDirty(false); setStand('ruhig') })
      .catch(() => setDoc(null)).finally(() => setLoading(false))
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

  const beruehrt = useCallback(() => { fassung.current++; setDirty(true); setStand('offen') }, [])

  const updateSegment = useCallback((id: number, patch: Partial<Segment>) => {
    setDoc(d => d && ({ ...d, segments: d.segments.map(s => s.id === id ? { ...s, ...patch } : s) }))
    beruehrt()
  }, [beruehrt])

  // Kopffelder des Dokuments (Kontext, Zusammenfassung). Bewusst ueber dasselbe `beruehrt()`
  // wie eine Segmentaenderung: ein zweiter Speicherweg waere eine zweite Wahrheit darueber,
  // wann ein Dokument als gesichert gilt.
  // Absichtlich auf die beiden Kopffelder eingeengt statt `Partial<EditDoc>`: durch eine
  // weitere Tuer liessen sich sonst `segments` oder `human_edited` schieben und der
  // Segment-Pfad umgehen. Kommt ein Feld dazu (Issue #112), wird der Typ erweitert.
  const updateDoc = useCallback((patch: Partial<Pick<EditDoc, 'context' | 'summary'>>) => {
    setDoc(d => d && ({ ...d, ...patch }))
    beruehrt()
  }, [beruehrt])

  const renameSpeaker = useCallback((from: string, to: string) => {
    if (!from || !to || from === to) return   // Guard hier, nicht im setDoc-Updater: der muss rein bleiben
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

  const save = useCallback(async () => {
    if (!doc || !project || !base) return
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
    const lauf = kette.current.then(async () => {
      /** Gilt dieser Lauf noch dem Dokument, das der Editor zeigt? */
      const meins = () => offen.current === `${project}\n${base}`
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
      } catch (e) {
        // Der Toast kommt IMMER — ein fehlgeschlagenes Speichern zu verschweigen, weil der
        // Nutzer inzwischen woanders ist, waere genau der stille Verlust. Er nennt dann die
        // Datei, sonst stuende die Meldung ohne Bezug ueber einem fremden Dokument. Die
        // Anzeige dagegen gehoert dem offenen Dokument und bleibt unberuehrt.
        if (meins()) setStand('fehler')   // `dirty` bleibt -> Rueckfragen beim Verlassen greifen
        // `instanceof`-Pruefung statt blossem `.message`: der Catch-Block darf nicht selbst
        // werfen — ein Reject mit `null` liesse sonst die Kette ablehnen (siehe unten).
        toast.error(`Speichern${meins() ? '' : ` von „${base}“`} fehlgeschlagen: `
          + (e instanceof Error ? e.message : String(e)))
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

  // `save` wandert bewusst NICHT nach draussen: es gibt keinen Speichern-Knopf mehr, und eine
  // zweite Ausloesestelle waere eine, die neben der Entprellung herlaeuft.
  return { doc, dirty, stand, loading, updateSegment, updateDoc, renameSpeaker, exportDownload, reload }
}
