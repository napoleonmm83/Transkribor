import { useEffect } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Play, Pencil, X } from 'lucide-react'
import { useProjects } from '@/hooks/useProjects'
import { useActiveJob } from '@/hooks/useActiveJob'
import { FileStatusPill } from '@/components/FileStatusPill'
import { UploadDropzone } from '@/components/UploadDropzone'
import { UrlFetch } from '@/components/UrlFetch'
import { Button } from '@/components/ui/button'
import { startTranscribe, startCorrect, startCorrectFile, cancelJob } from '@/lib/api'
import type { StartJob } from '@/lib/types'

const GLOBAL_LABEL = { diarize: 'Diarisieren…', prep: 'Vorbereiten…', glossary: 'Glossar wird erstellt…', download: 'Herunterladen…' } as const

export function ProjectWorkspace() {
  const { project } = useParams<{ project: string }>()
  const navigate = useNavigate()
  const { projects, refresh } = useProjects()
  const { job, phases, adopt, onSettled } = useActiveJob()
  const p = projects.find(x => x.name === project)
  const running = !!job && job.status === 'running' && job.project === project

  useEffect(() => onSettled(() => refresh()), [onSettled, refresh])
  // Discovery: laufenden Job nach Reload/aus der Liste adoptieren
  useEffect(() => {
    if (p?.active_job && job?.id !== p.active_job.id) adopt(p.active_job.id, project!, p.active_job.kind)
  }, [p?.active_job?.id, job?.id, project, adopt, p?.active_job])

  const startJob = async (fn: () => Promise<StartJob>, kind: string, label: string) => {
    let res: StartJob
    try { res = await fn() } catch (e) { toast.error(`${label} fehlgeschlagen: ${(e as Error).message}`); return }
    if (!res.started) { toast.warning('Es läuft bereits ein Job für dieses Projekt.'); return }
    adopt(res.job_id, project!, kind)
    toast.success(`${label} gestartet`)
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-3 flex items-center gap-3">
        <Link className="text-sm text-muted-foreground hover:underline" to="/">‹ Home</Link>
        <h1 className="text-xl font-semibold">{project}</h1>
      </div>
      <div className="mb-4 flex gap-2">
        <Button variant="outline" size="sm" onClick={() => startJob(() => startTranscribe(project!), 'transcribe', 'Transkribieren')}>
          <Play className="size-4" /> Transkribieren
        </Button>
        <Button variant="outline" size="sm" onClick={() => startJob(() => startCorrect(project!), 'correct', 'Korrigieren')}>
          <Pencil className="size-4" /> Korrigieren
        </Button>
      </div>

      {running && !phases.active && phases.global && (
        <div className="mb-3 flex items-center justify-between rounded bg-accent px-3 py-2 text-sm">
          <span>{GLOBAL_LABEL[phases.global]}</span>
          <Button variant="ghost" size="sm" onClick={() => job && cancelJob(job.id)}><X className="size-4" /> Abbrechen</Button>
        </div>
      )}

      <div className="mb-4 space-y-3">
        <UploadDropzone project={project!} onDone={refresh} />
        <UrlFetch project={project!} onStart={res => {
          if (!res.started) { toast.warning('Es läuft bereits ein Job für dieses Projekt.'); return }
          adopt(res.job_id, project!, 'transcribe')
          toast.success('Herunterladen gestartet')
        }} />
      </div>

      {p && p.files.length === 0 && (
        <p className="text-sm text-muted-foreground">Noch keine Dateien — lade Audio hoch, füge eine Video-URL ein und transkribiere.</p>
      )}
      <ul className="divide-y rounded border">
        {p?.files.map(f => {
          const active = running && phases.active?.base === f.base ? phases.active.phase : undefined
          const state = running ? phases.perBase[f.base] : undefined
          return (
            <li key={f.base} className="flex items-center gap-3 px-3 py-2">
              <button className="flex-1 truncate text-left text-sm hover:underline"
                onClick={() => navigate(`/p/${encodeURIComponent(project!)}/${encodeURIComponent(f.base)}`)}>
                {f.base}
              </button>
              <FileStatusPill file={f} active={active} state={state} jobRunning={running} />
              <Button size="icon" variant="ghost" className="size-6" title="Nur diese Datei korrigieren"
                onClick={() => startJob(() => startCorrectFile(project!, f.base, false), 'correct', `Korrigieren ${f.base}`)}>
                <Pencil className="size-3.5" />
              </Button>
            </li>
          )
        })}
      </ul>
      {!p && <p className="text-sm text-muted-foreground">Projekt nicht gefunden.</p>}
    </div>
  )
}
