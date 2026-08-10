import type { FilePhase, FileState, ProjectFile } from '@/lib/types'
import { DateiMenue } from '@/components/DateiMenue'
import { FileStatusPill } from '@/components/FileStatusPill'
import { cn } from '@/lib/utils'

export function FileRow({ project, file, active, onOpen, phase, state, jobRunning, aiReason }: {
  project: string; file: ProjectFile; active: boolean;
  onOpen: () => void;
  phase?: FilePhase; state?: FileState; jobRunning?: boolean;
  /** Nicht leer = kein nutzbarer KI-Anbieter: Korrigieren deaktiviert, Text als Tooltip. */
  aiReason?: string;
}) {
  return (
    <div onClick={onOpen} role="button" tabIndex={0} aria-label={`Datei ${file.base} öffnen`}
      onKeyDown={e => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() }
      }}
      className={cn('flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm',
        'transition-colors hover:bg-muted/60 outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active && 'bg-accent text-accent-foreground hover:bg-accent')}>
      <span className="min-w-0 flex-1 truncate">{file.base}</span>
      <FileStatusPill file={file} active={phase} state={state} jobRunning={jobRunning} />
      <DateiMenue project={project} file={file} aiReason={aiReason} />
    </div>
  )
}
