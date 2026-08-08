import { useState } from 'react'
import { CircleHelp, Play, ScanSearch, TriangleAlert, VolumeX } from 'lucide-react'
import type { Segment, Thresholds } from '@/lib/types'
import { isCorrected, tokenizeUncertain } from '@/lib/uncertainty'
import { UncertainWord } from './UncertainWord'
import { SegmentEditor } from './SegmentEditor'

function fmt(t: number) { const s = Math.max(0, t | 0); return `${(s / 60) | 0}:${String(s % 60).padStart(2, '0')}` }

/** Die drei Segment-Flags. Als Emoji (⚠ 🔇) rendern sie je nach System in einer fremden
 *  Schrift, erben die Textfarbe nicht und heissen fuer einen Screenreader gar nichts. */
export const FLAGS = [
  { key: 'hallucination', icon: TriangleAlert, titel: 'Halluzination' },
  { key: 'silence', icon: VolumeX, titel: 'Stille' },
  { key: 'low_conf', icon: CircleHelp, titel: 'geringe Konfidenz' },
] as const

export function SegmentView({ seg, thr, active, onPlay, updateSegment }: {
  seg: Segment; thr: Thresholds; active: boolean; onPlay: () => void;
  updateSegment: (id: number, patch: Partial<Segment>) => void;
}) {
  const [editing, setEditing] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const corrected = isCorrected(seg)
  const flags = FLAGS.filter(f => seg.flags[f.key])
  const rawTokens = tokenizeUncertain(seg, thr).map((t, i) => t.cls
    ? <UncertainWord key={i} word={seg.words[i]} cls={t.cls} />
    : <span key={i}>{t.text}</span>)
  const body = corrected ? seg.text : rawTokens
  const focusRing = 'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 rounded-sm'
  return (
    <div data-seg-id={seg.id} className={`group relative rounded-md px-2 py-1 ${active ? 'bg-primary/15 ring-2 ring-inset ring-primary/60' : ''}`}>
      <button onClick={onPlay} title="Abspielen" aria-label="Segment abspielen"
        className={`absolute -left-5 top-1.5 text-primary opacity-60 transition-opacity group-hover:opacity-100 ${focusRing}`}>
        <Play className="size-3 fill-current" aria-hidden="true" />
      </button>
      {/* Zeitmarke in der Mono: gleiche Ziffernbreite, damit die Marken untereinander
          eine Spalte bilden statt zu tanzen. */}
      <span className="mr-2 select-none align-top font-mono text-[11px] tabular-nums text-muted-foreground">{fmt(seg.start)}</span>
      {flags.length > 0 && (
        <span className="mr-1.5 inline-flex select-none items-center gap-1 align-top">
          {/* Name und Tooltip am Wrapper: lucide-Icons nehmen kein title-Prop. */}
          {flags.map(f => (
            <span key={f.key} role="img" aria-label={f.titel} title={f.titel}
              className="inline-flex text-amber-600 dark:text-amber-500">
              <f.icon className="size-3" aria-hidden="true" />
            </span>
          ))}
        </span>
      )}
      {editing
        ? <SegmentEditor initial={seg.text}
            onCommit={t => { updateSegment(seg.id, { text: t }); setEditing(false) }}
            onCancel={() => setEditing(false)} />
        : <span onClick={() => setEditing(true)} className="lesesatz cursor-text">{body}</span>}
      {corrected &&
        <button onClick={() => setShowRaw(v => !v)} title="Roh-Wörter anzeigen" aria-pressed={showRaw}
          className={`ml-1.5 align-top opacity-30 transition-opacity hover:opacity-100 ${showRaw ? 'opacity-100' : ''} ${focusRing}`}>
          <ScanSearch className="inline size-3.5" aria-hidden="true" />
        </button>}
      {corrected && showRaw &&
        <div className="mt-0.5 pl-1 text-xs leading-relaxed text-muted-foreground">{rawTokens}</div>}
    </div>
  )
}
