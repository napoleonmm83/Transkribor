import { useMemo } from 'react'
import type { EditDoc } from '@/lib/types'
import { isCorrected } from '@/lib/uncertainty'

/** Ein Ort im Dokument, an dem ein Suchtreffer liegen kann. Reihenfolge wie im Editor:
 *  Kontext, Zusammenfassung (die Kopffelder oben), dann die Segmente, dann Anmerkungen. */
export type TrefferOrt =
  | { kind: 'kopf'; field: 'context' | 'summary' }
  | { kind: 'segment'; id: number }
  | { kind: 'annotation'; index: number }

/**
 * Reine Match-Logik fuer die Editor-Suche. Keine eigene State — die liegt im EditorView,
 * der Hook beantwortet nur: welche Orte (in Dokumentreihenfolge) enthalten den Treffer?
 *
 * Gesucht wird der *angezeigte* Text: korrigierte Segmente in seg.text (die bereinigte
 * Fassung, die der Nutzer vor Augen hat), unkorrigierte in seg.raw_text, dazu die Notiz am
 * Segment (#112). Kontext, Zusammenfassung und Anmerkungen sind ohnehin Klartext (Issue
 * #128). Case-insensitiv,
 * Substring; jeder Ort zaehlt einfach (nicht pro Vorkommen), genau wie ein Segment.
 *
 * `segmentTreffer` ist die Teilmenge der Segment-Ids fuer den Grey-out-Filter; die Treffer
 * im EditorView steuern dazu, welche Kopf-Felder / Anmerkungen markiert werden.
 */
export function useSuche(doc: EditDoc | null | undefined, query: string): {
  treffer: TrefferOrt[]; segmentTreffer: Set<number>
} {
  const q = query.trim().toLowerCase()
  return useMemo(() => {
    if (!q || !doc) return { treffer: [], segmentTreffer: new Set<number>() }
    const treffer: TrefferOrt[] = []
    if (doc.context?.toLowerCase().includes(q)) treffer.push({ kind: 'kopf', field: 'context' })
    if (doc.summary?.toLowerCase().includes(q)) treffer.push({ kind: 'kopf', field: 'summary' })
    const segmentTreffer = new Set<number>()
    for (const s of doc.segments) {
      // Die Notiz zaehlt zum Segment, nicht als eigener Ort: sie steht direkt darunter und
      // wird mit ihm markiert. Seit #112 ist sie sichtbar — sichtbarer Text, den die Suche
      // nicht findet, ist genau die Luecke, die #128 fuer die Kopffelder geschlossen hat.
      const txt = `${isCorrected(s) ? s.text : s.raw_text} ${s.note}`.toLowerCase()
      if (txt.includes(q)) { treffer.push({ kind: 'segment', id: s.id }); segmentTreffer.add(s.id) }
    }
    doc.annotations.forEach((a, i) => {
      if (a?.toLowerCase().includes(q)) treffer.push({ kind: 'annotation', index: i })
    })
    return { treffer, segmentTreffer }
  }, [doc, q])
}
