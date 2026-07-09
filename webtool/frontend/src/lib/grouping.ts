import type { Segment, Turn } from './types'

export function groupIntoTurns(segments: Segment[]): Turn[] {
  const turns: Turn[] = []
  for (const s of segments) {
    const last = turns[turns.length - 1]
    if (last && last.speaker === s.speaker) last.segments.push(s)
    else turns.push({ key: `turn-${s.id}`, speaker: s.speaker, segments: [s] })
  }
  return turns
}
