import type { Segment } from './types'

export const PAD = { in: 0.15, out: 0.35 }

export function playWindow(seg: { start: number; end: number }, duration: number) {
  const from = Math.max(0, seg.start - PAD.in)
  const end = seg.end + PAD.out
  return { from, to: Number.isFinite(duration) ? Math.min(duration, end) : end }
}

/** Sprungweite pro Ctrl+←/→. Zwei Sekunden ist die Faustregel aus der Transkriptionsarbeit:
 *  lang genug fuer ein verschlucktes Wort, kurz genug, um nicht den Satz zu verlieren. */
export const SKIP = 2

/** Das zuletzt angespielte Stueck. `segId` ist null nach einem ganzen Redebeitrag. */
export type Fenster = { from: number; to: number; segId: number | null }

export type Aktion =
  | { art: 'pause' }
  /** play(undefined, to) — Position bleibt, Grenze wird (falls gesetzt) neu scharf gestellt. */
  | { art: 'weiter'; to?: number }
  /** play(from, to) — an eine andere Stelle springen. */
  | { art: 'fenster'; from: number; to: number; segId: number }

/** Was Ctrl+Space als Naechstes tun soll.
 *
 *  Reihenfolge ist der ganze Witz: ein *anderes* Segment schlaegt das Fortsetzen (Regel 2 vor 3),
 *  sonst liesse sich eine Stelle nie gezielt nochmal hoeren. Verglichen wird die Segment-ID und
 *  nicht das Zeitfenster — playWindow rechnet Fliesskomma, ein Gleichheitstest darauf waere eine
 *  Wanze, die erst bei irgendeinem krummen Zeitstempel zubeisst. */
export function naechsteAktion(z: {
  laeuft: boolean
  fenster: Fenster | null
  zeit: number
  segment: Segment | null
  dauer: number
}): Aktion {
  if (z.laeuft) return { art: 'pause' }
  if (z.segment && z.segment.id !== z.fenster?.segId) {
    const { from, to } = playWindow(z.segment, z.dauer)
    return { art: 'fenster', from, to, segId: z.segment.id }
  }
  // Ausserhalb des Fensters heisst: jemand hat herausgespult. Dann gilt die Grenze nicht mehr,
  // sonst hielte das Fortsetzen sofort wieder an.
  if (z.fenster && z.zeit >= z.fenster.from && z.zeit < z.fenster.to) {
    return { art: 'weiter', to: z.fenster.to }
  }
  return { art: 'weiter' }
}

export function skipZiel(zeit: number, sekunden: number, dauer: number) {
  const ziel = Math.max(0, zeit + sekunden)
  return Number.isFinite(dauer) ? Math.min(dauer, ziel) : ziel
}

/** Welches Segment gemeint ist: beim Tippen steckt die Textarea im Segment-Div, sonst gilt das
 *  hervorgehobene. `data-seg-id` rendert SegmentView bereits, Transcript.tsx liest es genauso. */
export function segIdAusFokus(el: Element | null | undefined, fallback: number | null): number | null {
  const roh = el?.closest('[data-seg-id]')?.getAttribute('data-seg-id')
  const id = roh == null ? NaN : Number(roh)
  return Number.isFinite(id) ? id : fallback
}
