import { createContext, useContext, useLayoutEffect, useRef, type ReactNode } from 'react'
import type { SpeicherStand } from './useDoc'

/** Was der Editor der Huelle ueber sein offenes Dokument verraet — mehr braucht die Leiste nicht. */
export type OffenesDokument = {
  project: string
  base: string
  dirty: boolean
  /** #106: 'fehler' ist der einzige Stand, in dem die Leiste vor dem Verlassen fragt — in der
   *  Tipppause ('offen') spült useDoc den Stand beim Verlassen selbst (useEffect-Cleanup). */
  stand: SpeicherStand
  /** `useDoc.reload` — laedt das Dokument vom Server neu. */
  reload: () => void
  /** #106-Review C1/C2: destruktive Aktionen (Loeschen/Neu transkribieren/Umbenennen) rufen das
   *  VOR dem Server-Aufruf, damit der Verlassens-Flush die Datei nicht als Waise wieder aufleben laesst. */
  vergiss: () => void
}
type Bruecke = { current: OffenesDokument | null }

const Ctx = createContext<Bruecke | null>(null)

/**
 * Die Leiste navigiert, das Dokument lebt im Editor (`useDoc`) — seit die Projektnavigation in
 * die Huelle gezogen ist, sind das zwei Komponenten. Diese Bruecke bringt genau die zwei Dinge
 * zurueck, die vorher eine Funktion weiter oben standen: vor dem Wechsel nach `dirty` fragen,
 * und nach einer Einzeldatei-Korrektur `reload()` rufen.
 *
 * Ein Ref, kein State: beide Werte werden ausschliesslich im Augenblick eines Klicks gelesen,
 * nie gerendert. Als State wuerde der erste Tastendruck in einem Segment (dirty false -> true)
 * die ganze Huelle samt Projektliste neu rendern. Ein zweiter `useDoc`-Aufruf in der Leiste
 * schied ohnehin aus — der laedt dasselbe Dokument ein zweites Mal vom Server.
 */
export function EditorBrueckeProvider({ children }: { children: ReactNode }) {
  const ref = useRef<OffenesDokument | null>(null)
  return <Ctx.Provider value={ref}>{children}</Ctx.Provider>
}

function useBruecke(): Bruecke {
  const c = useContext(Ctx)
  if (!c) throw new Error('useEditorBruecke/useEditorMelden ausserhalb EditorBrueckeProvider')
  return c
}

/** Leiste-Seite: liest den Stand im Augenblick des Klicks. */
export function useEditorBruecke(): Bruecke { return useBruecke() }

/**
 * Darf die Oberflaeche den Editor JETZT verlassen? `ziel === null` heisst „irgendwohin, nur
 * nicht hierher".
 *
 * #106: nur ein FEHLGESCHLAGENES Speichern haelt auf — in der Tipppause ('offen') spuelt
 * `useDoc` den Stand beim Verlassen selbst. Auf 'fehler' tut es das ausdruecklich NICHT
 * (`useDoc.ts`, Verlassens-Flush: `standRef.current === 'fehler'` kehrt zurueck), und zwar mit
 * der Begruendung, dass hier gefragt wird. **Diese Rueckfrage IST also der Grund, warum der
 * Flush dort schweigt** — ein Weg aus dem Editor, der sie umgeht, verliert die Aenderung still.
 *
 * Die Regel steht deshalb HIER und nicht bei den Aufrufern: die Projektleiste und der Rueckweg
 * im Editorkopf stellen dieselbe Frage, und zwei Fassungen davon laufen auseinander.
 *
 * Sie nimmt den ZUSTAND, nicht die Bruecke. Die Leiste hat nur die Bruecke (`editor.current`),
 * der Editor hat seine Werte direkt aus dem Render — und die Bruecke haengt dort um einen
 * passiven Effekt hinterher. Wer im Editor ueber die Bruecke fragte, bekaeme im ersten
 * Augenblick nach einem Standwechsel noch den vorigen Stand.
 */
export function darfWechseln(
  offen: Pick<OffenesDokument, 'project' | 'base' | 'stand'> | null,
  ziel: { project: string; base: string } | null,
): boolean {
  if (!offen || offen.stand !== 'fehler') return true
  if (ziel && ziel.project === offen.project && ziel.base === offen.base) return true   // dieselbe Datei
  return window.confirm('Ungespeicherte Änderungen verwerfen?')
}

/**
 * Editor-Seite: meldet an, solange der Editor auf dem Schirm steht (`null` = kein Dokument).
 *
 * Absichtlich OHNE Dep-Array: `dirty` und `reload` aendern sich waehrend der Sitzung, und der
 * Ref muss bei JEDEM Render den frischen Stand tragen. Ein vergessener Eintrag in einem Array
 * waere ein veralteter `dirty`-Wert — also genau der stille Datenverlust, gegen den es geht.
 *
 * `useLayoutEffect`, nicht `useEffect`: der laeuft synchron im Commit, ein passiver Effekt
 * dagegen ueber den Scheduler. Dazwischen liegt ein Fenster, in dem der Ref noch den Stand des
 * VORIGEN Renders traegt — klickt die Leiste genau darin, liest `darfWechseln` ein `stand`, das
 * nicht mehr gilt, und laesst den Wechsel ohne Rueckfrage durch, waehrend der Verlassens-Flush
 * in `useDoc` auf 'fehler' bewusst nicht schreibt. Dasselbe Muster und derselbe Grund wie bei
 * `offen` in `useDoc.ts` und `notizJetzt` in `SegmentView.tsx`. Der Unterschied laesst sich
 * nicht rot bekommen (RTLs `act` spuelt passive Effekte ohnehin) — das Argument ist der
 * Mechanismus, nicht ein Testlauf. Gemeldet vom CodeRabbit-Bot (major) an PR #617.
 */
export function useEditorMelden(offen: OffenesDokument | null) {
  const ref = useBruecke()
  useLayoutEffect(() => {
    ref.current = offen
    return () => { ref.current = null }
  })
}
