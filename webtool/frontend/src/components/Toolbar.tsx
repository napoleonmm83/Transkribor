import { CircleHelp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ThemeToggle } from './ThemeToggle'

export function Toolbar({ title, dirty, canSave, onSave, onExport, settings }: {
  title: string; dirty: boolean; canSave: boolean;
  onSave: () => void; onExport: () => void; settings: React.ReactNode;
}) {
  return (
    <header className="flex items-center gap-2 border-b px-3 py-2">
      <span className="text-sm font-medium truncate">{title}</span>
      {dirty && <span className="text-xs text-muted-foreground">● ungespeichert</span>}
      <div className="flex-1" />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="icon" variant="ghost" aria-label="Flags-Legende"><CircleHelp className="size-4" /></Button>
        </TooltipTrigger>
        <TooltipContent>⚠ Halluzination · 🔇 Stille · ~ geringe Konfidenz</TooltipContent>
      </Tooltip>
      {settings}
      <Button size="sm" variant="secondary" disabled={!canSave} onClick={onSave}>Speichern</Button>
      <Button size="sm" variant="secondary" disabled={!canSave} onClick={onExport}>Export .md</Button>
      <ThemeToggle />
    </header>
  )
}
