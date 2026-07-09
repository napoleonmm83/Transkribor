import type { Segment, Thresholds } from './types'

export type Token = { text: string; cls: '' | 'u-yellow' | 'u-red' }

export function isCorrected(seg: Segment): boolean {
  return (seg.text || '').trim() !== (seg.raw_text || '').trim()
}

export function tokenizeUncertain(seg: Segment, thr: Thresholds): Token[] {
  return seg.words.map((w, i) => {
    const p = w.probability ?? 1
    const isEdge = i === 0  // Only first word is edge (speaker start boundary)
    let cls: Token['cls'] = ''
    if (p < thr.red) cls = 'u-red'
    else if (!isEdge && p < thr.yellow) cls = 'u-yellow'
    return { text: w.word, cls }
  })
}
