import { Pencil } from 'lucide-react'
import type { ProjectFile } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function FileRow({ file, active, onOpen, onCorrectFile }: {
  file: ProjectFile; active: boolean;
  onOpen: () => void; onCorrectFile: () => void;
}) {
  const badge = file.has_edit ? '✎' : file.has_md ? '✓' : file.has_audio ? '●' : ''
  return (
    <div onClick={onOpen}
      className={cn('flex items-center gap-2 rounded px-2 py-1 text-sm cursor-pointer hover:bg-accent',
        active && 'bg-accent')}>
      <span className="flex-1 truncate">{file.base} <span className="text-muted-foreground text-xs">{badge}</span></span>
      <Button size="icon" variant="ghost" className="size-6" title="Nur diese Datei korrigieren"
        onClick={e => { e.stopPropagation(); onCorrectFile() }}><Pencil className="size-3" /></Button>
    </div>
  )
}
