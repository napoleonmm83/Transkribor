import { useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Waveform, type WaveHandle } from '@/components/Waveform'

import { ersteStelle } from '@/lib/ersteStelle'

/** Der EINE Abspieler unter der Liste (P1). Die Welle wechselt den Inhalt, die Liste springt nie.
 *
 *  Rendert `null`, wenn nichts klingt — dadurch sind „Balken weg" und „Blob frei" DERSELBE
 *  Vorgang und koennen nicht auseinanderlaufen.
 *
 *  Transport (Play/Pause/Stop, mm:ss) kommt aus `Waveform` selbst; hier stehen nur Kopf,
 *  Sprunghinweis und der Lebenszyklus der Blob-URL.
 */
export function HoerBalken({ datei, anzeige, onSchliessen }: {
  datei: File | null        // null = geschlossen, nichts klingt
  anzeige: string
  onSchliessen: () => void
}) {
  const [ressource, setRessource] = useState<{ datei: File; url: string } | null>(null)
  const url = ressource?.datei === datei ? ressource.url : null
  const welle = useRef<WaveHandle>(null)
  const gesprungen = useRef<string | null>(null)

  // Die Blob-URL ist eine externe Ressource. Erst ein Commit darf sie erzeugen;
  // der zugehoerige Cleanup gibt genau diese URL frei. setRessource veroeffentlicht die
  // Ressource fuer Waveform, statt sie in einem abbrechbaren Render zu erzeugen.
  useEffect(() => {
    if (!datei) { setRessource(null); return }
    const u = URL.createObjectURL(datei)
    setRessource({ datei, url: u })
    // Die Aufraeumfunktion deckt ALLE Ausgaenge in einem: Dateiwechsel, Schliessen,
    // Schrittwechsel, Projektwechsel und das Verschwinden der klingenden Zeile nach einem
    // Teil-Fehlschlag. Sie laeuft NACH dem Abbau des Kindes — zuerst `Waveform` -> destroy(),
    // DANN dieses revokeObjectURL. Die umgekehrte Reihenfolge braeche die laufende
    // Wiedergabe; sie ist der Fall, den dieser Aufbau vermeidet, nicht der, der eintritt.
    // Die Reihenfolge selbst ist GELESEN, nicht gemessen — im Browser nachpruefen.
    return () => { URL.revokeObjectURL(u) }
  }, [datei])

  // `useCallback` ist hier KEIN Feinschliff: `onBereit` steht in den Abhaengigkeiten des
  // ready-Effekts in `Waveform`, und eine inline erzeugte Funktion wechselt bei JEDEM Render
  // die Identitaet. Der Dialog rendert bei jedem Tastendruck in einem Sprecherfeld — der
  // Effekt liefe also je Tastendruck erneut durch `exportPeaks()`, und das iteriert ueber die
  // vollstaendigen Kanaldaten (bei 30 Minuten ~79 Mio. Samples je Kanal).
  const bereit = useCallback((peaks: Float32Array, dauer: number) => {
    // EINMAL je Datei springen, nicht bei jedem Play: sonst kaeme man nach einem bewussten
    // Klick an den Anfang nie wieder dorthin zurueck.
    if (gesprungen.current === url) return
    gesprungen.current = url
    const t = ersteStelle(peaks, dauer)
    if (t > 0) welle.current?.springeZu(t)
  }, [url])

  if (!datei || !url) return null

  return (
    <div className="border-t pt-2.5">
      <div className="mb-1 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={anzeige}>{anzeige}</span>
        <Button size="icon" variant="ghost" aria-label="Reinhören beenden" onClick={onSchliessen}>
          <X className="size-4" />
        </Button>
      </div>
      <Waveform ref={welle} url={url} onTime={() => {}} onBereit={bereit} />
      <p className="mt-1 text-xs text-muted-foreground">
        Der Marker „erstes Geräusch" zeigt, wo Play einsetzt — Applaus und Wind zählen mit.
      </p>
    </div>
  )
}
