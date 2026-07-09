import { useRef } from 'react'
import { Upload, Play, Pencil } from 'lucide-react'
import type { Project } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { FileRow } from './FileRow'

type Sel = { project: string; base: string } | null
export function Sidebar({ projects, active, onOpen, onUpload, onTranscribe, onCorrect, onCorrectFile }: {
  projects: Project[]; active: Sel;
  onOpen: (s: { project: string; base: string }) => void;
  onUpload: (project: string, file: File) => void;
  onTranscribe: (project: string) => void;
  onCorrect: (project: string) => void;
  onCorrectFile: (project: string, base: string, hasEdit: boolean) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null)
  const pendingProject = useRef<string>('')
  return (
    <div className="p-3">
      <h1 className="mb-3 text-lg font-semibold">Transkribor</h1>
      <input ref={fileInput} type="file" hidden accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.wma,.mp4"
        onChange={e => { const f = e.target.files?.[0]; if (f) onUpload(pendingProject.current, f); e.target.value = '' }} />
      {projects.map(p => (
        <div key={p.name} className="mb-3">
          <div className="flex items-center gap-1">
            <span className="flex-1 font-medium text-sm">{p.name}</span>
            <Button size="icon" variant="ghost" className="size-6" title="Audio hochladen"
              onClick={() => { pendingProject.current = p.name; fileInput.current?.click() }}><Upload className="size-3.5" /></Button>
            <Button size="icon" variant="ghost" className="size-6" title="Transkribieren"
              onClick={() => onTranscribe(p.name)}><Play className="size-3.5" /></Button>
            <Button size="icon" variant="ghost" className="size-6" title="Korrigieren + Sprecher"
              onClick={() => onCorrect(p.name)}><Pencil className="size-3.5" /></Button>
          </div>
          {p.files.map(f => (
            <FileRow key={f.base} file={f}
              active={active?.project === p.name && active?.base === f.base}
              onOpen={() => onOpen({ project: p.name, base: f.base })}
              onCorrectFile={() => onCorrectFile(p.name, f.base, f.has_edit)} />
          ))}
        </div>
      ))}
    </div>
  )
}
