import { useMemo } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { EditDoc, Segment, Thresholds } from '@/lib/types'
import { groupIntoTurns } from '@/lib/grouping'
import { SpeakerTurn } from './SpeakerTurn'

export function Transcript({ doc, thr, currentTime, onPlaySeg, onPlayTurn, updateSegment }: {
  doc: EditDoc | null; thr: Thresholds; currentTime: number;
  onPlaySeg: (s: Segment) => void; onPlayTurn: (segs: Segment[]) => void;
  updateSegment: (id: number, patch: Partial<Segment>) => void;
}) {
  const turns = useMemo(() => (doc ? groupIntoTurns(doc.segments) : []), [doc])
  const activeId = useMemo(() => doc?.segments.find(s => currentTime >= s.start && currentTime < s.end)?.id ?? null, [doc, currentTime])
  const speakerOptions = useMemo(() =>
    doc ? [...new Set([...doc.speakers, ...doc.segments.map(s => s.speaker)])].filter(Boolean) : [],
    [doc])
  if (!doc) return <div className="p-8 text-center text-muted-foreground">Keine Datei geöffnet.</div>
  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-3xl p-4">
        {turns.map(t => (
          <SpeakerTurn key={t.key} turn={t} thr={thr} activeId={activeId}
            onPlaySeg={onPlaySeg} onPlayTurn={onPlayTurn}
            updateSegment={updateSegment} speakerOptions={speakerOptions} />
        ))}
        {doc.annotations.length > 0 && (
          <section className="mt-8 border-t pt-4">
            <h2 className="mb-2 text-sm font-semibold">Anmerkungen</h2>
            <ul className="list-disc pl-5 text-sm text-muted-foreground">{doc.annotations.map((a, i) => <li key={i}>{a}</li>)}</ul>
          </section>
        )}
      </div>
    </ScrollArea>
  )
}
