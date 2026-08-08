import { Play } from 'lucide-react'
import type { Segment, Thresholds, Turn } from '@/lib/types'
import { SegmentView } from './SegmentView'
import { SpeakerCombobox } from './SpeakerCombobox'

function color(speaker: string) { // stabile Farbe je Name (Interviewer/Befragte unterscheidbar)
  let h = 0; for (const c of speaker) h = (h * 31 + c.charCodeAt(0)) % 360
  return `oklch(0.65 0.15 ${h})`
}
export function SpeakerTurn({ turn, thr, activeId, onPlaySeg, onPlayTurn, updateSegment, renameSpeaker, speakerOptions }: {
  turn: Turn; thr: Thresholds; activeId: number | null;
  onPlaySeg: (s: Segment) => void; onPlayTurn: (segs: Segment[]) => void;
  updateSegment: (id: number, patch: Partial<Segment>) => void;
  renameSpeaker: (from: string, to: string) => void; speakerOptions: string[];
}) {
  return (
    // 112px statt 150px: die Spalte traegt eine 11px-Versalzeile ("INTERVIEWER" misst gut
    // 80px). Die ueberzaehlige Breite stand als Loch zwischen Name und Text und schob den
    // ganzen Satzspiegel nach rechts aus der Mitte.
    <div className="grid grid-cols-[112px_1fr] items-start gap-2 border-l-2 py-2 pl-3"
      style={{ borderColor: turn.speaker ? color(turn.speaker) : 'transparent' }}>
      <div className="flex items-center">
        {/* Der Name ist die Sprecher-IDENTITAET -> umbenennen wirkt im ganzen Dokument.
            Ohne Namen kein Umbenennen: ein unbenannter Turn umfasst hier schnell hunderte
            Segmente (groupIntoTurns bündelt alle aufeinanderfolgenden ''), und die gehören
            im Interview zu beiden Sprechern. Einzeln zuweisen geht per Segment-Combobox. */}
        {turn.speaker
          ? <SpeakerCombobox value={turn.speaker} options={speakerOptions}
              onChange={v => renameSpeaker(turn.speaker, v)}
              title="Sprecher im ganzen Transkript umbenennen"
              style={{ color: color(turn.speaker) }}
              className="rubrik h-auto min-w-0 truncate px-0 text-left hover:bg-transparent" />
          : <span className="rubrik truncate">(kein Sprecher)</span>}
        <button onClick={() => onPlayTurn(turn.segments)} title="Redebeitrag abspielen"
          aria-label="Redebeitrag abspielen"
          className="ml-1 shrink-0 rounded-sm px-1 opacity-50 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
          <Play className="size-3 fill-current" aria-hidden="true" />
        </button>
      </div>
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
