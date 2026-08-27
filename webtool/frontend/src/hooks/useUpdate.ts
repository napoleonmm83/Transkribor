import { useCallback, useEffect, useState } from 'react'
import type { UpdateZustand } from '@/lib/types'

type Bruecke = {
  update: {
    status: () => Promise<UpdateZustand | null>   // null: der Automat wurde nicht gebaut
    pruefen: () => Promise<void>
    laden: () => Promise<void>
    installieren: () => Promise<void>
  }
  protokollOeffnen: () => Promise<string>
  /** #372: baut den Bericht im Hauptprozess und oeffnet ihn im Mailprogramm. */
  fehlerbericht: () => Promise<{ pfad: string; verwendet: number; gekuerzt: boolean }>
  on: (kanal: string, fn: (z: UpdateZustand) => void) => () => void   // Rueckgabe: Abmelden
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
    // Abmelden beim Unmount: die Einstellungsseite ist eine Route, ohne das haeuft
    // wiederholtes Verlassen+Oeffnen Hoerer an.
    return b.on('update', setZustand)
  }, [])

  const pruefen = useCallback(() => { bruecke()?.update.pruefen().catch(() => {}) }, [])
  const laden = useCallback(() => { bruecke()?.update.laden().catch(() => {}) }, [])
  const installieren = useCallback(() => { bruecke()?.update.installieren().catch(() => {}) }, [])
  const protokollOeffnen = useCallback(() => { bruecke()?.protokollOeffnen().catch(() => {}) }, [])
  // Reicht das Versprechen DURCH, anders als die vier darueber: `openExternal` lehnt ab, wenn
  // kein Mailprogramm registriert ist, und das ist keine Randlage (frische Windows-
  // Installation, Linux ohne xdg-Handler). Blind geschluckt taete der Knopf sichtbar nichts,
  // waehrend die Seite eine Zeile darueber eine vorbereitete Mail verspricht.
  const fehlerbericht = useCallback(() => bruecke()?.fehlerbericht(), [])

  return { zustand, pruefen, laden, installieren, protokollOeffnen, fehlerbericht }
}
