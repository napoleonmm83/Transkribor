import type { Segment, Thresholds, Turn } from '@/lib/types'
import { SegmentView } from './SegmentView'
import { SpeakerCombobox } from './SpeakerCombobox'

function color(speaker: string) { // stabile Farbe je Name (Interviewer/Befragte unterscheidbar)
  let h = 0; for (const c of speaker) h = (h * 31 + c.charCodeAt(0)) % 360
  return `oklch(0.65 0.15 ${h})`
}
export function SpeakerTurn({ turn, thr, activeId, onPlaySeg, onPlayTurn, updateSegment, speakerOptions }: {
  turn: Turn; thr: Thresholds; activeId: number | null;
  onPlaySeg: (s: Segment) => void; onPlayTurn: (segs: Segment[]) => void;
  updateSegment: (id: number, patch: Partial<Segment>) => void; speakerOptions: string[];
}) {
  return (
    <div className="grid grid-cols-[150px_1fr] items-start gap-3 border-l-2 py-2 pl-3"
      style={{ borderColor: turn.speaker ? color(turn.speaker) : 'transparent' }}>
      <button onClick={() => onPlayTurn(turn.segments)}
        className="rounded-sm text-left text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        style={{ color: turn.speaker ? color(turn.speaker) : undefined }}>
        {turn.speaker || '(kein Sprecher)'} <span className="opacity-50">▶</span>
      </button>
      <div>
        {turn.segments.map(s => (
          <div key={s.id} className="group">
            <SpeakerCombobox value={s.speaker} options={speakerOptions}
              onChange={v => updateSegment(s.id, { speaker: v })}
              className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100" />
            <SegmentView seg={s} thr={thr} active={activeId === s.id}
              onPlay={() => onPlaySeg(s)} updateSegment={updateSegment} />
          </div>
        ))}
      </div>
    </div>
  )
}
