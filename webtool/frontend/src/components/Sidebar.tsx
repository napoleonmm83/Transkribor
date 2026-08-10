import { useRef } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Upload, Play, Pencil } from 'lucide-react'
import type { ActiveJob, JobPhases, ProjectFile } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { FileRow } from './FileRow'

type Sel = { project: string; base: string } | null
// Eigene Form statt Project aus lib/types: die Sidebar braucht die Dateiliste, die Project
// seit Task 3 nicht mehr fuehrt (die kommt jetzt separat aus getProjectFiles, siehe EditorView).
type SidebarProject = { name: string; files: ProjectFile[]; active_jobs?: ActiveJob[] };
export function Sidebar({ projects, loading, active, onOpen, onUpload, onTranscribe, onCorrect, onCorrectFile, backTo, phases, jobRunning, aiReason }: {
  projects: SidebarProject[]; loading?: boolean; active: Sel;
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
      {/* Gleiche Kopf-Reihenfolge wie PageHeader auf den anderen Seiten: erst der Rueckweg,
          dann die Rubrik, dann der Titel. Vorher stand hier ein 'Transkribor'-H1 in einer
          vierten Titelgroesse und darunter ein 'zurueck', waehrend jede andere Seite an
          derselben Stelle 'Projekte' anbietet — derselbe Sprung, zwei Namen.
          Der Produktname faellt weg: er stand nur hier und traegt im Editor nichts bei. */}
      {backTo && (
        <Link to={backTo}
          className="-mx-2 mb-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm
                     text-muted-foreground transition-colors hover:text-foreground">
          <ArrowLeft className="size-3.5" aria-hidden="true" /> Projekte
        </Link>
      )}
      <input ref={fileInput} type="file" hidden accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.wma,.mp4"
        onChange={e => { const f = e.target.files?.[0]; if (f) onUpload(pendingProject.current, f); e.target.value = '' }} />
      {projects.length === 0 && loading && (
        <p className="text-sm text-muted-foreground">lädt…</p>
      )}
      {projects.length === 0 && !loading && (
        // Die Liste ist hier auf EIN Projekt gefiltert (EditorView) — leer heisst also nicht
        // "noch keine Projekte", sondern "dieses gibt es nicht mehr". Der alte Text erklaerte
        // stattdessen, wie man von Hand einen Ordner anlegt; das macht man laengst im Browser.
        <p className="text-sm text-muted-foreground">Projekt nicht gefunden.</p>
      )}
      {projects.map(p => (
        <div key={p.name} className="mb-3">
          <div className="rubrik mb-1">Projekt</div>
          <div className="mb-2 flex items-center gap-1">
            <h2 className="min-w-0 flex-1 truncate text-base font-semibold">{p.name}</h2>
            <Button size="icon" variant="ghost" className="size-8" title="Audio hochladen" aria-label="Audio hochladen"
              onClick={() => { pendingProject.current = p.name; fileInput.current?.click() }}><Upload className="size-3.5" /></Button>
            <Button size="icon" variant="ghost" className="size-8" title="Transkribieren" aria-label="Transkribieren"
              onClick={() => onTranscribe(p.name)}><Play className="size-3.5" /></Button>
            {/* title am Wrapper: ein deaktivierter Knopf hat pointer-events:none und
                zeigt seinen eigenen Tooltip nie. */}
            <span title={aiReason || undefined} className="inline-flex">
              <Button size="icon" variant="ghost" className="size-8" title="Korrigieren + Sprecher" aria-label="Korrigieren + Sprecher"
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
