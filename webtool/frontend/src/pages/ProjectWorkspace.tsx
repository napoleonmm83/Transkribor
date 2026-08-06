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
import { describePhases } from '@/lib/jobPhases'
import { cn } from '@/lib/utils'
import type { StartJob } from '@/lib/types'

const KIND_LABEL: Record<string, string> = { transcribe: 'Transkribieren…', correct: 'Korrigieren…' }

export function ProjectWorkspace() {
  const { project } = useParams<{ project: string }>()
  const navigate = useNavigate()
  const { projects, refresh } = useProjects()
  const { jobs, phases, adopt, onSettled } = useActiveJob()
  const p = projects.find(x => x.name === project)
  const meine = jobs.filter(j => j.project === project && j.status === 'running')
  const running = meine.length > 0

  useEffect(() => onSettled(() => refresh()), [onSettled, refresh])
  // Discovery: laufende Jobs nach Reload/aus der Liste adoptieren — es koennen zwei sein
  // (Transkription + Korrektur laufen im selben Projekt nebeneinander).
  const aktiveIds = (p?.active_jobs ?? []).map(j => j.id).join(',')
  useEffect(() => {
    for (const aj of p?.active_jobs ?? []) adopt(aj.id, project!, aj.kind)
  }, [aktiveIds, project, adopt])  // eslint-disable-line react-hooks/exhaustive-deps

  const startJob = async (fn: () => Promise<StartJob>, kind: string, label: string) => {
    let res: StartJob
    try { res = await fn() } catch (e) { toast.error(`${label} fehlgeschlagen: ${(e as Error).message}`); return }
    if (!res.started) { toast.warning(`Es läuft bereits ein ${label}-Job für dieses Projekt.`); return }
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

      {/* Eine Leiste je laufendem Job — Transkription und Korrektur laufen nebeneinander,
          und jede braucht ihren eigenen Abbrechen-Knopf. */}
      {meine.map(j => (
        <div key={j.id} className="mb-2 flex items-center justify-between gap-2 rounded bg-accent px-3 py-2 text-sm">
          <span className="truncate">{describePhases(j.phases) || KIND_LABEL[j.kind] || 'läuft…'}</span>
          <Button variant="ghost" size="sm" className="shrink-0" onClick={() => cancelJob(j.id)}>
            <X className="size-4" /> Abbrechen
          </Button>
        </div>
      ))}

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
          const active = running ? phases.active[f.base] : undefined
          const state = running ? phases.perBase[f.base] : undefined
          return (
            <li key={f.base} className="px-3 py-2">
              <div className="flex items-center gap-3">
                {/* Audio ohne Roh-Transkript ist zwar sichtbar, aber weder oeffen- noch korrigierbar. */}
                <button className={cn('flex-1 truncate text-left text-sm', f.has_raw ? 'hover:underline' : 'text-muted-foreground')}
                  disabled={!f.has_raw}
                  onClick={() => navigate(`/p/${encodeURIComponent(project!)}/${encodeURIComponent(f.base)}`)}>
                  {f.base}
                </button>
                <FileStatusPill file={f} active={active?.phase} pct={active?.pct} detail={active?.detail}
                  state={state} jobRunning={running} />
                <Button size="icon" variant="ghost" className="size-6" title="Nur diese Datei korrigieren"
                  disabled={!f.has_raw}
                  onClick={() => startJob(() => startCorrectFile(project!, f.base, false), 'correct', `Korrigieren ${f.base}`)}>
                  <Pencil className="size-3.5" />
                </Button>
              </div>
              {active?.pct != null && (
                <div className="mt-1 h-1 overflow-hidden rounded bg-accent" role="progressbar"
                  aria-valuenow={active.pct} aria-valuemin={0} aria-valuemax={100} aria-label={f.base}>
                  <div className="h-full bg-primary transition-all" style={{ width: `${active.pct}%` }} />
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {!p && <p className="text-sm text-muted-foreground">Projekt nicht gefunden.</p>}
    </div>
  )
}
