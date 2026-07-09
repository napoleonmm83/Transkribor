import type { Segment, Thresholds, Turn } from '@/lib/types'
import { SegmentView } from './SegmentView'

function color(speaker: string) { // stabile Farbe je Name (Interviewer/Befragte unterscheidbar)
  let h = 0; for (const c of speaker) h = (h * 31 + c.charCodeAt(0)) % 360
  return `oklch(0.65 0.15 ${h})`
}
export function SpeakerTurn({ turn, thr, activeId, onPlaySeg, onPlayTurn, onEdit }: {
  turn: Turn; thr: Thresholds; activeId: number | null;
  onPlaySeg: (s: Segment) => void; onPlayTurn: (segs: Segment[]) => void; onEdit: (id: number) => void;
}) {
  return (
    <div className="grid grid-cols-[150px_1fr] items-start gap-3 border-l-2 py-2 pl-3"
      style={{ borderColor: turn.speaker ? color(turn.speaker) : 'transparent' }}>
      <button onClick={() => onPlayTurn(turn.segments)} className="text-left text-sm font-semibold"
        style={{ color: turn.speaker ? color(turn.speaker) : undefined }}>
        {turn.speaker || '(kein Sprecher)'} <span className="opacity-50">▶</span>
      </button>
      <div>
        {turn.segments.map(s => (
          <SegmentView key={s.id} seg={s} thr={thr} active={activeId === s.id}
            onPlay={() => onPlaySeg(s)} onEdit={() => onEdit(s.id)} />
        ))}
      </div>
    </div>
  )
}
