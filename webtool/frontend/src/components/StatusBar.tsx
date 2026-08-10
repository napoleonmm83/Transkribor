import { useEffect, useState } from 'react'
import { useActiveJob } from '@/hooks/useActiveJob'
import { useUpdate } from '@/hooks/useUpdate'
import { getHardware } from '@/lib/api'
import { KIND_LABEL } from '@/lib/jobPhases'

/**
 * Die Fusszeile der App. Sie zeigt ausschliesslich, was ohnehin schon bekannt ist —
 * kein eigener Zustand, keine eigene Abfrageschleife: laufende Jobs kommen aus dem
 * JobProvider, die Version aus der Electron-Bruecke, das Rechenwerk einmalig beim Start.
 *
 * Faellt eine der drei Quellen aus, bleibt ihr Feld LEER statt einen Fehler zu tragen.
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

  return (
    <footer className="flex h-6 shrink-0 items-center gap-4 border-t bg-background px-3 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1 truncate" aria-live="polite">{text}</span>
      {rechenwerk && <span className="shrink-0">{rechenwerk}</span>}
      {zustand && (
        <span className="shrink-0 tabular-nums">
          v{zustand.version}{zustand.art === 'verfuegbar' ? ' · Update verfügbar' : ''}
        </span>
      )}
    </footer>
  )
}
