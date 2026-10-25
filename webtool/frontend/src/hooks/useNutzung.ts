import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'

/** Genau das, was einmal am Tag gesendet wird — die App zeigt dieses Objekt unverändert an. */
export type Nutzlast = { geraet: string; version: string; plattform: string }
export type NutzungZustand = { an: boolean; gefragt: string | null; zuletzt: string | null; nutzlast: Nutzlast | null }

type Bruecke = {
  nutzung: {
    status: () => Promise<NutzungZustand>
    setzen: (an: boolean) => Promise<NutzungZustand>
  }
}

function bruecke(): Bruecke | null {
  const w = window as unknown as { transkribor?: Partial<Bruecke> }
  return w.transkribor?.nutzung ? (w.transkribor as Bruecke) : null
}

// Geteilter Speicher wie in useFehlerberichte (#541): Erststart-Frage und Versionsseite
// sind gleichzeitig gemountet und müssen dieselbe Antwort sehen.
let speicher: NutzungZustand | null = null
const hoerer = new Set<() => void>()
let runde = 0

function eintragen(z: NutzungZustand): void {
  speicher = z
  for (const h of hoerer) h()
}

/** Opt-in Nutzungszählung. `null` heisst: keine Brücke (Browser oder ältere App-Hülle). */
export function useNutzung() {
  const [da] = useState(() => bruecke() !== null)
  const zustand = useSyncExternalStore(
    useCallback((hoert: () => void) => { hoerer.add(hoert); return () => { hoerer.delete(hoert) } }, []),
    () => speicher,
  )

  useEffect(() => {
    const b = bruecke()
    if (!b) return
    const meine = ++runde
    b.nutzung.status().then(z => { if (meine === runde) eintragen(z) }).catch(() => {})
  }, [])

  const setzen = useCallback((an: boolean) => {
    const b = bruecke()
    if (!b) return Promise.reject(new Error('keine Brücke'))
    const meine = ++runde
    return b.nutzung.setzen(an).then(z => { if (meine === runde) eintragen(z); return z })
  }, [])

  return da ? { zustand, setzen } : null
}

/** Nur für Tests. */
export function _zuruecksetzen(): void {
  speicher = null
  hoerer.clear()
  runde = 0
}
