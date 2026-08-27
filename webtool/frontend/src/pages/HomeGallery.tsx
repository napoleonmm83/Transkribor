import { useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { FolderOpen, Loader2, Settings } from 'lucide-react'
import { useProjekte } from '@/hooks/useProjektDaten'
import { KIND_LABEL } from '@/lib/jobPhases'
import { NewProjectDialog } from '@/components/NewProjectDialog'
import { ProjektMenue } from '@/components/ProjektMenue'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import type { Project } from '@/lib/types'

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

// Juengstes zuerst; Name als stabiler Zweitschluessel -- sonst springen Zeilen bei gleichem
// geaendert (zwei Projekte in derselben Sekunde angelegt) bei jedem Poll. Eine Sortierauswahl
// (auch nach Name) gibt es hier nicht mehr -- das Suchfeld der Seitenleiste loest "nach Name
// finden" bereits, ein zweiter Weg dorthin waere eine Bedienoberflaeche fuers selbe Problem.
function vergleichen(a: Project, b: Project): number {
  return b.geaendert - a.geaendert || a.name.localeCompare(b.name, 'de')
}

/**
 * Ab wie vielen ruhenden Projekten die dichte Zeilenliste wieder gewinnt (#70).
 *
 * Darunter tragen dieselben Karten wie „Laeuft gerade" die Uebersicht: bei fuenf Projekten
 * standen dort fuenf Zeilen und darunter ~450 px Leere -- und dieselben fuenf noch einmal in
 * der Seitenleiste daneben. Bei dreihundert stimmt die alte Aufteilung dagegen (Leiste =
 * alles, Uebersicht = die letzten fuenf); eine Kartenwand aus dreihundert waere dort das
 * Gegenteil einer Uebersicht.
 *
 * 8 ist keine gemessene Zahl, sondern das Raster: `lg:grid-cols-3` fuellt damit hoechstens
 * drei Reihen.
 */
const KARTEN_BIS = 8
/** Wie viele Zeilen die dichte Liste zeigt, sobald es zu viele fuer Karten sind. */
const ZEILEN = 5

/**
 * EIN Kartenbauteil fuer beide Abschnitte. Die Karte stand vorher nur im
 * Laeuft-gerade-Zweig; sie fuer #70 ein zweites Mal hinzuschreiben hiesse, dass die beiden
 * ab dem naechsten Umbau auseinanderlaufen -- der einzige Unterschied sind die Laufmarken,
 * und die traegt `p` selbst.
 */
function ProjektKarte({ p, refresh }: { p: Project; refresh: () => void }) {
  const done = p.fertig
  const jobs = p.active_jobs ?? []
  return (
    // Der Loeschknopf ist ein Geschwister des Links, nicht sein Kind: ein <button>
    // in einem <a> ist ungueltiges HTML und der Klick landete im Falschen.
    <li className="blatt blatt-klickbar group relative">
      {/* has-[[data-state=open]]: waehrend das Menue offen steht, muss sein
          Knopf sichtbar bleiben. focus-within reicht NICHT — Radix schiebt den
          Fokus in den portalierten Inhalt ausserhalb dieser Zeile, der Anker
          verschwand also genau dann, wenn er gebraucht wird (im Bild geprueft). */}
      <div className="absolute right-2 top-2 z-10 opacity-0 transition-opacity
                      group-hover:opacity-100 focus-within:opacity-100
                      has-[[data-state=open]]:opacity-100">
        <ProjektMenue project={p.name} onUmbenannt={refresh} onGeloescht={refresh} />
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

        {/* Fortschritt des Projekts auf einen Blick: die Uebersicht beantwortet damit
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
}

export function HomeGallery() {
  // Der Poll steckt im ProjektDatenProvider — Jobs starten inzwischen auch ohne Klick (Upload
  // -> Transkription -> Korrektur), die Uebersicht muss sie also sehen, ohne dass hier vorher
  // schon einer lief.
  const { projects, refresh, loading, fehler } = useProjekte()
  const navigate = useNavigate()
  const oeffnen = (name: string) => navigate(`/p/${encodeURIComponent(name)}`)

  const laufende = useMemo(
    () => projects.filter(p => (p.active_jobs?.length ?? 0) > 0).sort(vergleichen),
    [projects])
  // Laufende Projekte stehen schon als Karte oben -- ohne den Ausschluss stuende ein aktives
  // Projekt doppelt da.
  const ruhende = useMemo(
    () => projects.filter(p => (p.active_jobs?.length ?? 0) === 0).sort(vergleichen),
    [projects])
  // Unter der Schwelle ist die Liste VOLLSTAENDIG und steht als Karten da (#70). Darueber
  // bleibt es bei den letzten fuenf Zeilen: die vollstaendige Liste steht dann in der
  // Seitenleiste, und diese Seite beantwortet wieder "woran war ich dran", nicht "was gibt
  // es alles".
  const karten = ruhende.length <= KARTEN_BIS
  const juengste = useMemo(
    () => (karten ? ruhende : ruhende.slice(0, ZEILEN)),
    [ruhende, karten])

  return (
    <div className="p-6 sm:p-8">
      <PageHeader rubrik="Transkribor" titel="Übersicht">
        {/* „+ Neues Projekt" steht hier NUR, solange die Seitenleiste fehlt (#69 + Nachtrag).
            #69 galt dem Doppel auf EINEM Schirm — zwei wortgleiche Knöpfe sind kein zweiter
            Weg, sondern die Frage, ob sie dasselbe tun. Unter `md` blendet die Hülle die
            Leiste aber aus (AppShell), und mit ihr verschwand der einzige verbliebene Weg:
            der Knopf im Leerzustand erscheint nur ohne Projekte, und die Palette (`Ctrl+K`)
            kann Projekte nur ÖFFNEN, nicht anlegen. Wer also im schmalen Fenster schon ein
            Projekt hatte, konnte kein zweites mehr anlegen — im Browser gemessen (700 px:
            `aside` display:none, Knopf 0×0).
            `md:hidden` ist der Punkt, an dem die beiden sich ablösen: ab `md` trägt ihn die
            Leiste, darunter dieser hier. Nie beide zugleich. */}
        <span className="md:hidden"><NewProjectDialog onCreated={oeffnen} /></span>
        <Button variant="ghost" size="sm" asChild>
          <Link to="/einstellungen"><Settings className="size-4" /> Einstellungen</Link>
        </Button>
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
          {laufende.length > 0 && (
            <section className="mb-8">
              <h2 className="rubrik mb-3">Läuft gerade · {laufende.length}</h2>
              <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {laufende.map(p => <ProjektKarte key={p.name} p={p} refresh={refresh} />)}
              </ul>
            </section>
          )}

          {/* Ausgeblendet statt einer leeren Liste: nur moeglich, wenn ausnahmslos jedes
              Projekt gerade laeuft (steht dann schon oben als Karte). */}
          {juengste.length > 0 && (
            <section>
              {/* Die Ueberschrift bleibt in BEIDEN Faellen dieselbe: sie benennt die
                  Sortierung (juengstes zuerst), nicht die Vollstaendigkeit. */}
              <h2 className="rubrik mb-3">Zuletzt geändert</h2>
              {karten ? (
                <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {juengste.map(p => <ProjektKarte key={p.name} p={p} refresh={refresh} />)}
                </ul>
              ) : (
                <ul className="blatt divide-y divide-border overflow-hidden">
                  {juengste.map(p => (
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
                      {/* Geschwister des Links, nicht sein Kind: ein <button> in einem <a> ist
                          ungueltiges HTML und der Klick landete zusaetzlich im Link. */}
                      {/* has-[[data-state=open]]: Begruendung wie bei den Karten oben. */}
                      <div className="shrink-0 px-3 opacity-0 transition-opacity
                                      group-hover:opacity-100 focus-within:opacity-100
                                      has-[[data-state=open]]:opacity-100">
                        <ProjektMenue project={p.name} onUmbenannt={refresh} onGeloescht={refresh} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      )}
    </div>
  )
}
