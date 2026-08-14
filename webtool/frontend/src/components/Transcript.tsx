import { useEffect, useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { EditDoc, Segment } from '@/lib/types'
import { groupIntoTurns } from '@/lib/grouping'
import type { TrefferOrt } from '@/hooks/useSuche'
import { SpeakerTurn } from './SpeakerTurn'
import { DokumentFeld } from './DokumentFeld'
import { Anmerkungen } from './Anmerkungen'

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
  updateDoc: (patch: Partial<Pick<EditDoc, 'context' | 'summary' | 'annotations'>>) => void;
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
        {/* Die Selbstheilung ist richtig (sonst waere die Aufnahme gar nicht mehr zu oeffnen),
            aber sie darf nicht schweigen: was hier steht, ist das Rohtranskript — ohne die
            Korrekturen und Sprechernamen, an denen jemand gearbeitet hat. Ohne den Hinweis
            haelt er es fuer seine Fassung (#197). */}
        {doc.selbstgeheilt && (
          <div className="mb-8 rounded-lg border border-amber-500/50 bg-amber-500/10 p-4 text-sm">
            <span className="font-medium">Deine gespeicherte Fassung war nicht lesbar.</span>{' '}
            Du siehst das Rohtranskript — Korrekturen, Sprechernamen und Anmerkungen daraus
            fehlen. Überschrieben wird die beschädigte Datei nicht: sie liegt als{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono break-all">{doc.base}.edit.json.kaputt</code>{' '}
            im Transkripte-Ordner, sobald du hier etwas speicherst.
          </div>
        )}
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
        <Anmerkungen items={doc.annotations} onChange={annotations => updateDoc({ annotations })}
          aktivIndex={aktivOrt?.kind === 'annotation' ? aktivOrt.index : null}
          sucheAktiv={sucheAktiv} treffer={annotTreffer} />
      </div>
    </ScrollArea>
  )
}
