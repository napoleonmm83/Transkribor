import { useMemo, useRef, useState } from 'react'
import { Bot, ChevronRight, Loader2, ScanText, Search, Upload } from 'lucide-react'
import type { ActiveJob, JobPhases, ProjectFile } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { NewProjectDialog } from './NewProjectDialog'
import { DeleteProjectDialog } from './DeleteProjectDialog'
import { ProjektUmbenennen } from './ProjektUmbenennen'
import { FileRow } from './FileRow'

type Sel = { project: string; base: string } | null
/** Nur die Zusammenfassung: die Leiste zeigt alle Projekte, aber Dateien nur fuer das
 *  aufgeklappte — die Dateiliste kommt getrennt herein (GET /api/projects/{p}). */
type SidebarProjekt = { name: string; dateien: number; geaendert: number; active_jobs?: ActiveJob[] }

export function Sidebar({
  projekte, loading, fehler, offen, dateien, dateienLaden, onWaehlen, onAngelegt,
  active, onOpen, onUpload, onTranscribe, onCorrect, onGeloescht, onUmbenannt,
  phases, jobRunning, aiReason,
}: {
  projekte: SidebarProjekt[]; loading?: boolean; fehler?: boolean
  offen: string | null
  dateien: ProjectFile[]; dateienLaden?: boolean
  onWaehlen: (name: string | null) => void
  /** Ein Projekt wurde ANGELEGT (#74). Frueher lief das ueber `onWaehlen` — der traegt
   *  aber Nebenbedeutung (`null` = zuklappen) und passte hier nur zufaellig. */
  onAngelegt: (name: string) => void
  active: Sel
  onOpen: (s: { project: string; base: string }) => void
  onUpload: (project: string, file: File) => void
  onTranscribe: (project: string) => void
  onCorrect: (project: string) => void
  /** Nach dem Loeschen: die Liste ist veraltet, und das geloeschte Projekt war das offene. */
  onGeloescht: (project: string) => void
  /** Nach dem Umbenennen: derselbe Grund, aber der Weg fuehrt zum neuen Namen statt zurueck. */
  onUmbenannt: (alt: string, neu: string) => void
  phases?: JobPhases; jobRunning?: boolean
  /** Nicht leer = kein nutzbarer KI-Anbieter: Korrigieren deaktiviert, Text als Tooltip. */
  aiReason?: string
}) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [suche, setSuche] = useState('')
  const treffer = useMemo(() => {
    const q = suche.trim().toLowerCase()
    const gefiltert = q ? projekte.filter(p => p.name.toLowerCase().includes(q)) : projekte
    // Juengstes zuerst, Name als stabiler Zweitschluessel: ohne den zweiten springen Zeilen
    // bei gleichem `geaendert` (zwei Projekte in derselben Sekunde angelegt) bei jedem Poll.
    // Das Backend sichert keine Reihenfolge zu -- es liefert os.scandir-Reihenfolge.
    return [...gefiltert].sort((a, b) => b.geaendert - a.geaendert || a.name.localeCompare(b.name, 'de'))
  }, [projekte, suche])

  return (
    <div className="flex h-full flex-col">
      {/* Das Suchfeld scrollt nicht mit: bei hunderten Projekten ist es sonst nach drei
          Zeilen weg, und die Leiste hat keinen zweiten Weg zu einem Projekt. */}
      <div className="shrink-0 space-y-2 p-2">
        {/* Einziger Weg, ohne Umweg ueber die Uebersicht ein Projekt anzulegen -- die Leiste
            ist auf jeder Seite sichtbar, der Knopf stand vorher nur in der Uebersicht. */}
        <NewProjectDialog onCreated={onAngelegt}
          trigger={<Button variant="outline" size="sm" className="w-full">+ Neues Projekt</Button>} />
        <label htmlFor="leiste-suche" className="sr-only">Projekte durchsuchen</label>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <input id="leiste-suche" type="search" value={suche} onChange={e => setSuche(e.target.value)}
            placeholder="Projekte durchsuchen…"
            className="h-8 w-full rounded-md border border-input bg-transparent py-1 pl-8 pr-2 text-sm
                       outline-none placeholder:text-muted-foreground
                       focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" />
        </div>
      </div>

      <input ref={fileInput} type="file" hidden accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.wma,.mp4"
        onChange={e => { const f = e.target.files?.[0]; if (f && offen) onUpload(offen, f); e.target.value = '' }} />

      <nav className="min-h-0 flex-1 overflow-auto px-1 pb-2" aria-label="Projekte">
        {projekte.length === 0 && loading && <p className="px-2 py-1 text-sm text-muted-foreground">lädt…</p>}
        {projekte.length === 0 && !loading && fehler && (
          <p className="px-2 py-1 text-sm text-muted-foreground">Projekte konnten nicht geladen werden.</p>
        )}
        {projekte.length === 0 && !loading && !fehler && (
          <p className="px-2 py-1 text-sm text-muted-foreground">Noch keine Projekte.</p>
        )}
        {projekte.length > 0 && treffer.length === 0 && (
          // Kein eigener "Suche leeren"-Knopf: type="search" zeichnet das native × im Feld
          // selbst -- ein zweiter Weg fuers selbe waere doppelt gemoppelt.
          <div className="px-2 py-1">
            <p className="text-sm text-muted-foreground">Kein Projekt passt zu „{suche}“.</p>
            <NewProjectDialog onCreated={onAngelegt} vorbelegung={suche}
              trigger={<Button variant="outline" size="sm" className="mt-2">„{suche}“ anlegen</Button>} />
          </div>
        )}

        {treffer.map(p => {
          const auf = offen === p.name
          return (
            <div key={p.name}>
              {/* Klick auf das offene Projekt klappt zu (onWaehlen(null)) — sonst gaebe es
                  keinen Weg zurueck zur Uebersicht ausser ueber die Adresszeile. */}
              <button type="button" onClick={() => onWaehlen(auf ? null : p.name)}
                aria-expanded={auf}
                className={cn('flex h-8 w-full items-center gap-1.5 rounded-md px-2 text-left text-sm outline-none',
                  'hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring',
                  auf && 'font-medium')}>
                <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform',
                  auf && 'rotate-90')} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                {(p.active_jobs?.length ?? 0) > 0
                  ? <Loader2 className="size-3 shrink-0 animate-spin text-primary" aria-label="läuft" />
                  : <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{p.dateien}</span>}
              </button>

              {auf && (
                <div className="mb-1 pl-4">
                  {/* Die Aktionen haengen am offenen Projekt, nicht an jeder Zeile: drei
                      Knoepfe je Zeile machen aus einer Liste eine Werkzeugleiste. */}
                  <div className="flex items-center gap-1 py-1">
                    <Button size="icon" variant="ghost" className="size-7" title="Audio hochladen"
                      aria-label="Audio hochladen" onClick={() => fileInput.current?.click()}>
                      <Upload className="size-3.5" />
                    </Button>
                    <Button size="icon" variant="ghost" className="size-7" title="Transkribieren"
                      aria-label="Transkribieren" onClick={() => onTranscribe(p.name)}>
                      <ScanText className="size-3.5" />
                    </Button>
                    {/* title am Wrapper: ein deaktivierter Knopf hat pointer-events:none
                        und zeigt seinen eigenen Tooltip nie. */}
                    <span title={aiReason || undefined} className="inline-flex">
                      <Button size="icon" variant="ghost" className="size-7" title="Korrigieren + Sprecher"
                        aria-label="Korrigieren + Sprecher" disabled={!!aiReason}
                        onClick={() => onCorrect(p.name)}>
                        <Bot className="size-3.5" />
                      </Button>
                    </span>
                    {/* Hier und nicht in der Projektzeile: ein <button> in einem <button> ist
                        ungueltiges HTML (dieselbe Falle wie beim Link in der Uebersicht).
                        Die Uebersicht zeigt nur die fuenf juengsten -- ohne diesen Weg waere
                        ein aelteres Projekt gar nicht mehr loeschbar. */}
                    <ProjektUmbenennen project={p.name} onUmbenannt={neu => onUmbenannt(p.name, neu)} />
                    <span className="ml-auto">
                      <DeleteProjectDialog project={p.name} onDeleted={() => onGeloescht(p.name)} />
                    </span>
                  </div>
                  {dateienLaden && dateien.length === 0 && (
                    <p className="px-2 py-1 text-sm text-muted-foreground">lädt…</p>
                  )}
                  {dateien.map(f => (
                    <FileRow key={f.base} project={p.name} file={f}
                      active={active?.project === p.name && active?.base === f.base}
                      onOpen={() => onOpen({ project: p.name, base: f.base })}
                      phase={jobRunning ? phases?.active[f.base]?.phase : undefined}
                      state={jobRunning ? phases?.perBase[f.base] : undefined}
                      jobRunning={jobRunning} aiReason={aiReason} />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </nav>
    </div>
  )
}
