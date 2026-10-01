import { createContext, useContext } from 'react'
import type { Project, ProjectFile } from '@/lib/types'

type Projekte = { projects: Project[]; loading: boolean; fehler: boolean; refresh: () => void }
type Dateien = { projekt: string | null; files: ProjectFile[]; loading: boolean; fehler: boolean; refresh: () => void }
export const Ctx = createContext<{ projekte: Projekte; dateien: Dateien } | null>(null)

/**
 * EINE Projektliste und EINE Dateiliste fuer die ganze App.
 *
 * Vorher rief jede Seite `useProjects` selbst (vier Stellen) — solange nur eine Seite zur
 * Zeit gerendert wurde, war das ein Abruf alle 4 s. Mit der dauerhaften Seitenleiste waeren
 * es zwei parallele geworden: Leiste UND Seite. Das ist genau die Verdopplung, die die
 * Aufteilung in Zusammenfassung und Dateiliste (PR #67) abgeschafft hat.
 *
 * Die Dateiliste haengt am Projekt aus der URL, nicht an einem eigenen Zustand: das
 * aufgeklappte Projekt der Seitenleiste IST das geoeffnete. Ein zweiter Begriff von "offen"
 * waere eine zweite Wahrheit, die man synchron halten muss.
 */

// Name faengt mit "use" an, nicht "ctx": react-hooks/rules-of-hooks verlangt das von jeder
// Funktion, die selbst einen Hook (hier useContext) aufruft -- sonst ein Lint-Fehler, kein Stil.
function useCtx() {
  const c = useContext(Ctx)
  if (!c) throw new Error('useProjekte/useDateien ausserhalb ProjektDatenProvider')
  return c
}
export function useProjekte(): Projekte { return useCtx().projekte }
export function useDateien(): Dateien { return useCtx().dateien }
