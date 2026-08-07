import { Link, useNavigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { useProjects } from '@/hooks/useProjects'
import { KIND_LABEL } from '@/lib/jobPhases'
import { NewProjectDialog } from '@/components/NewProjectDialog'
import { DeleteProjectDialog } from '@/components/DeleteProjectDialog'

export function HomeGallery() {
  // Der Poll steckt in useProjects — Jobs starten inzwischen auch ohne Klick (Upload -> Transkription
  // -> Korrektur), die Galerie muss sie also sehen, ohne dass hier vorher schon einer lief.
  const { projects, refresh } = useProjects()
  const navigate = useNavigate()

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
              <div className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                <DeleteProjectDialog project={p.name} onDeleted={refresh} />
              </div>
              <Link to={`/p/${encodeURIComponent(p.name)}`} className="block">
                <div className="mb-1 font-medium">{p.name}</div>
                <div className="text-sm text-muted-foreground">
                  {p.files.length} Datei{p.files.length === 1 ? '' : 'en'} · {done} ✓
                </div>
                {/* mehrere moeglich: Transkription und Korrektur laufen nebeneinander */}
                {(p.active_jobs ?? []).map(j => (
                  <div key={j.id} className="mt-2 flex items-center gap-1 text-xs text-primary">
                    <Loader2 className="size-3 animate-spin" />
                    {KIND_LABEL[j.kind] ?? 'Läuft…'}
                  </div>
                ))}
              </Link>
            </div>
          )
        })}
      </div>
    </div>
  )
}
