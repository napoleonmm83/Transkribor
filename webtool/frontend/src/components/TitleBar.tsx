import { cn } from '@/lib/utils'

/** Vorhanden = wir laufen unter Electron. Im Browser (webtool.ps1 :8000, Vite :5173) fehlt
 *  das Objekt, und dann gibt es weder ein rahmenloses Fenster noch etwas zu zeichnen. */
function plattform(): string | null {
  const w = window as unknown as { transkribor?: { plattform?: string } }
  return w.transkribor?.plattform ?? null
}

/** Steuert diese Zeile ein Rasterelement bei? Das Raster der AppShell muss dieselbe Antwort
 *  kennen wie die Komponente selbst — sonst hat es im Browser eine Zeile zu viel. */
export function hatTitelzeile(): boolean { return plattform() !== null }

/**
 * Die eigene Titelzeile. Sie zeichnet NUR Text — Minimieren/Maximieren/Schliessen legt das
 * Betriebssystem als Overlay darueber (Windows/Linux) bzw. laesst seine Ampelknoepfe stehen
 * (macOS, 'hiddenInset'). Darum die Rand-Reserven: links auf macOS, rechts sonst.
 *
 * app-region: drag macht die Zeile zum Ziehgriff; ohne user-select:none faengt ein
 * Ziehversuch stattdessen an, den Titel zu markieren.
 */
export function TitleBar({ titel }: { titel: string }) {
  const p = plattform()
  if (!p) return null
  const mac = p === 'darwin'
  return (
    <header role="banner"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      className={cn(
        // col-span-1: unter `md` gibt es nur eine Rasterspalte, die Leiste faellt weg.
        // h-10 = TITELLEISTE_HOEHE in electron/fenster.js: das Betriebssystem-Overlay legt sich
        // ueber genau diese Zeile, nicht daneben -- laufen die Zahlen auseinander, sitzen die
        // Fensterknoepfe versetzt zum Text.
        'col-span-1 flex h-10 shrink-0 select-none items-center border-b bg-background md:col-span-2',
        // Reserve fuer die Knoepfe, die NICHT wir malen. Ohne sie liegt der Titel darunter.
        mac ? 'pl-[78px] pr-3' : 'pl-3 pr-[140px]',
      )}>
      <span className="min-w-0 flex-1 truncate text-center text-xs font-medium text-muted-foreground">
        {titel}
      </span>
    </header>
  )
}
