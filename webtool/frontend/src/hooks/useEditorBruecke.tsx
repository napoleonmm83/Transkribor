import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react'

/** Was der Editor der Huelle ueber sein offenes Dokument verraet — mehr braucht die Leiste nicht. */
export type OffenesDokument = {
  project: string
  base: string
  dirty: boolean
  /** `useDoc.reload` — laedt das Dokument vom Server neu. */
  reload: () => void
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
 * Editor-Seite: meldet an, solange der Editor auf dem Schirm steht (`null` = kein Dokument).
 *
 * Absichtlich OHNE Dep-Array: `dirty` und `reload` aendern sich waehrend der Sitzung, und der
 * Ref muss bei JEDEM Render den frischen Stand tragen. Ein vergessener Eintrag in einem Array
 * waere ein veralteter `dirty`-Wert — also genau der stille Datenverlust, gegen den es geht.
 */
export function useEditorMelden(offen: OffenesDokument | null) {
  const ref = useBruecke()
  useEffect(() => {
    ref.current = offen
    return () => { ref.current = null }
  })
}
