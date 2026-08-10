import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectFile } from '@/lib/types'
import { getProjectFiles } from '@/lib/api'

/** Dateien EINES Projekts. Kein Poll: die Arbeitsflaeche/der Editor erfahren Aenderungen ueber
 *  den Job-Status (useActiveJob.onSettled bzw. useJob's onDone) und rufen refresh() dort selbst
 *  — ein zweiter Poll hier waere genau die Verdopplung, die diese Aufteilung abschaffen soll. */
export function useProjectFiles(project: string) {
  const [files, setFiles] = useState<ProjectFile[]>([])
  const [loading, setLoading] = useState(true)
  // Getrennt von "leer": ohne das Flag sah eine gescheiterte Anfrage wie ein Projekt ohne
  // Dateien aus, und die Arbeitsflaeche zeigte "Noch keine Dateien" als Tatsache statt eines
  // Fehlers. Gesetzt im .catch, zurueckgesetzt bei jedem erfolgreichen Laden.
  const [fehler, setFehler] = useState(false)
  // Traegt das GERADE angefragte Projekt. useProjects nutzt fuer sowas ein simples laeuft-Ref
  // ("eine langsame Antwort darf keine Anfragen aufstauen") — das passt dort, weil es dort NUR
  // einen unparametrisierten Poll gibt, wo ein uebersprungener Aufruf folgenlos ist. Hier haengt
  // die Anfrage an `project`: derselbe Guard wuerde beim Wechsel von project mitten in einer
  // laufenden Anfrage den neuen refresh() lautlos ueberspringen (laeuft.current noch true von der
  // alten Anfrage) UND, kaeme die alte Antwort danach herein, die Dateien des verlassenen
  // Projekts in den State des neuen schreiben. Darum hier: nie uebersprungen, sondern jede
  // Antwort gegen das inzwischen aktuelle Projekt geprueft und verworfen, wenn sie nicht passt.
  // Gilt fuer fehler genauso: ein Fehler des verlassenen Projekts darf den neuen nicht anfassen.
  const angefragt = useRef(project)
  // Zusaetzlich zum Projektbezug: eine monoton steigende Kennung je Aufruf. angefragt allein
  // schuetzt nur gegen den Projektwechsel, nicht gegen ZWEI ueberlappende Anfragen fuers SELBE
  // Projekt (seit W1 koennen der Summenpoll-Waechter und onSettled im selben Zyklus feuern) --
  // kommt die aeltere Antwort zuletzt an, ueberschriebe sie sonst die juengere. Beide Pruefungen
  // bleiben nebeneinander stehen, keine ersetzt die andere.
  const kennung = useRef(0)
  const refresh = useCallback(() => {
    angefragt.current = project
    if (!project) {
      // Leeres Projekt ist "nichts zu laden", nicht "laedt noch" -- sonst zeigt jede Seite ohne
      // aufgeklapptes Projekt (Galerie, Einstellungen, kuenftig die Seitenleiste) einen ewigen
      // Ladezustand, weil `loading` auf seinem Initialwert true haengen bliebe. `angefragt` ist
      // trotzdem aktualisiert: eine noch fliegende Antwort des VERLASSENEN Projekts darf die
      // (leeren) Dateien jetzt nicht mehr ueberschreiben.
      setFiles([]); setFehler(false); setLoading(false)
      return
    }
    const meineKennung = ++kennung.current
    const aktuell = () => angefragt.current === project && meineKennung === kennung.current
    getProjectFiles(project)
      .then(r => { if (aktuell()) { setFiles(r.files); setFehler(false) } })
      .catch(() => { if (aktuell()) setFehler(true) })
      .finally(() => { if (aktuell()) setLoading(false) })
  }, [project])
  useEffect(() => { refresh() }, [refresh])
  return { files, loading, fehler, refresh }
}
