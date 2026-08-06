import type { EditDoc, Segment, Turn } from './types'

export function groupIntoTurns(segments: Segment[]): Turn[] {
  const turns: Turn[] = []
  for (const s of segments) {
    const last = turns[turns.length - 1]
    if (last && last.speaker === s.speaker) last.segments.push(s)
    else turns.push({ key: `turn-${s.id}`, speaker: s.speaker, segments: [s] })
  }
  return turns
}

/** Benennt EINEN Sprecher im ganzen Dokument um — der Name ist die Identitaet, nicht das Segment.
 *  `from` muss gesetzt sein: alle unbenannten Segmente auf einen Schlag zu benennen wuerde in einem
 *  Interview auch die Fragen des Interviewers umschreiben. Ist `to` schon vergeben, verschmelzen
 *  die beiden Sprecher (gewollt: so raeumt man eine doppelt vergebene Person auf). */
export function renameSpeaker(doc: EditDoc, from: string, to: string): EditDoc {
  if (!from || !to || from === to) return doc
  return {
    ...doc,
    speakers: [...new Set(doc.speakers.map(s => (s === from ? to : s)))],
    segments: doc.segments.map(s => (s.speaker === from ? { ...s, speaker: to } : s)),
  }
}
