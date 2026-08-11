import { useMemo } from 'react'
import type { Segment } from '@/lib/types'
import { isCorrected } from '@/lib/uncertainty'

/**
 * Reine Match-Logik fuer die Editor-Suche. Keine eigene State — die liegt im EditorView,
 * der Hook beantwortet nur: welche Segmente (in Dokumentreihenfolge) enthalten den Treffer?
 *
 * Gesucht wird der *angezeigte* Text: korrigierte Segmente in seg.text (die bereinigte
 * Fassung, die der Nutzer vor Augen hat), unkorrigierte in seg.raw_text (Klartext, der
 * denselben Wortlaut ergibt wie die farbigen Token-Spans). Case-insensitiv, Substring.
 */
export function useSuche(segments: Segment[] | undefined, query: string): { ids: number[]; count: number } {
  const q = query.trim().toLowerCase()
  return useMemo(() => {
    if (!q || !segments) return { ids: [], count: 0 }
    const ids = segments
      .filter(s => (isCorrected(s) ? s.text : s.raw_text).toLowerCase().includes(q))
      .map(s => s.id)
    return { ids, count: ids.length }
  }, [segments, q])
}
