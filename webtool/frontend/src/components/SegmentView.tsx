import { useState } from 'react'
import type { Segment, Thresholds } from '@/lib/types'
import { isCorrected, tokenizeUncertain } from '@/lib/uncertainty'
import { UncertainWord } from './UncertainWord'
import { SegmentEditor } from './SegmentEditor'

function fmt(t: number) { const s = Math.max(0, t | 0); return `${(s / 60) | 0}:${String(s % 60).padStart(2, '0')}` }

export function SegmentView({ seg, thr, active, onPlay, updateSegment }: {
  seg: Segment; thr: Thresholds; active: boolean; onPlay: () => void;
  updateSegment: (id: number, patch: Partial<Segment>) => void;
}) {
  const [editing, setEditing] = useState(false)
  const flags = [seg.flags.hallucination && '⚠', seg.flags.silence && '🔇', seg.flags.low_conf && '~'].filter(Boolean).join(' ')
  const body = !isCorrected(seg)
    ? tokenizeUncertain(seg, thr).map((t, i) => t.cls
        ? <UncertainWord key={i} word={seg.words[i]} cls={t.cls} />
        : <span key={i}>{t.text}</span>)
    : seg.text
  return (
    <div className={`group relative rounded px-2 py-1 ${active ? 'bg-primary/10' : ''}`}>
      <button onClick={onPlay} title="Abspielen"
        className="absolute -left-5 top-1.5 opacity-0 group-hover:opacity-100 text-primary text-xs">▶</button>
      <span className="mr-2 align-top text-[10px] text-muted-foreground select-none">{fmt(seg.start)} {flags}</span>
      {editing
        ? <SegmentEditor initial={seg.text}
            onCommit={t => { updateSegment(seg.id, { text: t }); setEditing(false) }}
            onCancel={() => setEditing(false)} />
        : <span onClick={() => setEditing(true)} className="cursor-text leading-relaxed">{body}</span>}
    </div>
  )
}
