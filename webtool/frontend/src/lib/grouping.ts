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

/**
 * Ersetzt `from` als GANZES Wort. Die Grenzen sind Lookarounds auf Buchstabe/Ziffer statt `\b`:
 * JS' `\b` ist ASCII-basiert, bei einem Namen mit Umlaut am Rand („Ürsli“) greift es an der
 * falschen Stelle. Der Name wird maskiert — er darf Punkte und Klammern tragen („Dr. Meier“).
 */
function ersetzeWort(text: string, from: string, to: string): string {
  const maskiert = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${maskiert}(?![\\p{L}\\p{N}])`, 'gu'), to)
}

/** Benennt EINEN Sprecher im ganzen Dokument um — der Name ist die Identitaet, nicht das Segment.
 *  `from` muss gesetzt sein: alle unbenannten Segmente auf einen Schlag zu benennen wuerde in einem
 *  Interview auch die Fragen des Interviewers umschreiben. Ist `to` schon vergeben, verschmelzen
 *  die beiden Sprecher (gewollt: so raeumt man eine doppelt vergebene Person auf).
 *
 *  „Im ganzen Dokument“ heisst: ueberall, wo das Dokument den Namen NENNT — auch in Kontext,
 *  Zusammenfassung, Anmerkungen und Segment-Notizen. Die kamen frueher nicht mit, und weil
 *  `render_md` Kontext und Zusammenfassung ganz nach OBEN stellt, trug der Export den alten
 *  Namen in den ersten zwei Absaetzen und den neuen in allen Sprecherzeilen (gefunden an
 *  einem echten Export, `01394435.md`).
 *
 *  Der gesprochene Text (`text`/`raw_text`) bleibt bewusst unberuehrt: das Transkript ist das
 *  Protokoll des Gesagten, kein Namensfeld. Wer eine Sprecherspalte umbenennt, will nicht,
 *  dass sich still fuenfzig Saetze mitaendern — dort korrigiert man Segment fuer Segment.
 */
export function renameSpeaker(doc: EditDoc, from: string, to: string): EditDoc {
  if (!from || !to || from === to) return doc
  const ersetzt = (t: string) => ersetzeWort(t, from, to)
  return {
    ...doc,
    speakers: [...new Set(doc.speakers.map(s => (s === from ? to : s)))],
    segments: doc.segments.map(s => {
      const speaker = s.speaker === from ? to : s.speaker
      const note = s.note ? ersetzt(s.note) : s.note
      // Identitaet halten, wo sich nichts aendert — sonst rendert ein Umbenennen jedes Segment neu.
      return speaker === s.speaker && note === s.note ? s : { ...s, speaker, note }
    }),
    context: ersetzt(doc.context),
    summary: doc.summary ? ersetzt(doc.summary) : doc.summary,
    annotations: doc.annotations.map(ersetzt),
  }
}
