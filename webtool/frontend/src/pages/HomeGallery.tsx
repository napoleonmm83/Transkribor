import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { FolderOpen, Loader2, Search, Settings, X } from 'lucide-react'
import { useProjects } from '@/hooks/useProjects'
import { KIND_LABEL } from '@/lib/jobPhases'
import { NewProjectDialog } from '@/components/NewProjectDialog'
import { DeleteProjectDialog } from '@/components/DeleteProjectDialog'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import type { Project } from '@/lib/types'

type SortKey = 'geaendert' | 'name'

// numeric:'auto' liefert 'heute'/'gestern' schon selbst -- kein manueller Sonderfall noetig.
const rtf = new Intl.RelativeTimeFormat('de', { numeric: 'auto' })
const dtf = new Intl.DateTimeFormat('de-CH', { day: 'numeric', month: 'short', year: 'numeric' })

/** "heute" / "gestern" / "vor N Tagen", ab einer Woche das Datum -- eine relative Angabe
 *  ueber "vor 19 Tagen" liest sich niemand mehr aus. */
function relativeTime(sekunden: number): string {
  const tage = Math.floor((Date.now() - sekunden * 1000) / 86_400_000)
  if (tage < 7) return rtf.format(-tage, 'day')
  return dtf.format(sekunden * 1000)
}

function vergleichen(a: Project, b: Project, sort: SortKey): number {
  if (sort === 'name') return a.name.localeCompare(b.name, 'de')
  // juengstes zuerst; Name als stabiler Zweitschluessel -- sonst springen Zeilen bei
  // gleichem geaendert (zwei Projekte in derselben Sekunde angelegt) bei jedem Poll.
  return b.geaendert - a.geaendert || a.name.localeCompare(b.name, 'de')
}

export function HomeGallery() {
  // Der Poll steckt in useProjects — Jobs starten inzwischen auch ohne Klick (Upload -> Transkription
  // -> Korrektur), die Galerie muss sie also sehen, ohne dass hier vorher schon einer lief.
  const { projects, refresh, loading, fehler } = useProjects()
  const navigate = useNavigate()
  const oeffnen = (name: string) => navigate(`/p/${encodeURIComponent(name)}`)
  const [suche, setSuche] = useState('')
  const [sort, setSort] = useState<SortKey>('geaendert')

  const treffer = useMemo(() => {
    const q = suche.trim().toLowerCase()
    return q ? projects.filter(p => p.name.toLowerCase().includes(q)) : projects
  }, [projects, suche])
  const laufende = useMemo(
    () => treffer.filter(p => (p.active_jobs?.length ?? 0) > 0).sort((a, b) => vergleichen(a, b, 'geaendert')),
    [treffer])
  const alle = useMemo(
    () => treffer.filter(p => (p.active_jobs?.length ?? 0) === 0).sort((a, b) => vergleichen(a, b, sort)),
    [treffer, sort])

  return (
    <div className="p-6 sm:p-8">
      <PageHeader rubrik="Transkribor" titel="Projekte">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/einstellungen"><Settings className="size-4" /> Einstellungen</Link>
        </Button>
        <NewProjectDialog onCreated={oeffnen} />
      </PageHeader>

      {projects.length === 0 ? (
        // Drei verschiedene Gruende fuer eine leere Liste, drei verschiedene Aussagen -- sonst
        // behauptet "Noch keine Projekte" auch waehrend des ersten Ladens oder nach einer
        // gescheiterten Anfrage etwas, das schlicht nicht stimmt (dieselbe Regel wie beim
        // Leerzustand der Arbeitsflaeche, siehe useProjectFiles.fehler).
        loading ? (
          <div className="blatt flex flex-col items-center px-6 py-16 text-center">
            <Loader2 className="size-8 animate-spin text-muted-foreground" aria-hidden="true" />
            <p className="mt-4 text-sm text-muted-foreground">Projekte werden geladen…</p>
          </div>
        ) : fehler ? (
          <div className="blatt flex flex-col items-center px-6 py-16 text-center">
            <FolderOpen className="size-8 text-muted-foreground" aria-hidden="true" />
            <h2 className="mt-4 text-lg font-semibold">Projekte konnten nicht geladen werden</h2>
            <p className="mt-2 max-w-sm text-sm text-muted-foreground">
              Der Server antwortet nicht. Prüfe die Verbindung und versuche es erneut.
            </p>
            <Button className="mt-6" variant="outline" onClick={refresh}>Erneut versuchen</Button>
          </div>
        ) : (
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
        )
      ) : (
        <>
          {/* sticky: bei hunderten Projekten scrollt die Zeilenliste unter dem Suchfeld weg,
              nicht das Suchfeld mit. bg-background deckt die durchscrollenden Zeilen ab. */}
          <div className="sticky top-0 z-10 -mx-6 mb-6 bg-background px-6 py-3 sm:-mx-8 sm:px-8">
            <label htmlFor="projekt-suche" className="sr-only">Projekte durchsuchen</label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <input id="projekt-suche" type="search" value={suche} onChange={e => setSuche(e.target.value)}
                placeholder="Projekte durchsuchen…"
                className="h-9 w-full rounded-md border border-input bg-transparent py-1 pl-9 pr-16 text-sm
                           shadow-xs outline-none placeholder:text-muted-foreground
                           focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                Strg+K
              </span>
            </div>
          </div>

          {laufende.length > 0 && (
            <section className="mb-8">
              <h2 className="rubrik mb-3">Läuft gerade · {laufende.length}</h2>
              <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {laufende.map(p => {
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
            </section>
          )}

          <section>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <h2 className="rubrik" aria-live="polite">Alle · {alle.length}</h2>
              <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
                Sortierung
                <select value={sort} onChange={e => setSort(e.target.value as SortKey)}
                  className="rounded-md border border-input bg-transparent px-2 py-1 text-sm outline-none
                             focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50">
                  <option value="geaendert">Zuletzt geändert</option>
                  <option value="name">Name</option>
                </select>
              </label>
            </div>

            {treffer.length === 0 ? (
              // Kein leerer Bildschirm: der Suchbegriff steht drin, und es gibt zwei Wege zurueck.
              <div className="blatt flex flex-col items-center px-6 py-12 text-center">
                <Search className="size-7 text-muted-foreground" aria-hidden="true" />
                <p className="mt-3 max-w-sm text-sm text-muted-foreground">
                  Kein Projekt passt zu „{suche}".
                </p>
                <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => setSuche('')}>
                    <X className="size-3.5" /> Suche leeren
                  </Button>
                  <NewProjectDialog onCreated={oeffnen} vorbelegung={suche}
                    trigger={<Button size="sm">„{suche}" anlegen</Button>} />
                </div>
              </div>
            ) : alle.length > 0 && (
              <ul className="blatt divide-y divide-border overflow-hidden">
                {alle.map(p => (
                  // group + hover/focus-within hier statt auf dem Link: der Loeschknopf ist
                  // dessen Geschwister (ein <button> in einem <a> waere ungueltiges HTML und
                  // der Klick landete zusaetzlich im Link), soll die Zeile aber trotzdem
                  // ueber die volle Breite einfaerben.
                  <li key={p.name} className="group flex items-center hover:bg-muted/60">
                    <Link to={`/p/${encodeURIComponent(p.name)}`}
                      className="flex h-11 min-w-0 flex-1 items-center gap-3 px-3 outline-none
                                 focus-visible:ring-2 focus-visible:ring-ring">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{p.name}</span>
                      <span className="shrink-0 tabular-nums text-sm text-muted-foreground">
                        {p.dateien} Datei{p.dateien === 1 ? '' : 'en'}
                        {p.dateien > 0 && ` · ${p.fertig} fertig`}
                      </span>
                      <time dateTime={new Date(p.geaendert * 1000).toISOString()}
                        className="w-24 shrink-0 text-right text-sm text-muted-foreground">
                        {relativeTime(p.geaendert)}
                      </time>
                    </Link>
                    <div className="shrink-0 px-3 opacity-0 transition-opacity
                                    group-hover:opacity-100 focus-within:opacity-100">
                      <DeleteProjectDialog project={p.name} onDeleted={refresh} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  )
}
