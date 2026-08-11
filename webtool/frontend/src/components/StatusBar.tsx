import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Settings } from 'lucide-react'
import { ThemeToggle } from './ThemeToggle'
import { useActiveJob } from '@/hooks/useActiveJob'
import { useUpdate } from '@/hooks/useUpdate'
import { getHardware } from '@/lib/api'
import { KIND_LABEL } from '@/lib/jobPhases'
import type { UpdateZustand } from '@/lib/types'

/**
 * Was in der Fusszeile ueber ein Update steht — `null`, solange es nichts zu tun gibt.
 *
 * Bewusst nur die Zustaende, die eine Handlung nach sich ziehen: „aktuell“ und „prueft“
 * sind Rauschen in einer Zeile, die man dauernd im Blick hat. Der Text fuehrt in die
 * Einstellungen, wo die vollstaendige Steuerung steht — die sechs Zustaende samt
 * Fortschrittsbalken und Protokoll-Link ein zweites Mal in 24 px Hoehe nachzubauen,
 * waere zwei Fassungen derselben Sache.
 */
function updateHinweis(z: UpdateZustand | null): string | null {
  if (!z) return null
  if (z.art === 'verfuegbar' || z.art === 'verfuegbar_manuell') return `Update ${z.neue} verfügbar`
  if (z.art === 'laedt') return `Update lädt · ${Math.round(z.prozent)} %`
  if (z.art === 'bereit') return `Update ${z.neue} bereit`
  if (z.art === 'fehler') return 'Update-Prüfung fehlgeschlagen'
  return null
}

/**
 * Die Fusszeile der App. Sie zeigt ausschliesslich, was ohnehin schon bekannt ist —
 * kein eigener Zustand, keine eigene Abfrageschleife: laufende Jobs kommen aus dem
 * JobProvider, der Update-Zustand aus der Electron-Bruecke, das Rechenwerk einmalig
 * beim Start.
 *
 * Faellt eine der Quellen aus, bleibt ihr Feld LEER statt einen Fehler zu tragen.
 * Eine Statuszeile, in der Fehlermeldungen stehen, ist eine, die man ausblendet.
 */
export function StatusBar() {
  const { jobs } = useActiveJob()
  const { zustand } = useUpdate()
  const [rechenwerk, setRechenwerk] = useState('')

  // Einmal je Serverlauf ermittelt (GET /api/hardware ist auf der Backend-Seite gecacht) —
  // ein Poll waere hier sinnlos, die Grafikkarte wechselt nicht zur Laufzeit.
  useEffect(() => { getHardware().then(h => setRechenwerk(h.asr)).catch(() => {}) }, [])

  const laufend = jobs.filter(j => j.status === 'running')
  const text = laufend.length === 0
    ? 'Bereit'
    : `${laufend.length} ${laufend.length === 1 ? 'Lauf' : 'Läufe'} · ` +
      laufend.map(j => `${j.project}: ${KIND_LABEL[j.kind] ?? j.kind}`).join(' · ')

  const hinweis = updateHinweis(zustand)
  // Electron kennt die Version der LAUFENDEN App; im Browser gibt es die Bruecke nicht,
  // dort ist der zur Bauzeit eingesetzte Wert die einzige — und richtige — Quelle.
  const version = zustand?.version ?? __APP_VERSION__

  return (
    // col-span-1 md:col-span-2: auf breiten Fenstern steht sie neben der Leiste in einer
    // eigenen Spalte -- ohne den Span reichte sie nur unter die Inhaltsspalte.
    <footer className="col-span-1 flex h-6 shrink-0 items-center gap-4 border-t bg-background px-3 text-xs text-muted-foreground md:col-span-2">
      <span className="min-w-0 flex-1 truncate" aria-live="polite">{text}</span>
      {hinweis && (
        // aria-live: ein Update taucht auf, ohne dass jemand etwas angeklickt hat.
        <Link to="/einstellungen" aria-live="polite"
          className="shrink-0 font-medium text-primary underline-offset-2 hover:underline
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {hinweis}
        </Link>
      )}
      {/* Der einzige Weg zu den Einstellungen stand bisher auf der Uebersicht -- aus dem
          Editor musste man erst dorthin zurueck. Die Fusszeile ist auf JEDER Seite da. */}
      <Link to="/einstellungen"
        className="inline-flex shrink-0 items-center gap-1 underline-offset-2 hover:text-foreground
                   hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Settings className="size-3" aria-hidden="true" /> Einstellungen
      </Link>
      {/* Aus derselben Not wie der Einstellungen-Link: er stand nur in der Editor-Leiste. */}
      <ThemeToggle />
      {rechenwerk && <span className="shrink-0">{rechenwerk}</span>}
      <span className="shrink-0 tabular-nums">v{version}</span>
    </footer>
  )
}
