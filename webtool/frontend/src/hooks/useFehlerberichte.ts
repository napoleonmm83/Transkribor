import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'

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
 * Der Modul-Level-Store (#541). Der Hook hat ZWEI gleichzeitig gemountete Verwender — der
 * Zustimmungs-Dialog hängt app-weit in App.tsx, der Haken auf der Version-Seite — und bis hierher
 * hielt jede Instanz ihre eigene Kopie: antwortete der Dialog, zeigte der Haken das Gegenteil
 * der Datei. Jede Instanz, die schreibt (Dialog-Antwort wie Haken-Klick), trägt das Ergebnis
 * HIER ein und meldet alle Hörer — jede mountete Instanz sieht jede Änderung, ohne Neuladen.
 */
let speicher: FehlerberichteZustand | null = null
const hoerer = new Set<() => void>()

/**
 * Nur der JÜNGSTE Abruf darf eintragen. Mit dem heutigen Hauptprozess ist Überholen
 * strukturell aus (ipcMain-Handler sind synchron, die Antworten lösen in Absenderordnung
 * auf) — aber der Hook steht auf der Brücke-Schnittstelle, nicht auf dieser Implementierung:
 * ein künftiger asynchroner Handler öffnete das Fenster still. CodeRabbit-Major am Store.
 */
let runde = 0

function eintragen(z: FehlerberichteZustand): void {
  speicher = z
  for (const h of hoerer) h()
}

/**
 * Der Opt-in-Schalter für automatische Fehlerberichte (#530). `null` heisst: keine Brücke —
 * im Browser oder in einer App-Hülle ohne den Schalter gibt es den Haken nicht.
 * `zustand` ist `null`, bis der Hauptprozess geantwortet hat (Haken solange gesperrt).
 */
export function useFehlerberichte() {
  const [da] = useState(() => bruecke() !== null)
  const zustand = useSyncExternalStore(
    useCallback((hoert: () => void) => { hoerer.add(hoert); return () => { hoerer.delete(hoert) } }, []),
    () => speicher,
  )

  // Bei JEDEM Mount frisch holen (nicht nur wenn der Speicher leer ist): der Mount ist der
  // billigste Weg, eine zwischenzeitliche Fremdänderung einzufangen — und die Antwort ist
  // ohnehin dieselbe Datei.
  useEffect(() => {
    const b = bruecke()
    if (!b) return
    const meine = ++runde
    b.fehlerberichte.status().then(z => { if (meine === runde) eintragen(z) }).catch(() => {})
  }, [])

  // Reicht das Versprechen DURCH (wie `fehlerbericht` in useUpdate): schlägt das Schreiben
  // fehl, soll der Haken nicht so tun, als stünde er. Die Antwort trägt den Runde-Wächter:
  // ein zwischendurch gestarteter, langsamer status()-Abruf darf die bestätigte Schreibung
  // nicht mehr überschreiben.
  const setzen = useCallback((an: boolean) => {
    const b = bruecke()
    if (!b) return Promise.reject(new Error('keine Brücke'))
    const meine = ++runde
    return b.fehlerberichte.setzen(an).then(z => { if (meine === runde) eintragen(z); return z })
  }, [])

  return da ? { zustand, setzen } : null
}

/** Nur für Tests: setzt den Modul-Speicher zurück, sonst trägt jeder Test den Zustand des
 *  vorigen in den seinen (Muster `_home` in electron/fehlerberichte.js). */
export function _zuruecksetzen(): void {
  speicher = null
  hoerer.clear()
  runde = 0
}
