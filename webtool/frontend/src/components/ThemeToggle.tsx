import { Moon, Sun } from 'lucide-react'
import { useTheme } from '@/components/ThemeProvider'

/**
 * Der Umschalter zwischen hell und dunkel. Er steht in der Fusszeile und damit auf JEDER
 * Seite — vorher hing er in der Editor-Werkzeugleiste, also ausgerechnet dort, wo man beim
 * Durchsehen der Projektliste nicht ist.
 *
 * Gestalt wie der Einstellungen-Link daneben und nicht als shadcn-Icon-Button: die Zeile ist
 * 24 px hoch (`h-6`), ein Icon-Button im Standardmass (36 px) sprengte sie.
 */
export function ThemeToggle() {
  const { theme, toggle } = useTheme()
  const dunkel = theme === 'dark'
  const Icon = dunkel ? Sun : Moon
  return (
    <button type="button" onClick={toggle}
      aria-label={dunkel ? 'Zu hellem Design wechseln' : 'Zu dunklem Design wechseln'}
      className="inline-flex shrink-0 items-center gap-1 underline-offset-2 hover:text-foreground
                 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <Icon className="size-3" aria-hidden="true" /> {dunkel ? 'Hell' : 'Dunkel'}
    </button>
  )
}
