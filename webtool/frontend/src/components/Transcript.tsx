import { useEffect, useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { EditDoc, Segment } from '@/lib/types'
import { groupIntoTurns } from '@/lib/grouping'
import type { TrefferOrt } from '@/hooks/useSuche'
import { SpeakerTurn } from './SpeakerTurn'
import { DokumentFeld } from './DokumentFeld'

/** Zentriert ein Element im ScrollArea-Viewport — sanft, nur wenn es nicht schon sichtbar ist.
 *  Wird von Wiedergabe (activeId) und Suche (aktivOrt) genutzt. */
function scrollElInView(el: HTMLElement) {
  const vp = el.closest<HTMLElement>('[data-radix-scroll-area-viewport]')
  if (!vp) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); return }
  const r = el.getBoundingClientRect(), vr = vp.getBoundingClientRect()
  if (r.top < vr.top || r.bottom > vr.bottom) {
    vp.scrollTo({ top: vp.scrollTop + (r.top - vr.top) - (vr.height - r.height) / 2, behavior: 'smooth' })
  }
}

function scrollSegInView(contentRef: RefObject<HTMLDivElement | null>, id: number) {
  const el = contentRef.current?.querySelector<HTMLElement>(`[data-seg-id="${id}"]`)
  if (el) scrollElInView(el)
}

/** Suchtreffer anspringen — ans jeweilige Treffer-Element: Segment per data-seg-id, Kopf-
 *  feld per data-kopf, Anmerkung per data-annot. Der gelbe Ring markiert es zusätzlich. */
function scrollOrtInView(contentRef: RefObject<HTMLDivElement | null>, ort: TrefferOrt) {
  if (ort.kind === 'segment') { scrollSegInView(contentRef, ort.id); return }
  const sel = ort.kind === 'kopf' ? `[data-kopf="${ort.field}"]` : `[data-annot="${ort.index}"]`
  const el = contentRef.current?.querySelector<HTMLElement>(sel)
  if (el) scrollElInView(el)
}

const KEINE_KOPF = new Set<'context' | 'summary'>()
const KEINE_ANNOT = new Set<number>()

export function Transcript({ doc, loading, activeId, onPlaySeg, onPlayTurn, updateSegment, updateDoc, renameSpeaker, sucheAktiv = false, trefferIds, suchAktivId = null, kopfTreffer = KEINE_KOPF, annotTreffer = KEINE_ANNOT, aktivOrt = null }: {
  doc: EditDoc | null; loading?: boolean; activeId: number | null;
  onPlaySeg: (s: Segment) => void; onPlayTurn: (segs: Segment[]) => void;
  updateSegment: (id: number, patch: Partial<Segment>) => void;
  updateDoc: (patch: Partial<Pick<EditDoc, 'context' | 'summary'>>) => void;
  renameSpeaker: (from: string, to: string) => void;
  sucheAktiv?: boolean; trefferIds?: Set<number>; suchAktivId?: number | null;
  kopfTreffer?: Set<'context' | 'summary'>; annotTreffer?: Set<number>; aktivOrt?: TrefferOrt | null;
}) {
  const turns = useMemo(() => (doc ? groupIntoTurns(doc.segments) : []), [doc])
  const speakerOptions = useMemo(() =>
    doc ? [...new Set([...doc.speakers, ...doc.segments.map(s => s.speaker)])].filter(Boolean) : [],
    [doc])
  const contentRef = useRef<HTMLDivElement>(null)
  useEffect(() => { if (activeId != null) scrollSegInView(contentRef, activeId) }, [activeId])
  // Ein Such-Effekt fuer alle Treffer-Arten; eigene Abhaengigkeit, kein gemeinsamer Zustand mit
  // der Wiedergabe (keine Race) — siehe EditorView.suche.test.tsx.
  useEffect(() => { if (aktivOrt) scrollOrtInView(contentRef, aktivOrt) }, [aktivOrt])
  if (!doc) return loading
    ? <div className="p-8 text-center text-muted-foreground text-sm">lädt…</div>
    : <div className="p-8 text-center text-muted-foreground">Keine Datei geöffnet.</div>
  return (
    <ScrollArea className="h-full">
      <div ref={contentRef} className="mx-auto max-w-[calc(112px+var(--measure))] px-6 py-8">
        <section className="mb-8 space-y-5 border-b pb-5">
          <div data-kopf="context">
            <DokumentFeld titel="Kontext" wert={doc.context ?? ''} platzhalter="Kontext hinzufügen …"
              onCommit={t => updateDoc({ context: t })}
              aktiv={aktivOrt?.kind === 'kopf' && aktivOrt.field === 'context'}
              dimmen={sucheAktiv && !kopfTreffer.has('context')} />
          </div>
          <div data-kopf="summary">
            <DokumentFeld titel="Zusammenfassung" wert={doc.summary ?? ''} platzhalter="Zusammenfassung hinzufügen …"
              onCommit={t => updateDoc({ summary: t })}
              aktiv={aktivOrt?.kind === 'kopf' && aktivOrt.field === 'summary'}
              dimmen={sucheAktiv && !kopfTreffer.has('summary')} />
          </div>
        </section>
        {turns.map(t => (
          <SpeakerTurn key={t.key} turn={t} activeId={activeId}
            onPlaySeg={onPlaySeg} onPlayTurn={onPlayTurn}
            updateSegment={updateSegment} renameSpeaker={renameSpeaker} speakerOptions={speakerOptions}
            sucheAktiv={sucheAktiv} trefferIds={trefferIds} suchAktivId={suchAktivId} />
        ))}
        {doc.annotations.length > 0 && (
          <section className="mt-12 border-t pt-5">
            <h2 className="rubrik mb-3">Anmerkungen</h2>
            <ul className="lesebreite list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-muted-foreground">
              {doc.annotations.map((a, i) => {
                const aktiv = aktivOrt?.kind === 'annotation' && aktivOrt.index === i
                const dimmen = sucheAktiv && !annotTreffer.has(i)
                return <li key={i} data-annot={i}
                  className={`rounded-sm${aktiv ? ' ring-2 ring-inset ring-yellow-400 dark:ring-yellow-500' : ''}${dimmen ? ' opacity-40' : ''}`}>{a}</li>
              })}
            </ul>
          </section>
        )}
      </div>
    </ScrollArea>
  )
}
