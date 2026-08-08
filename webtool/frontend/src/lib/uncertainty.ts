import type { Segment } from './types'

export type Token = { text: string; cls: '' | 'u-yellow' | 'u-red' }

/**
 * Whisper-Wortwahrscheinlichkeit, ab der ein Wort markiert wird.
 *
 * Standen bis 2026-08-08 als zwei Schieber im Editor. Der Regler war eine Falle: nichts hielt
 * `ROT <= GELB` ein, und wer rot höher zog als gelb, machte den gelben Zweig unerreichbar —
 * das ganze Transkript wurde rot, und die Einstellung sah kaputt aus, weil sie es war.
 * Zwei Zahlen ohne Beschriftung, deren Wirkung man nur im Quelltext nachlesen kann, sind
 * keine Bedienung. Braucht ein Interview doch andere Werte, gehört das hierher — sichtbar
 * und einmal richtig, statt pro Nutzer neu falsch eingestellt.
 */
const GELB = 0.6
const ROT = 0.4

export function isCorrected(seg: Segment): boolean {
  return (seg.text || '').trim() !== (seg.raw_text || '').trim()
}

export function tokenizeUncertain(seg: Segment): Token[] {
  const n = seg.words.length
  return seg.words.map((w, i) => {
    const p = w.probability ?? 1
    const isEdge = i === 0 || i === n - 1
    let cls: Token['cls'] = ''
    if (p < ROT) cls = 'u-red'
    else if (!isEdge && p < GELB) cls = 'u-yellow'
    return { text: w.word, cls }
  })
}
