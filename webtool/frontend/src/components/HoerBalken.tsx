import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Waveform, type WaveHandle } from '@/components/Waveform'

/** Sekunde der ersten Stelle ueber der Pegelschwelle, mit 0,25 s Vorlauf.
 *
 *  Findet GERAEUSCH, nicht Sprache — Applaus, Wind und eine zuschlagende Autotuer setzen sie
 *  genauso. Deshalb heisst der Marker „erstes Geräusch" und diese Funktion verspricht nichts
 *  anderes (Spec 5.3; das Mockup sagte noch „erste Sprache" und behauptete damit mehr, als
 *  die Messung hergibt).
 *
 *  Rueckgabe 0 heisst „von vorn": durchgehend laut ODER durchgehend still. Beides ist der
 *  richtige Ausgang — ans Ende einer stummen Datei zu springen waere der Schaden, den eine
 *  Sprunghilfe ueberhaupt anrichten kann.
 */
export function ersteStelle(peaks: Float32Array, dauer: number): number {
  // `Math.abs` auf BEIDEN Seiten, und das ist kein Feinschliff: `exportPeaks` behaelt das
  // VORZEICHEN — wavesurfer nimmt je Fenster das Sample mit dem groessten Betrag und pusht
  // es unveraendert (`wavesurfer.js:441`, nachgelesen statt angenommen). Ein lautes Fenster
  // mit negativer Spitze ist genauso laut wie eines mit positiver; ohne Betrag laese diese
  // Funktion an echtem Audio rund die Haelfte aller lauten Fenster als Stille.
  let max = 0
  for (const p of peaks) max = Math.max(max, Math.abs(p))
  // Die Wache `if (max <= 0) return 0` stand hier und ist ZURUECKGEBAUT: bei lauter Nullen
  // ist die Schwelle 0, `0 > 0` ist falsch, und das `return 0` unten faengt den Fall
  // ohnehin — gemessen, die Mutation „Wache raus" liess alle Tests gruen. Ein Waechter,
  // den kein Test rot bekommt, ist Dekoration.
  const schwelle = max * 0.22
  for (let k = 0; k < peaks.length; k++) {
    if (Math.abs(peaks[k]) > schwelle) return Math.max(0, (k / peaks.length) * dauer - 0.25)
  }
  return 0
}

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
  const [url, setUrl] = useState<string | null>(null)
  const welle = useRef<WaveHandle>(null)
  const gesprungen = useRef<string | null>(null)

  useEffect(() => {
    if (!datei) { setUrl(null); return }
    const u = URL.createObjectURL(datei)
    setUrl(u)
    // Die Aufraeumfunktion deckt ALLE Ausgaenge in einem: Dateiwechsel, Schliessen,
    // Schrittwechsel, Projektwechsel und das Verschwinden der klingenden Zeile nach einem
    // Teil-Fehlschlag. Sie laeuft NACH dem Abbau des Kindes — zuerst `Waveform` -> destroy(),
    // DANN dieses revokeObjectURL. Die umgekehrte Reihenfolge braeche die laufende
    // Wiedergabe; sie ist der Fall, den dieser Aufbau vermeidet, nicht der, der eintritt.
    // Die Reihenfolge selbst ist GELESEN, nicht gemessen — im Browser nachpruefen.
    return () => { URL.revokeObjectURL(u) }
  }, [datei])

  if (!datei || !url) return null

  return (
    <div className="border-t pt-2.5">
      <div className="mb-1 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={anzeige}>{anzeige}</span>
        <Button size="icon" variant="ghost" aria-label="Reinhören beenden" onClick={onSchliessen}>
          <X className="size-4" />
        </Button>
      </div>
      <Waveform ref={welle} url={url} onTime={() => {}}
        onBereit={(peaks, dauer) => {
          // EINMAL je Datei springen, nicht bei jedem Play: sonst kaeme man nach einem
          // bewussten Klick an den Anfang nie wieder dorthin zurueck.
          if (gesprungen.current === url) return
          gesprungen.current = url
          const t = ersteStelle(peaks, dauer)
          if (t > 0) welle.current?.springeZu(t)
        }} />
      <p className="mt-1 text-xs text-muted-foreground">
        Der Marker „erstes Geräusch" zeigt, wo Play einsetzt — Applaus und Wind zählen mit.
      </p>
    </div>
  )
}
