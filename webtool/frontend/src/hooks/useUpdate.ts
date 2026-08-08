import { useCallback, useEffect, useState } from 'react'
import type { UpdateZustand } from '@/lib/types'

type Bruecke = {
  update: {
    status: () => Promise<UpdateZustand>
    pruefen: () => Promise<void>
    laden: () => Promise<void>
    installieren: () => Promise<void>
  }
  on: (kanal: string, fn: (z: UpdateZustand) => void) => void
}

function bruecke(): Bruecke | null {
  const w = window as unknown as { transkribor?: Bruecke }
  return w.transkribor?.update ? w.transkribor : null
}

/** Update-Zustand aus Electron. `null` heisst: laeuft im normalen Browser, es gibt hier
 *  keine Updates — die Einstellungen blenden den Abschnitt dann aus. */
export function useUpdate() {
  const [zustand, setZustand] = useState<UpdateZustand | null>(null)

  useEffect(() => {
    const b = bruecke()
    if (!b) return
    b.update.status().then(setZustand).catch(() => {})
    // Jede Aenderung wird geschoben — kein Polling, der Fortschritt kaeme sonst ruckelig an.
    b.on('update', setZustand)
  }, [])

  const pruefen = useCallback(() => { bruecke()?.update.pruefen().catch(() => {}) }, [])
  const laden = useCallback(() => { bruecke()?.update.laden().catch(() => {}) }, [])
  const installieren = useCallback(() => { bruecke()?.update.installieren().catch(() => {}) }, [])

  return { zustand, pruefen, laden, installieren }
}
