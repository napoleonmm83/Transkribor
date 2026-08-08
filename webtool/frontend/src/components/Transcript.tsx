import { useEffect, useMemo, useRef } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { EditDoc, Segment, Thresholds } from '@/lib/types'
import { groupIntoTurns } from '@/lib/grouping'
import { SpeakerTurn } from './SpeakerTurn'

export function Transcript({ doc, loading, thr, activeId, onPlaySeg, onPlayTurn, updateSegment, renameSpeaker }: {
  doc: EditDoc | null; loading?: boolean; thr: Thresholds; activeId: number | null;
  onPlaySeg: (s: Segment) => void; onPlayTurn: (segs: Segment[]) => void;
  updateSegment: (id: number, patch: Partial<Segment>) => void;
  renameSpeaker: (from: string, to: string) => void;
}) {
  const turns = useMemo(() => (doc ? groupIntoTurns(doc.segments) : []), [doc])
  const speakerOptions = useMemo(() =>
    doc ? [...new Set([...doc.speakers, ...doc.segments.map(s => s.speaker)])].filter(Boolean) : [],
    [doc])
  const contentRef = useRef<HTMLDivElement>(null)
  // Aktives Segment bei Wechsel (z.B. Waveform-Klick) smooth in den Viewport holen —
  // nur wenn es nicht ohnehin sichtbar ist, sonst ruckelt es während der Wiedergabe.
  useEffect(() => {
    if (activeId == null) return
    const el = contentRef.current?.querySelector<HTMLElement>(`[data-seg-id="${activeId}"]`)
    if (!el) return
    const vp = el.closest<HTMLElement>('[data-radix-scroll-area-viewport]')
    if (!vp) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); return }
    const r = el.getBoundingClientRect(), vr = vp.getBoundingClientRect()
    if (r.top < vr.top || r.bottom > vr.bottom) {
      vp.scrollTo({ top: vp.scrollTop + (r.top - vr.top) - (vr.height - r.height) / 2, behavior: 'smooth' })
    }
  }, [activeId])
  if (!doc) return loading
    ? <div className="p-8 text-center text-muted-foreground text-sm">lädt…</div>
    : <div className="p-8 text-center text-muted-foreground">Keine Datei geöffnet.</div>
  return (
    <ScrollArea className="h-full">
      {/* Lesebreite statt Fensterbreite: die Sprecherspalte ist 112px breit, der Rest bleibt
          fuer den Satz — auf einem breiten Monitor liefen die Zeilen sonst auf 120 Zeichen.
          Muss mit grid-cols in SpeakerTurn uebereinstimmen. */}
      <div ref={contentRef} className="mx-auto max-w-[calc(112px+var(--measure))] px-6 py-8">
        {/* Vor dem Transkript, nicht danach: die Zusammenfassung beantwortet "worum geht es
            hier", und diese Frage stellt man beim Oeffnen, nicht nach 400 Segmenten. */}
        {doc.summary?.trim() && (
          <section className="mb-8 border-b pb-5">
            <h2 className="rubrik mb-3">Zusammenfassung</h2>
            <p className="lesebreite text-sm leading-relaxed text-muted-foreground">{doc.summary}</p>
          </section>
        )}
        {turns.map(t => (
          <SpeakerTurn key={t.key} turn={t} thr={thr} activeId={activeId}
            onPlaySeg={onPlaySeg} onPlayTurn={onPlayTurn}
            updateSegment={updateSegment} renameSpeaker={renameSpeaker} speakerOptions={speakerOptions} />
        ))}
        {doc.annotations.length > 0 && (
          <section className="mt-12 border-t pt-5">
            <h2 className="rubrik mb-3">Anmerkungen</h2>
            <ul className="lesebreite list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-muted-foreground">{doc.annotations.map((a, i) => <li key={i}>{a}</li>)}</ul>
          </section>
        )}
      </div>
    </ScrollArea>
  )
}
