import { CircleHelp, Download, Save, Subtitles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ExportFmt } from '@/lib/api'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { FLAGS } from './SegmentView'
import { ThemeToggle } from './ThemeToggle'

export function Toolbar({ title, dirty, canSave, onSave, onExport }: {
  title: string; dirty: boolean; canSave: boolean;
  onSave: () => void; onExport: (fmt: ExportFmt) => void;
}) {
  return (
    // Kein sticky noetig: EditorView setzt die Leiste als eigene Grid-Zeile, gescrollt wird
    // nur das <main> darunter.
    <header className="flex items-center gap-2 border-b px-3 py-2">
      <span className="min-w-0 truncate text-sm font-medium">{title}</span>
      {dirty && (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="size-1.5 rounded-full bg-amber-500" aria-hidden="true" />
          ungespeichert
        </span>
      )}
      <div className="flex-1" />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="icon" variant="ghost" aria-label="Legende"><CircleHelp className="size-4" /></Button>
        </TooltipTrigger>
        {/* Symbole aus derselben Quelle wie die Segmente (FLAGS) — vorher standen sie doppelt
            im Code und konnten auseinanderlaufen. Die Wortfarben stehen seit dem Wegfall der
            Schwellen-Schieber nur noch hier: sonst erklaert sie im Editor nichts mehr. */}
        <TooltipContent className="max-w-80">
          <span className="flex flex-col gap-2.5">
            {FLAGS.map(f => (
              <span key={f.key} className="flex gap-1.5">
                <f.icon className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                <span>{f.titel} — <span className="opacity-70">{f.erklaerung}</span></span>
              </span>
            ))}
            <span className="border-t pt-2 opacity-70">
              Im unkorrigierten Text markiert die Farbe, wie sicher sich Whisper beim einzelnen
              Wort war: <span className="u-yellow">unsicher</span> unter 0.60,{' '}
              <span className="u-red">sehr unsicher</span> unter 0.40. Der genaue Wert steht im
              Tooltip des Wortes.
            </span>
          </span>
        </TooltipContent>
      </Tooltip>
      <Button size="sm" variant="secondary" disabled={!canSave} onClick={onSave}>
        <Save className="size-4" /> Speichern
      </Button>
      <Button size="sm" variant="secondary" disabled={!canSave} onClick={() => onExport('md')}>
        <Download className="size-4" /> Export .md
      </Button>
      {/* .srt laedt man bei YouTube unter "Untertitel > Datei hochladen" hoch. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="sm" variant="secondary" disabled={!canSave} onClick={() => onExport('srt')}>
            <Subtitles className="size-4" /> Untertitel .srt
          </Button>
        </TooltipTrigger>
        <TooltipContent>Zeitcodierte Untertitel für den YouTube-Upload</TooltipContent>
      </Tooltip>
      <ThemeToggle />
    </header>
  )
}
