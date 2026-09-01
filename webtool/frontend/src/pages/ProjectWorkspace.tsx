import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Bot, ScanText, X, FileAudio, Loader2, Plus } from 'lucide-react'
import { useProjekte, useDateien } from '@/hooks/useProjektDaten'
import { useAiReady } from '@/hooks/useAiReady'
import { mergePhases, useActiveJob } from '@/hooks/useActiveJob'
import { DateiMenue } from '@/components/DateiMenue'
import { FileStatusPill } from '@/components/FileStatusPill'
import { ProjektMenue } from '@/components/ProjektMenue'
import { PageHeader } from '@/components/PageHeader'
import { MaterialDialog } from '@/components/MaterialDialog'
import { nurAudio } from '@/lib/materialZeilen'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { startTranscribe, startCorrect, cancelJob, getProjektEinstellungen } from '@/lib/api'
import { describePhases, KIND_LABEL, imBereich, zugelassen } from '@/lib/jobPhases'
import { cn } from '@/lib/utils'
import type { ProjectEinstellungen, StartJob } from '@/lib/types'

/**
 * Nicht mehr still (#215) — und an EINER Stelle, nicht in jedem `.catch`.
 *
 * Ohne geladene Einstellungen gilt stillschweigend der Projektstandard. Das ist die richtige
 * Voreinstellung, aber wer bewusst eine andere Sprache setzen wollte, findet das Bedienelement
 * schlicht nicht und kann „gibt es hier nicht" nicht von „ist gerade kaputt" unterscheiden. Der
 * Upload startet die Transkription sofort, eine falsche Sprache kostet einen kompletten Lauf.
 *
 * Kein Wiederholversuch: ein Neuladen der Seite genügt. Zwei Aufrufer (Lade-Effekt und
 * `reloadEinstellungen`) — getrennt formuliert liefen sie auseinander, und der zweite hatte
 * beim ersten Anlauf genau deshalb keinen Test.
 */
function meldeLadefehler(e: unknown) {
  toast.error(`Projekt-Einstellungen laden fehlgeschlagen: ${(e as Error).message}`)
}

/** Die Arbeitsflaeche eines Projekts: Material hinzufuegen, Laeufe anstossen und je Aufnahme
 *  ihren Stand zeigen — dieselbe Zulassung wie die Seitenleiste (`imBereich`/`zugelassen`). */
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

  // Per-Projekt-Einstellungen (Sprache, Korrektur-Tiefe) — fuer Badge + die EINE Sprachauswahl
  // im Bereich „Material hinzufügen". Die Vorgabe kommt aus projekt.json (Backend-Default:
  // Schweizerdeutsch); die Auswahl hier ist ein Override fuer die neu hinzugefuegten Dateien
  // und schreibt NICHT ins Projekt zurueck (dafuer der Dialog im ⋯-Menü).
  const [einstellungen, setEinstellungen] = useState<ProjectEinstellungen | null>(null)
  const [sprache, setSprache] = useState('')
  const [dialogOffen, setDialogOffen] = useState(false)
  const [vorbelegt, setVorbelegt] = useState<File[]>([])
  const [zieht, setZieht] = useState(false)
  useEffect(() => {
    if (!project) return
    let aktiv = true
    setEinstellungen(null)         // Projektwechsel: Badge/Select verschwinden bis neu geladen
    // …und die Sprache MIT. React Router baut dieses Element bei einem Parameterwechsel nicht
    // neu auf, der State ueberlebt also den Projektwechsel: die Ablageflaeche ist die ganze
    // Zeit scharf, und ein Drop zwischen Wechsel und Antwort schickte sonst die Sprache des
    // VORIGEN Projekts als Datei-Override mit — eine falsche Sprache kostet eine komplette
    // Neu-Transkription. '' heisst „nicht gesetzt", der Projektstandard von B gilt.
    //
    // **Seit #234 ist das hier Redundanz, kein Wall mehr** — nachgerechnet: solange die
    // Antwort aussteht, ist `einstellungen` null, damit `sprachChoices` leer, damit
    // `zeigeSprachwahl` falsch, und `sprachWert` kuerzt schon am ersten Konjunkt auf `''` ab.
    // Der Reset bleibt trotzdem stehen (ein State, der einem fremden Projekt gehoert, soll
    // nicht liegenbleiben) — aber wer den Schutz sucht, findet ihn bei `sprachWert`, und
    // sobald B geantwortet hat, traegt ihn `setSprache(d.sprache)` unten. Beide Fenster haben
    // je einen eigenen Test.
    setSprache('')
    getProjektEinstellungen(project)
      .then(d => { if (aktiv) { setEinstellungen(d); setSprache(d.sprache) } })
      .catch(e => { if (aktiv) meldeLadefehler(e) })
    return () => { aktiv = false }
  }, [project])

  // F4-Handoff: sprachChoices erst durchreichen, wenn einstellungen+sprache da sind — sonst
  // wuerde der Select mit value="" gerendert (Radix warnt bei leerem Wert).
  const sprachChoices = einstellungen && sprache ? einstellungen.sprach_choices : []
  // Obergrenze der Sprecherzahl vom Server. `?? 20` deckt einen aelteren Server bzw. einen
  // fehlgeschlagenen GET — dieselbe Richtung wie bei `diarisierung_aktiv`: die Oberflaeche
  // darf nicht in eine Sperre laufen, die niemand aufheben kann. Die Zahl steht damit nur an
  // EINER Stelle im Frontend (hier), nicht in jeder Eingabekomponente.
  const sprecherMax = einstellungen?.sprecher_max ?? 20
  const sprachLabel = einstellungen
    ? (einstellungen.sprach_choices.find(c => c.id === einstellungen.sprache)?.label ?? einstellungen.sprache)
    : ''
  // projektRef hält den aktuellen Projekt-Namen fuer reloadEinstellungen — die Antwort
  // von Projekt A darf nicht landen, nachdem auf Projekt B gewechselt wurde (dasselbe
  // Muster wie der `aktiv`-Riegel oben, nur fuer den Speichern-Reload-Pfad).
  const projectRef = useRef(project)
  projectRef.current = project
  const reloadEinstellungen = () => {
    if (!project) return
    getProjektEinstellungen(project)
      .then(d => { if (projectRef.current === project) { setEinstellungen(d); setSprache(d.sprache) } })
      .catch(e => { if (projectRef.current === project) meldeLadefehler(e) })
  }

  // Ein Drop NEBEN die Ablageflaeche darf den Browser nicht die Datei oeffnen lassen: er
  // ersetzt damit die Seite, und alles, was im Dialog stand, ist weg. Das Versprechen „die
  // ganze Seite ist Drop-Ziel" macht den Fehlwurf ausserdem wahrscheinlicher — daneben liegt
  // die Seitenleiste. `preventDefault` auf Fensterebene laesst den Drop einfach nichts tun
  // (CodeRabbit-Bot).
  useEffect(() => {
    const stopp = (e: DragEvent) => e.preventDefault()
    window.addEventListener('dragover', stopp)
    window.addEventListener('drop', stopp)
    return () => {
      window.removeEventListener('dragover', stopp)
      window.removeEventListener('drop', stopp)
    }
  }, [])

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
    // Das Overlay liegt ueber der GANZEN Arbeitsflaeche — es faengt damit Drops, die vorher
    // an der Ablageflaeche vorbeigingen. Ein PDF irgendwo fallen zu lassen darf deshalb
    // nicht still nichts tun: der alte `waehlen`-Weg filterte und kehrte wortlos zurueck,
    // was in Ordnung war, solange man die Zone absichtlich treffen musste.
    <div className="p-6 sm:p-8" data-testid="drop-overlay-ziel"
      onDragOver={e => { e.preventDefault(); setZieht(true) }}
      // `relatedTarget` pruefen: `dragleave` feuert bei JEDER Kindgrenze, die der Zeiger
      // kreuzt — ueber die ganze Seite hinweg flackerte das Overlay dabei staendig. In der
      // alten, kleinen Ablageflaeche fiel das kaum auf.
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setZieht(false) }}
      // Rueckfall fuer den ABGEBROCHENEN Zug (#304/Kl2). Im Browser gemessen (Chromium, Zug
      // per Escape abgebrochen, ohne den Container zu verlassen):
      //
      //     dragenter -> dragleave -> dragenter -> dragleave
      //     --- Escape ---
      //     dragend                       <- und sonst NICHTS
      //
      // Das `dragleave`, an dem `zieht` bisher allein hing, kommt dort NICHT mehr. Ohne
      // diese Zeile bleibt das Overlay ueber der ganzen Seite stehen; es ist
      // `pointer-events-none`, blockiert also nichts, verdeckt aber alles bis zum naechsten
      // Zug.
      //
      // **Was NICHT belegt ist, und das ist der wichtigere Teil:** gemessen wurde ein
      // IN-PAGE-Drag — und solche gibt es in dieser App gar nicht (kein einziges
      // `draggable`, nachgesehen). Der reale Weg ist der Datei-Zug vom Desktop, und dort
      // hat der Zug keinen Quellknoten im Dokument; ob der Browser `dragend` dann ueberhaupt
      // liefert, laesst sich mit Playwright nicht simulieren. Die Zeile kostet nichts und
      // deckt jeden Fall, in dem er ihn liefert — sie ist damit ein Schutz mit gemessenem
      // MECHANISMUS, aber ohne Beleg fuer den Fall, der hier wirklich vorkommt.
      //
      // **Das Escape ABZUFANGEN ist KEIN Ausweg — gemessen, damit es niemand zweimal
      // versucht.** Die CodeRabbit-CLI schlug genau das vor („einen Abbruchpfad, der bei
      // Escape zuverlaessig `setZieht(false)` aufruft"). Im Browser nachgestellt kommt
      // waehrend eines laufenden Drags am Fenster an:
      //
      //     --- Escape ---
      //     dragend
      //     keyup(Escape)          <- NUR keyup, KEIN keydown
      //
      // Der `keydown` wird vom Drag-Vorgang geschluckt, ein `keydown`-Handler waere also
      // wirkungslos; das `keyup` kommt NACH `dragend` und waere redundant. `dragend` ist
      // der einzige Kanal, den es hier gibt.
      onDragEnd={() => setZieht(false)}
      onDrop={e => {
        e.preventDefault(); setZieht(false)
        const audio = nurAudio(Array.from(e.dataTransfer.files), t => toast.info(t))
        if (!audio.length) return
        setVorbelegt(audio); setDialogOffen(true)
      }}>
      {/* `pointer-events-none` ist Pflicht, nicht Kosmetik: ohne es faengt die Flaeche das
          drop-Ereignis selbst ab, und der Handler am Container darunter feuert nie. */}
      {/* Die Ansage war rein visuell (#304/Kl9) — wer den Bildschirm nicht sieht, bekam beim
          Ziehen ueber die Seite keinerlei Rueckmeldung.
          **Die Live-Region steht DAUERHAFT im Baum, nur ihr Text wechselt** — und das ist
          nicht dasselbe wie `{zieht && <div role="status">…}`. Wird eine Live-Region
          GEMEINSAM mit ihrem Inhalt eingefuegt, kuendigen mehrere Screenreader/Browser-Paare
          sie gar nicht an; angesagt wird zuverlaessig nur, was sich in einer Region aendert,
          die beim Eintreten der Aenderung schon dastand. Der erste Anlauf hatte die Rolle am
          Overlay selbst und im Kommentar die Zusage „wird vorgelesen, sobald sie erscheint" —
          eine Behauptung, die kein Test und keine Messung deckt (Reviewbefund m4).
          Kein Dauerplappern: `setZieht(true)` mit unveraendertem Wert laeuft in Reacts
          Bailout, der DOM wird nicht angefasst, und eine Live-Region sagt nur bei einer
          DOM-Aenderung etwas — `dragover` darf also beliebig oft feuern.
          Die `testid` am Container BLEIBT: er ist ein Layout-Div ohne Nutzer-Semantik, und
          ihm eine ARIA-Rolle zu geben, nur damit ein Test ihn findet, waere eine erfundene
          Landmark. Ein `drop`-Ereignis braucht ein Element, keine Bedeutung. */}
      <div role="status" className="sr-only">{zieht ? 'Zum Hinzufügen loslassen' : ''}</div>
      {zieht && (
        <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-40 flex
                        items-center justify-center border-2 border-dashed border-primary
                        bg-background/80">
          <p className="text-sm font-medium">Zum Hinzufügen loslassen</p>
        </div>
      )}
      <PageHeader rubrik="Projekt" titel={project ?? ''} zurueck="/" zurueckText="Übersicht">
        {sprachLabel && <Badge variant="outline">{sprachLabel}</Badge>}
        <Button size="sm" onClick={() => setDialogOffen(true)}>
          <Plus className="size-4" /> Material
        </Button>
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
              Noch keine Dateien. Klick oben auf „+ Material“ — die Transkription startet
              danach von selbst.
            </p>
          </div>
        )}

        {dateien.length > 0 && (
          <ul className="blatt divide-y divide-border overflow-hidden">
            {dateien.map(f => {
              // DRITTER Ort desselben Filters (#431, erst vom Review gefunden). Die
              // Arbeitsflaeche ist die Seite, auf der hochgeladen wird -- hier faellt es
              // zuerst auf. Seitdem EINE Quelle: lib/jobPhases.ts.
              const darfWarten = imBereich(phases, f.base, running)
              const darfZustand = zugelassen(phases, f.base, running)
              const active = darfZustand ? phases.active[f.base] : undefined
              const state = darfZustand ? phases.perBase[f.base] : undefined
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
                      state={state} erreicht={darfZustand ? phases.erreicht?.[f.base] : undefined}
                      jobRunning={running} inScope={darfWarten}
                      warten={darfWarten ? phases.warten?.[f.base] : undefined}
                      globalPhase={running ? (phases.globalPerBase?.[f.base] ?? (phases.scope === undefined ? phases.global : null)) : null} mitText />
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
      <MaterialDialog project={project!} offen={dialogOffen} vorbelegteDateien={vorbelegt}
        sprachChoices={sprachChoices} projektSprache={sprache} sprecherMax={sprecherMax}
        onSchliessen={() => { setDialogOffen(false); setVorbelegt([]) }}
        onFertig={(job, art) => {
          refresh(); refreshFiles()
          // Sofort adoptieren statt auf den naechsten Poll zu warten — der Balken soll
          // direkt stehen.
          if (job?.started) {
            adopt(job.job_id, project!, art ?? 'transcribe')
            toast.success(art === 'fetch' ? 'Herunterladen gestartet — Transkription folgt automatisch'
                                          : 'Transkription gestartet')
          } else if (job) {
            toast.info('Läuft schon — die neuen Dateien kommen danach dran.')
          }
        }} />
    </div>
  )
}
