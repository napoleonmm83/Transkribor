import { Loader2 } from 'lucide-react'
import type { FilePhase, FileState, ProjectFile } from '@/lib/types'
import { PHASE_LABEL } from '@/lib/jobPhases'

const STATE_LABEL: Record<FileState, string> = { done: 'Fertig', skipped: 'Übersprungen', failed: 'Fehler' }
const STATE_ICON: Record<FileState, string> = { done: '✓', skipped: '↷', failed: '✗' }

export function FileStatusPill({ file, active, pct, detail, state, jobRunning }: {
  file: ProjectFile; active?: FilePhase; pct?: number; detail?: string; state?: FileState; jobRunning?: boolean
}) {
  if (state) return <span className="text-xs text-muted-foreground">{STATE_ICON[state]} {STATE_LABEL[state]}</span>
  if (active) return (
    <span className="inline-flex items-center gap-1 text-xs text-primary">
      <Loader2 className="size-3 animate-spin" />
      {PHASE_LABEL[active]} {detail ?? (pct != null ? `${pct}%` : '…')}
    </span>
  )
  if (jobRunning) return <span className="text-xs text-muted-foreground">○ Wartet…</span>
  const badge = file.has_edit ? '✎' : file.has_md ? '✓' : file.has_audio ? '●' : ''
  return <span className="text-xs text-muted-foreground">{badge}</span>
}
