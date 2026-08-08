import { useRef } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Upload, Play, Pencil } from 'lucide-react'
import type { JobPhases, Project } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { FileRow } from './FileRow'

type Sel = { project: string; base: string } | null
export function Sidebar({ projects, loading, active, onOpen, onUpload, onTranscribe, onCorrect, onCorrectFile, backTo, phases, jobRunning, aiReason }: {
  projects: Project[]; loading?: boolean; active: Sel;
  onOpen: (s: { project: string; base: string }) => void;
  onUpload: (project: string, file: File) => void;
  onTranscribe: (project: string) => void;
  onCorrect: (project: string) => void;
  onCorrectFile: (project: string, base: string, force: boolean) => void;
  backTo?: string; phases?: JobPhases; jobRunning?: boolean;
  /** Nicht leer = kein nutzbarer KI-Anbieter: Korrigieren deaktiviert, Text als Tooltip. */
  aiReason?: string;
}) {
  const fileInput = useRef<HTMLInputElement>(null)
  const pendingProject = useRef<string>('')
  return (
    <div className="p-3">
      <h1 className="mb-3 text-lg font-semibold">Transkribor</h1>
      {backTo && (
        <Link to={backTo}
          className="mb-2 inline-flex items-center gap-1.5 text-sm text-muted-foreground
                     transition-colors hover:text-foreground">
          <ArrowLeft className="size-3.5" aria-hidden="true" /> zurück
        </Link>
      )}
      <input ref={fileInput} type="file" hidden accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.wma,.mp4"
        onChange={e => { const f = e.target.files?.[0]; if (f) onUpload(pendingProject.current, f); e.target.value = '' }} />
      {projects.length === 0 && loading && (
        <p className="text-sm text-muted-foreground">lädt…</p>
      )}
      {projects.length === 0 && !loading && (
        <p className="text-sm text-muted-foreground">
          Keine Projekte. Lege einen Ordner unter <code>projekte\&lt;NAME&gt;\audio</code> an.
        </p>
      )}
      {projects.map(p => (
        <div key={p.name} className="mb-3">
          <div className="flex items-center gap-1">
            <span className="flex-1 font-medium text-sm">{p.name}</span>
            <Button size="icon" variant="ghost" className="size-6" title="Audio hochladen" aria-label="Audio hochladen"
              onClick={() => { pendingProject.current = p.name; fileInput.current?.click() }}><Upload className="size-3.5" /></Button>
            <Button size="icon" variant="ghost" className="size-6" title="Transkribieren" aria-label="Transkribieren"
              onClick={() => onTranscribe(p.name)}><Play className="size-3.5" /></Button>
            {/* title am Wrapper: ein deaktivierter Knopf hat pointer-events:none und
                zeigt seinen eigenen Tooltip nie. */}
            <span title={aiReason || undefined} className="inline-flex">
              <Button size="icon" variant="ghost" className="size-6" title="Korrigieren + Sprecher" aria-label="Korrigieren + Sprecher"
                disabled={!!aiReason}
                onClick={() => onCorrect(p.name)}><Pencil className="size-3.5" /></Button>
            </span>
          </div>
          {p.files.map(f => (
            <FileRow key={f.base} file={f}
              active={active?.project === p.name && active?.base === f.base}
              onOpen={() => onOpen({ project: p.name, base: f.base })}
              onCorrectFile={force => onCorrectFile(p.name, f.base, force)}
              phase={jobRunning ? phases?.active[f.base]?.phase : undefined}
              state={jobRunning ? phases?.perBase[f.base] : undefined}
              jobRunning={jobRunning} aiReason={aiReason} />
          ))}
        </div>
      ))}
    </div>
  )
}
