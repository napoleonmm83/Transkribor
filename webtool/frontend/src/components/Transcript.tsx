import { useEffect, useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { EditDoc, Segment } from '@/lib/types'
import { groupIntoTurns } from '@/lib/grouping'
import { SpeakerTurn } from './SpeakerTurn'
import { DokumentFeld } from './DokumentFeld'

/** Holt ein Segment anhand seiner data-seg-id in den ScrollArea-Viewport — sanft, nur wenn
 *  es nicht schon sichtbar ist. Wird von Wiedergabe (activeId) und Suche (suchAktivId)
 *  genutzt; zwei Effekte, je eigener Trigger, keine Race. */
function scrollSegInView(contentRef: RefObject<HTMLDivElement | null>, id: number) {
  const el = contentRef.current?.querySelector<HTMLElement>(`[data-seg-id="${id}"]`)
  if (!el) return
  const vp = el.closest<HTMLElement>('[data-radix-scroll-area-viewport]')
  if (!vp) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); return }
  const r = el.getBoundingClientRect(), vr = vp.getBoundingClientRect()
  if (r.top < vr.top || r.bottom > vr.bottom) {
    vp.scrollTo({ top: vp.scrollTop + (r.top - vr.top) - (vr.height - r.height) / 2, behavior: 'smooth' })
  }
}

export function Transcript({ doc, loading, activeId, onPlaySeg, onPlayTurn, updateSegment, updateDoc, renameSpeaker, sucheAktiv = false, trefferIds, suchAktivId = null }: {
  doc: EditDoc | null; loading?: boolean; activeId: number | null;
  onPlaySeg: (s: Segment) => void; onPlayTurn: (segs: Segment[]) => void;
  updateSegment: (id: number, patch: Partial<Segment>) => void;
  updateDoc: (patch: Partial<Pick<EditDoc, 'context' | 'summary'>>) => void;
  renameSpeaker: (from: string, to: string) => void;
  sucheAktiv?: boolean; trefferIds?: Set<number>; suchAktivId?: number | null;
}) {
  const turns = useMemo(() => (doc ? groupIntoTurns(doc.segments) : []), [doc])
  const speakerOptions = useMemo(() =>
    doc ? [...new Set([...doc.speakers, ...doc.segments.map(s => s.speaker)])].filter(Boolean) : [],
    [doc])
  const contentRef = useRef<HTMLDivElement>(null)
  // Aktives Segment bei Wechsel (z.B. Waveform-Klick) smooth in den Viewport holen —
  // nur wenn es nicht ohnehin sichtbar ist, sonst ruckelt es während der Wiedergabe.
  useEffect(() => { if (activeId != null) scrollSegInView(contentRef, activeId) }, [activeId])
  // Zweiter, unabhängiger Trigger: der aktive Suchtreffer springt beim ▲▽-Blättern —
  // eigene Abhängigkeit, kein gemeinsamer Zustand mit der Wiedergabe (keine Race).
  useEffect(() => { if (suchAktivId != null) scrollSegInView(contentRef, suchAktivId) }, [suchAktivId])
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
            hier", und diese Frage stellt man beim Oeffnen, nicht nach 400 Segmenten.
            Der Kontext stand hier lange NICHT — obwohl `render_md` ihn als ersten Absatz
            exportiert. Ein Feld, das im Export steht und im Editor nicht, ist eines, dessen
            Fehler niemand sieht: genau so ging ein alter Sprechername mit hinaus. Reihenfolge
            wie im Markdown, damit Bildschirm und Datei dasselbe Dokument zeigen.
            Beide Rubriken stehen AUCH leer da: frisch transkribiert und noch nicht korrigiert
            sind sie es immer, und ein verstecktes Feld laesst sich nie fuellen. */}
        <section className="mb-8 space-y-5 border-b pb-5">
          <DokumentFeld titel="Kontext" wert={doc.context ?? ''} platzhalter="Kontext hinzufügen …"
            onCommit={t => updateDoc({ context: t })} />
          <DokumentFeld titel="Zusammenfassung" wert={doc.summary ?? ''} platzhalter="Zusammenfassung hinzufügen …"
            onCommit={t => updateDoc({ summary: t })} />
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
            <ul className="lesebreite list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-muted-foreground">{doc.annotations.map((a, i) => <li key={i}>{a}</li>)}</ul>
          </section>
        )}
      </div>
    </ScrollArea>
  )
}
