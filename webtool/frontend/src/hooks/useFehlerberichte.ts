import { useCallback, useEffect, useState } from 'react'

export type FehlerberichteZustand = { automatisch: boolean; gefragt: string | null }

type Bruecke = {
  fehlerberichte: {
    status: () => Promise<FehlerberichteZustand>
    setzen: (an: boolean) => Promise<FehlerberichteZustand>
  }
}

/** Eigene Weiche, nicht die aus `useUpdate`: eine ältere App-Hülle hat `update`, aber noch
 *  keinen Schalter — dann fehlt der Haken, statt dass ein Klick ins Leere läuft. */
function bruecke(): Bruecke | null {
  const w = window as unknown as { transkribor?: Partial<Bruecke> }
  return w.transkribor?.fehlerberichte ? (w.transkribor as Bruecke) : null
}

/**
 * Der Opt-in-Schalter für automatische Fehlerberichte (#530). `null` heisst: keine Brücke —
 * im Browser oder in einer App-Hülle ohne den Schalter gibt es den Haken nicht.
 * `zustand` ist `null`, bis der Hauptprozess geantwortet hat (Haken solange gesperrt).
 */
export function useFehlerberichte() {
  const [da] = useState(() => bruecke() !== null)
  const [zustand, setZustand] = useState<FehlerberichteZustand | null>(null)

  useEffect(() => {
    bruecke()?.fehlerberichte.status().then(setZustand).catch(() => {})
  }, [])

  // Reicht das Versprechen DURCH (wie `fehlerbericht` in useUpdate): schlägt das Schreiben
  // fehl, soll der Haken nicht so tun, als stünde er.
  const setzen = useCallback((an: boolean) => {
    const b = bruecke()
    if (!b) return Promise.reject(new Error('keine Brücke'))
    return b.fehlerberichte.setzen(an).then(z => { setZustand(z); return z })
  }, [])

  return da ? { zustand, setzen } : null
}
