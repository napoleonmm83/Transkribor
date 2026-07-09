import type { Segment, Thresholds } from './types'

export type Token = { text: string; cls: '' | 'u-yellow' | 'u-red' }

export function isCorrected(seg: Segment): boolean {
  return (seg.text || '').trim() !== (seg.raw_text || '').trim()
}

export function tokenizeUncertain(seg: Segment, thr: Thresholds): Token[] {
  const n = seg.words.length
  return seg.words.map((w, i) => {
    const p = w.probability ?? 1
    const isEdge = i === 0 || i === n - 1
    let cls: Token['cls'] = ''
    if (p < thr.red) cls = 'u-red'
    else if (!isEdge && p < thr.yellow) cls = 'u-yellow'
    return { text: w.word, cls }
  })
}
