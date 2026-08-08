import { Pencil } from 'lucide-react'
import type { FilePhase, FileState, ProjectFile } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { FileStatusPill } from '@/components/FileStatusPill'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { cn } from '@/lib/utils'

export function FileRow({ file, active, onOpen, onCorrectFile, phase, state, jobRunning, aiReason }: {
  file: ProjectFile; active: boolean;
  onOpen: () => void; onCorrectFile: (force: boolean) => void;
  phase?: FilePhase; state?: FileState; jobRunning?: boolean;
  /** Nicht leer = kein nutzbarer KI-Anbieter: Korrigieren deaktiviert, Text als Tooltip. */
  aiReason?: string;
}) {
  const button = (
    <Button size="icon" variant="ghost" className="size-6" title="Nur diese Datei korrigieren"
      aria-label="Nur diese Datei korrigieren" disabled={!!aiReason}
      onClick={e => { e.stopPropagation(); if (!file.has_edit) onCorrectFile(false) }}>
      <Pencil className="size-3" />
    </Button>
  )
  return (
    <div onClick={onOpen} role="button" tabIndex={0} aria-label={`Datei ${file.base} öffnen`}
      onKeyDown={e => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() }
      }}
      className={cn('flex items-center gap-2 rounded px-2 py-1 text-sm cursor-pointer hover:bg-accent',
        active && 'bg-accent')}>
      <span className="flex-1 truncate">{file.base}</span>
      <FileStatusPill file={file} active={phase} state={state} jobRunning={jobRunning} />
      {/* title am Wrapper: ein deaktivierter Knopf hat pointer-events:none und zeigt
          seinen eigenen Tooltip nie an. */}
      <span title={aiReason || undefined} className="inline-flex">
      {file.has_edit ? (
        <AlertDialog>
          <AlertDialogTrigger asChild>{button}</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>„{file.base}" neu korrigieren?</AlertDialogTitle>
              <AlertDialogDescription>Überschreibt die (ggf. handbearbeitete) Version.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Abbrechen</AlertDialogCancel>
              <AlertDialogAction onClick={() => onCorrectFile(true)}>Neu korrigieren</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : button}
      </span>
    </div>
  )
}
