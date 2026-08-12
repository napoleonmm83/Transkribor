import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Bot, ScanText, X, FileAudio, Loader2 } from 'lucide-react'
import { useProjekte, useDateien } from '@/hooks/useProjektDaten'
import { useAiReady } from '@/hooks/useAiReady'
import { mergePhases, useActiveJob } from '@/hooks/useActiveJob'
import { DateiMenue } from '@/components/DateiMenue'
import { FileStatusPill } from '@/components/FileStatusPill'
import { UploadDropzone } from '@/components/UploadDropzone'
import { UrlFetch } from '@/components/UrlFetch'
import { ProjektMenue } from '@/components/ProjektMenue'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { startTranscribe, startCorrect, cancelJob, getProjektEinstellungen } from '@/lib/api'
import { describePhases, KIND_LABEL } from '@/lib/jobPhases'
import { cn } from '@/lib/utils'
import type { ProjectEinstellungen, StartJob } from '@/lib/types'

export function ProjectWorkspace() {
  const { project } = useParams<{ project: string }>()
  const navigate = useNavigate()
  const { projects, refresh } = useProjekte()
  const { files: dateien, refresh: refreshFiles, loading: dateienLaden, fehler: dateienFehler } = useDateien()
  const { jobs, adopt } = useActiveJob()
  const aiReason = useAiReady()          // nicht leer -> Korrektur waere ein Leerlauf
  const p = projects.find(x => x.name === project)
  const meine = useMemo(() => jobs.filter(j => j.project === project && j.status === 'running'),
    [jobs, project])
  // NUR die eigenen Jobs mergen: Basisnamen wiederholen sich ueber Projekte hinweg
  // ('Timeline 1' liegt in mehreren), sonst zeigt die Pille den fremden Status.
  const phases = useMemo(() => mergePhases(meine), [meine])
  const running = meine.length > 0

  // Per-Projekt-Einstellungen (Sprache, Korrektur-Tiefe) — fuer Badge + Sprachwaehler am
  // Upload/URL-Import. Die Vorgabe kommt aus projekt.json (Backend-Default: Schweizerdeutsch),
  // der Wähler am Upload ist ein Override fuer genau diese Datei und schreibt nicht zurueck.
  const [einstellungen, setEinstellungen] = useState<ProjectEinstellungen | null>(null)
  const [sprache, setSprache] = useState('')
  useEffect(() => {
    if (!project) return
    let aktiv = true
    setEinstellungen(null)         // Projektwechsel: Badge/Select verschwinden bis neu geladen
    getProjektEinstellungen(project)
      .then(d => { if (aktiv) { setEinstellungen(d); setSprache(d.sprache) } })
      .catch(() => { /* Badge/Select bleiben aus — Upload/Korrektur laufen unverändert */ })
    return () => { aktiv = false }
  }, [project])

  // F4-Handoff: sprachChoices erst durchreichen, wenn einstellungen+sprache da sind — sonst
  // wuerde der Select mit value="" gerendert (Radix warnt bei leerem Wert).
  const sprachChoices = einstellungen && sprache ? einstellungen.sprach_choices : []
  const sprachLabel = einstellungen
    ? (einstellungen.sprach_choices.find(c => c.id === einstellungen.sprache)?.label ?? einstellungen.sprache)
    : ''
  const reloadEinstellungen = () => {
    if (!project) return
    getProjektEinstellungen(project)
      .then(d => { setEinstellungen(d); setSprache(d.sprache) })
      .catch(() => {})
  }

  // Discovery laufender Jobs steht im ProjektDatenProvider — sie gilt fuer ALLE Projekte,
  // nicht nur fuer das offene. `adopt` bleibt hier fuer die selbst gestarteten Jobs.

  // `started === false` heisst bei transcribe/correct NICHT "abgelehnt": das Backend haengt den
  // Lauf hinten an (jobs.request). Nur der Einzel-Datei-Lauf wird wirklich abgewiesen.
  const startJob = async (fn: () => Promise<StartJob>, kind: string, label: string, queues = true) => {
    let res: StartJob
    try { res = await fn() } catch (e) { toast.error(`${label} fehlgeschlagen: ${(e as Error).message}`); return }
    if (!res.started) {
      toast[queues ? 'info' : 'warning'](queues
        ? `${label}: läuft schon — wird danach nachgeholt.`
        : `Es läuft bereits ein ${label}-Job für dieses Projekt.`)
      if (queues) refresh()
      return
    }
    adopt(res.job_id, project!, kind)
    toast.success(`${label} gestartet`)
  }

  return (
    <div className="p-6 sm:p-8">
      <PageHeader rubrik="Projekt" titel={project ?? ''} zurueck="/" zurueckText="Übersicht">
        {sprachLabel && <Badge variant="outline">{sprachLabel}</Badge>}
        <Button variant="outline" size="sm"
          onClick={() => startJob(() => startTranscribe(project!), 'transcribe', 'Transkribieren')}>
          <ScanText className="size-4" /> Transkribieren
        </Button>
        {/* title am Wrapper, nicht am Knopf: ein deaktivierter Knopf hat pointer-events:none
            und zeigt seinen eigenen Tooltip nie an. */}
        <span title={aiReason || undefined} className="inline-flex">
          <Button variant="outline" size="sm" disabled={!!aiReason}
            onClick={() => startJob(() => startCorrect(project!), 'correct', 'Korrigieren')}>
            <Bot className="size-4" /> Korrigieren
          </Button>
        </span>
        <ProjektMenue project={project!}
          onUmbenannt={neu => navigate(`/p/${encodeURIComponent(neu)}`)}
          onGeloescht={() => navigate('/')}
          onEinstellungenGeaendert={reloadEinstellungen} />
      </PageHeader>

      {/* Eine Leiste je laufendem Job — Transkription und Korrektur laufen nebeneinander,
          und jede braucht ihren eigenen Abbrechen-Knopf. */}
      {meine.length > 0 && (
        <div className="mb-6 space-y-2" aria-live="polite">
          {meine.map(j => (
            <div key={j.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-primary/25
                         bg-primary/5 px-3 py-2.5 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden="true" />
                <span className="min-w-0 truncate">{describePhases(j.phases) || KIND_LABEL[j.kind] || 'läuft…'}</span>
              </span>
              <Button variant="ghost" size="sm" className="shrink-0" onClick={() => cancelJob(j.id)}>
                <X className="size-4" /> Abbrechen
              </Button>
            </div>
          ))}
        </div>
      )}

      <section className="mb-8">
        <h2 className="rubrik mb-3">Material hinzufügen</h2>
        <div className="space-y-3">
          <UploadDropzone project={project!}
            sprache={sprache} sprachChoices={sprachChoices} onSpracheChange={setSprache}
            onDone={job => {
            refresh(); refreshFiles()
            // Sofort adoptieren statt auf den naechsten Poll zu warten — der Balken soll direkt stehen.
            if (job?.started) { adopt(job.job_id, project!, 'transcribe'); toast.success('Transkription gestartet') }
            else if (job) toast.info('Transkription läuft schon — die neuen Dateien kommen danach dran.')
          }} />
          <UrlFetch project={project!}
            sprache={sprache} sprachChoices={sprachChoices} onSpracheChange={setSprache}
            onStart={res => {
            if (!res.started) { toast.warning('Es läuft bereits ein Import für dieses Projekt.'); return }
            adopt(res.job_id, project!, 'fetch')
            toast.success('Herunterladen gestartet — Transkription folgt automatisch')
          }} />
        </div>
      </section>

      <section>
        <h2 className="rubrik mb-3">
          Dateien{dateien.length > 0 && <span className="ziffern ml-2 normal-case">{dateien.length}</span>}
        </h2>

        {/* Fehler VOR "leer" prüfen: sonst behauptet eine gescheiterte Anfrage "noch keine
            Dateien" statt zu sagen, dass sie nicht geladen werden konnte. */}
        {p && dateienFehler && (
          <div className="blatt flex flex-col items-center px-6 py-12 text-center">
            <FileAudio className="size-7 text-muted-foreground" aria-hidden="true" />
            <p className="mt-3 max-w-sm text-sm text-muted-foreground">
              Die Dateiliste konnte nicht geladen werden.
            </p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => refreshFiles()}>
              Erneut versuchen
            </Button>
          </div>
        )}

        {/* An useProjectFiles.loading haengen, nicht nur an p (Zusammenfassung): die Dateiliste
            ist eine eigene Anfrage, die laenger laufen kann als die Zusammenfassung -- sonst
            blitzt "Noch keine Dateien" auf, waehrend sie noch unterwegs ist. */}
        {p && !dateienFehler && !dateienLaden && dateien.length === 0 && (
          <div className="blatt flex flex-col items-center px-6 py-12 text-center">
            <FileAudio className="size-7 text-muted-foreground" aria-hidden="true" />
            <p className="mt-3 max-w-sm text-sm text-muted-foreground">
              Noch keine Dateien. Lade Audio hoch oder füge eine Video-URL ein — die
              Transkription startet von selbst.
            </p>
          </div>
        )}

        {dateien.length > 0 && (
          <ul className="blatt divide-y divide-border overflow-hidden">
            {dateien.map(f => {
              const active = running ? phases.active[f.base] : undefined
              const state = running ? phases.perBase[f.base] : undefined
              return (
                <li key={f.base} className="px-3 py-2.5 transition-colors hover:bg-muted/60">
                  <div className="flex items-center gap-3">
                    {/* Audio ohne Roh-Transkript ist zwar sichtbar, aber weder oeffen- noch korrigierbar. */}
                    <button className={cn('min-w-0 flex-1 truncate rounded-md text-left text-sm outline-none',
                      'focus-visible:ring-2 focus-visible:ring-ring',
                      f.has_raw ? 'font-medium hover:underline' : 'cursor-not-allowed text-muted-foreground')}
                      disabled={!f.has_raw}
                      onClick={() => navigate(`/p/${encodeURIComponent(project!)}/${encodeURIComponent(f.base)}`)}>
                      {f.base}
                    </button>
                    <FileStatusPill file={f} active={active?.phase} pct={active?.pct} detail={active?.detail}
                      state={state} jobRunning={running} mitText />
                    <DateiMenue project={project!} file={f} aiReason={aiReason} />
                  </div>
                  {active?.pct != null && (
                    <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted" role="progressbar"
                      aria-valuenow={active.pct} aria-valuemin={0} aria-valuemax={100} aria-label={f.base}>
                      <div className="h-full rounded-full bg-primary transition-all duration-300"
                        style={{ width: `${active.pct}%` }} />
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {!p && <p className="text-sm text-muted-foreground">Projekt nicht gefunden.</p>}
    </div>
  )
}
