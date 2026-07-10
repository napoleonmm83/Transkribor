import { useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { useProjects } from '@/hooks/useProjects'
import { NewProjectDialog } from '@/components/NewProjectDialog'
import { DeleteProjectDialog } from '@/components/DeleteProjectDialog'

export function HomeGallery() {
  const { projects, refresh } = useProjects()
  const navigate = useNavigate()

  // Solange irgendein Projekt einen laufenden Job hat, die Liste periodisch nachladen.
  const anyActive = projects.some(p => p.active_job)
  useEffect(() => {
    if (!anyActive) return
    const t = setInterval(refresh, 3000)
    return () => clearInterval(t)
  }, [anyActive, refresh])

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Transkribor</h1>
        <NewProjectDialog onCreated={name => navigate(`/p/${encodeURIComponent(name)}`)} />
      </div>
      {projects.length === 0 && <p className="text-sm text-muted-foreground">Noch keine Projekte. Lege eins an.</p>}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {projects.map(p => {
          const done = p.files.filter(f => f.has_edit).length
          return (
            <div key={p.name} className="group relative rounded-lg border p-4 hover:bg-accent">
              <div className="absolute right-2 top-2 opacity-0 group-hover:opacity-100">
                <DeleteProjectDialog project={p.name} onDeleted={refresh} />
              </div>
              <Link to={`/p/${encodeURIComponent(p.name)}`} className="block">
                <div className="mb-1 font-medium">{p.name}</div>
                <div className="text-sm text-muted-foreground">
                  {p.files.length} Datei{p.files.length === 1 ? '' : 'en'} · {done} ✓
                </div>
                {p.active_job && (
                  <div className="mt-2 inline-flex items-center gap-1 text-xs text-primary">
                    <Loader2 className="size-3 animate-spin" />
                    {p.active_job.kind === 'transcribe' ? 'Transkribieren…' : 'Korrigieren…'}
                  </div>
                )}
              </Link>
            </div>
          )
        })}
      </div>
    </div>
  )
}
