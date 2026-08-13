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
 * Bringt Suchtext und Dokumenttext auf EINE Schreibweise (Issue #127).
 *
 * Schweizerdeutsche Transkripte sind voller Umlaute, und die Schreibweise wechselt — mal
 * „Bühler“, mal „Buehler“; wer das eine tippt, meint das andere. Gefaltet wird auf die
 * **Digraphen** (ü→ue), nicht auf den nackten Vokal (ü→u): der Umweg „ue“ ist die Schreibweise,
 * die tatsaechlich in den Dateien steht, „u“ dagegen niemandes Absicht.
 *
 * Reihenfolge ist Pflicht: erst `NFC` (ein zerlegtes „u+ ̈“ aus einer fremden Quelle wird wieder
 * zu „ü“, sonst griffe die Ersetzung daneben), dann die deutschen Digraphen, **danach** `NFD` +
 * Markenschnitt fuer alles Uebrige — é, à, ç aus franzoesischen und italienischen Namen, die in
 * gemischtsprachigen Projekten vorkommen. Andersherum waere „ü“ vor der Ersetzung schon zu „u“
 * zerfallen und die Digraphen-Regel liefe leer.
 *
 * `ß`→`ss` faellt dabei ab: die Schweiz schreibt ohnehin `ss`, ein importiertes „Straße“ ist
 * damit ueber „Strasse“ zu finden.
 *
 * **Preis, bewusst bezahlt:** die Faltung ist nicht umkehrbar, „ü“ als Suchwort trifft jetzt
 * auch das „ue“ in „Steuer“. Bei einer Substring-Suche ohne Wortgrenzen ist das kein neuer
 * Fehlerfall, sondern derselbe wie bei jedem kurzen Suchwort.
 */
export function falte(s: string): string {
  return s.normalize('NFC').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/\p{M}/gu, '')
}

/**
 * Reine Match-Logik fuer die Editor-Suche. Keine eigene State — die liegt im EditorView,
 * der Hook beantwortet nur: welche Orte (in Dokumentreihenfolge) enthalten den Treffer?
 *
 * Gesucht wird der *angezeigte* Text: korrigierte Segmente in seg.text (die bereinigte
 * Fassung, die der Nutzer vor Augen hat), unkorrigierte in seg.raw_text, dazu die Notiz am
 * Segment (#112). Kontext, Zusammenfassung und Anmerkungen sind ohnehin Klartext (Issue
 * #128). Verglichen wird gefaltet (`falte`, #127), Substring; jeder Ort zaehlt einfach
 * (nicht pro Vorkommen), genau wie ein Segment.
 *
 * `segmentTreffer` ist die Teilmenge der Segment-Ids fuer den Grey-out-Filter; die Treffer
 * im EditorView steuern dazu, welche Kopf-Felder / Anmerkungen markiert werden.
 */
export function useSuche(doc: EditDoc | null | undefined, query: string): {
  treffer: TrefferOrt[]; segmentTreffer: Set<number>
} {
  // Das Dokument wird EINMAL je Dokument gefaltet, nicht je Tastendruck im Suchfeld: `falte`
  // laeuft sechsmal ueber jeden Text, und bei 400 Segmenten waere das pro getipptem Zeichen
  // eine Runde ueber das ganze Transkript. Der Vergleich unten bleibt ohnehin O(Dokument) —
  // gespart wird die Normalisierung, nicht der Durchlauf.
  const gefaltet = useMemo(() => doc && {
    context: falte(doc.context ?? ''),
    summary: falte(doc.summary ?? ''),
    // Die Notiz zaehlt zum Segment, nicht als eigener Ort: sie steht direkt darunter und wird
    // mit ihm markiert. Seit #112 ist sie sichtbar — sichtbarer Text, den die Suche nicht
    // findet, ist genau die Luecke, die #128 fuer die Kopffelder geschlossen hat.
    // `s.note ?? ''`: der Typ verspricht einen String, die Platte haelt sich nicht daran —
    // `save_file` schreibt jedes JSON, das ankommt, und `render_md.py` liest das Feld
    // seinerseits mit `(s.get("note") or "")`. Ohne den Rueckfall stuende bei fehlendem
    // Schluessel das Wort „undefined“ im Suchtext JEDES Segments, und eine Suche nach „undef“
    // faerbte das ganze Transkript als Treffer.
    segmente: doc.segments.map(s => ({ id: s.id, txt: falte(`${isCorrected(s) ? s.text : s.raw_text} ${s.note ?? ''}`) })),
    annotationen: doc.annotations.map(a => falte(a ?? '')),
  }, [doc])

  const q = falte(query.trim())
  return useMemo(() => {
    if (!q || !gefaltet) return { treffer: [], segmentTreffer: new Set<number>() }
    const treffer: TrefferOrt[] = []
    if (gefaltet.context.includes(q)) treffer.push({ kind: 'kopf', field: 'context' })
    if (gefaltet.summary.includes(q)) treffer.push({ kind: 'kopf', field: 'summary' })
    const segmentTreffer = new Set<number>()
    for (const s of gefaltet.segmente) {
      if (s.txt.includes(q)) { treffer.push({ kind: 'segment', id: s.id }); segmentTreffer.add(s.id) }
    }
    gefaltet.annotationen.forEach((a, i) => {
      if (a.includes(q)) treffer.push({ kind: 'annotation', index: i })
    })
    return { treffer, segmentTreffer }
  }, [gefaltet, q])
}
