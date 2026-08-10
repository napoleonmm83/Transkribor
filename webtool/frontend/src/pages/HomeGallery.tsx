import { Link, useNavigate } from 'react-router-dom'
import { FolderOpen, Loader2, Settings } from 'lucide-react'
import { useProjects } from '@/hooks/useProjects'
import { KIND_LABEL } from '@/lib/jobPhases'
import { NewProjectDialog } from '@/components/NewProjectDialog'
import { DeleteProjectDialog } from '@/components/DeleteProjectDialog'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'

export function HomeGallery() {
  // Der Poll steckt in useProjects — Jobs starten inzwischen auch ohne Klick (Upload -> Transkription
  // -> Korrektur), die Galerie muss sie also sehen, ohne dass hier vorher schon einer lief.
  const { projects, refresh } = useProjects()
  const navigate = useNavigate()
  const oeffnen = (name: string) => navigate(`/p/${encodeURIComponent(name)}`)

  return (
    <div className="mx-auto max-w-5xl p-6 sm:p-8">
      <PageHeader rubrik="Transkribor" titel="Projekte">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/einstellungen"><Settings className="size-4" /> Einstellungen</Link>
        </Button>
        <NewProjectDialog onCreated={oeffnen} />
      </PageHeader>

      {projects.length === 0 ? (
        // Vorher stand hier ein grauer Halbsatz. Ein Leerzustand ist der erste Eindruck der
        // App — er muss sagen, was das hier ist und wie man anfaengt, nicht bloss, dass
        // nichts da ist.
        <div className="blatt flex flex-col items-center px-6 py-16 text-center">
          <FolderOpen className="size-8 text-muted-foreground" aria-hidden="true" />
          <h2 className="mt-4 text-lg font-semibold">Noch keine Projekte</h2>
          <p className="mt-2 max-w-sm text-sm text-muted-foreground">
            Ein Projekt bündelt die Aufnahmen eines Themas. Lege eines an, lade Audio hinein —
            Transkription und Korrektur laufen dann von selbst.
          </p>
          <div className="mt-6">
            <NewProjectDialog onCreated={oeffnen} trigger={<Button>Erstes Projekt anlegen</Button>} />
          </div>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map(p => {
            const done = p.fertig
            const jobs = p.active_jobs ?? []
            return (
              // Der Loeschknopf ist ein Geschwister des Links, nicht sein Kind: ein <button>
              // in einem <a> ist ungueltiges HTML und der Klick landete im Falschen.
              <li key={p.name} className="blatt blatt-klickbar group relative">
                <div className="absolute right-2 top-2 z-10 opacity-0 transition-opacity
                                group-hover:opacity-100 focus-within:opacity-100">
                  <DeleteProjectDialog project={p.name} onDeleted={refresh} />
                </div>
                {/* Der Link fuellt die Karte (absolute inset-0 waere die Alternative, kostet
                    aber die Textauswahl) — so ist die ganze Flaeche Ziel, nicht nur der Titel. */}
                <Link to={`/p/${encodeURIComponent(p.name)}`}
                  className="flex h-full flex-col rounded-lg p-4 pr-10 outline-none
                             focus-visible:ring-2 focus-visible:ring-ring">
                  <h2 className="line-clamp-2 text-lg font-semibold leading-snug">{p.name}</h2>
                  <p className="mt-1 text-sm tabular-nums text-muted-foreground">
                    {p.dateien} Datei{p.dateien === 1 ? '' : 'en'}
                    {p.dateien > 0 && ` · ${done} fertig`}
                  </p>

                  {/* Fortschritt des Projekts auf einen Blick: die Galerie beantwortet damit
                      "woran muss ich noch ran", ohne dass man jedes Projekt oeffnet. */}
                  {p.dateien > 0 && (
                    <div className="mt-3 h-1 overflow-hidden rounded-full bg-muted"
                      role="progressbar" aria-valuenow={done} aria-valuemin={0}
                      aria-valuemax={p.dateien}
                      aria-label={`${done} von ${p.dateien} Dateien fertig`}>
                      <div className="h-full rounded-full bg-primary transition-all duration-300"
                        style={{ width: `${(done / p.dateien) * 100}%` }} />
                    </div>
                  )}

                  {/* mehrere moeglich: Transkription und Korrektur laufen nebeneinander */}
                  {jobs.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1" aria-live="polite">
                      {jobs.map(j => (
                        <span key={j.id} className="inline-flex items-center gap-1.5 text-xs font-medium text-primary">
                          <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                          {KIND_LABEL[j.kind] ?? 'Läuft…'}
                        </span>
                      ))}
                    </div>
                  )}
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
