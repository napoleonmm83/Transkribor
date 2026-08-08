import { CircleHelp, Download, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { FLAGS } from './SegmentView'
import { ThemeToggle } from './ThemeToggle'

export function Toolbar({ title, dirty, canSave, onSave, onExport, settings }: {
  title: string; dirty: boolean; canSave: boolean;
  onSave: () => void; onExport: () => void; settings: React.ReactNode;
}) {
  return (
    // Kein sticky noetig: EditorView setzt die Leiste als eigene Grid-Zeile, gescrollt wird
    // nur das <main> darunter.
    <header className="flex items-center gap-2 border-b px-3 py-2">
      <span className="truncate text-sm font-medium">{title}</span>
      {dirty && (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="size-1.5 rounded-full bg-amber-500" aria-hidden="true" />
          ungespeichert
        </span>
      )}
      <div className="flex-1" />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="icon" variant="ghost" aria-label="Flags-Legende"><CircleHelp className="size-4" /></Button>
        </TooltipTrigger>
        {/* Legende aus derselben Quelle wie die Segmente (FLAGS) — vorher standen die
            Symbole doppelt im Code und konnten auseinanderlaufen. */}
        <TooltipContent>
          <span className="flex flex-col gap-1">
            {FLAGS.map(f => (
              <span key={f.key} className="flex items-center gap-1.5">
                <f.icon className="size-3" aria-hidden="true" /> {f.titel}
              </span>
            ))}
          </span>
        </TooltipContent>
      </Tooltip>
      {settings}
      <Button size="sm" variant="secondary" disabled={!canSave} onClick={onSave}>
        <Save className="size-4" /> Speichern
      </Button>
      <Button size="sm" variant="secondary" disabled={!canSave} onClick={onExport}>
        <Download className="size-4" /> Export .md
      </Button>
      <ThemeToggle />
    </header>
  )
}
