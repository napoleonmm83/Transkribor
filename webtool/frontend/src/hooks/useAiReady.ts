import { useEffect, useState } from 'react'
import { getSettings } from '@/lib/api'

/** Warum die Korrektur gerade nicht laufen kann — Leerstring heisst: sie kann.
 *
 *  Ohne dieses Gate klickt ein frisch installierter Nutzer „Korrigieren", bekommt ein
 *  „gestartet"-Toast, und der Job endet gruen, ohne eine einzige Datei angefasst zu haben.
 *  Das ist ein schlechterer erster Eindruck als ein Job, der ehrlich scheitert.
 *
 *  Faellt die Abfrage selbst aus, bleiben die Knoepfe aktiv: eine Oberflaeche, die sich
 *  wegen eines Netzwerkfehlers selbst abschaltet, waere schlimmer als ein Job, der etwas sagt.
 */
export function useAiReady() {
  const [grund, setGrund] = useState('')
  useEffect(() => {
    getSettings()
      .then(s => setGrund(s.ai_ready ? ''
        : `${s.ai_reason || 'Kein KI-Anbieter eingerichtet.'} Unter „Einstellungen" einrichten.`))
      .catch(() => setGrund(''))
  }, [])
  return grund
}
