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
  const [showRaw, setShowRaw] = useState(false)
  const corrected = isCorrected(seg)
  const flags = [seg.flags.hallucination && '⚠', seg.flags.silence && '🔇', seg.flags.low_conf && '~'].filter(Boolean).join(' ')
  const rawTokens = tokenizeUncertain(seg, thr).map((t, i) => t.cls
    ? <UncertainWord key={i} word={seg.words[i]} cls={t.cls} />
    : <span key={i}>{t.text}</span>)
  const body = corrected ? seg.text : rawTokens
  const focusRing = 'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 rounded-sm'
  return (
    <div data-seg-id={seg.id} className={`group relative rounded px-2 py-1 ${active ? 'bg-primary/15 ring-2 ring-inset ring-primary/60' : ''}`}>
      <button onClick={onPlay} title="Abspielen"
        className={`absolute -left-5 top-1.5 opacity-60 group-hover:opacity-100 text-primary text-xs ${focusRing}`}>▶</button>
      {/* Zeitmarke in der Mono: gleiche Ziffernbreite, damit die Marken untereinander
          eine Spalte bilden statt zu tanzen. */}
      <span className="mr-2 select-none align-top font-mono text-[11px] tabular-nums text-muted-foreground">{fmt(seg.start)} {flags}</span>
      {editing
        ? <SegmentEditor initial={seg.text}
            onCommit={t => { updateSegment(seg.id, { text: t }); setEditing(false) }}
            onCancel={() => setEditing(false)} />
        : <span onClick={() => setEditing(true)} className="lesesatz cursor-text">{body}</span>}
      {corrected &&
        <button onClick={() => setShowRaw(v => !v)} title="Roh-Wörter anzeigen"
          className={`ml-1.5 align-top text-xs opacity-30 hover:opacity-100 ${showRaw ? 'opacity-100' : ''} ${focusRing}`}>🔍</button>}
      {corrected && showRaw &&
        <div className="mt-0.5 pl-1 text-xs leading-relaxed text-muted-foreground">{rawTokens}</div>}
    </div>
  )
}
