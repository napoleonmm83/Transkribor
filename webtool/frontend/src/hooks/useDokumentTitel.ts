import { useEffect } from 'react'
import { useMatch } from 'react-router-dom'
import { useDateien } from './useProjektDaten'
import { mergePhases, useActiveJob } from './useActiveJob'
import { describePhases, KIND_LABEL } from '@/lib/jobPhases'

const APP = 'Transkribor'

/**
 * Der Laufzustand steht VORNE, der Ort dahinter: in der Taskleiste und im Alt-Tab-Umschalter
 * sieht man nur die ersten Zeichen — und genau die Frage ("laeuft es noch?") ist der Grund,
 * warum diese App ueberhaupt einen sprechenden Fenstertitel braucht. Ihre Laeufe dauern
 * Minuten bis eine halbe Stunde; wer waehrenddessen etwas anderes tut, soll nicht das
 * Fenster hervorholen muessen.
 *
 * Rein und exportiert, damit die Zusammensetzung ohne Job-Verdrahtung pruefbar ist.
 */
export function fensterTitel(ort: string, lauf: string): string {
  return [lauf, ort, APP].filter(Boolean).join(' — ')
}

/**
 * Setzt `document.title` — und damit unter Electron auch den Fenstertitel: BrowserWindow
 * folgt dem Dokumenttitel ueber sein 'page-title-updated'-Ereignis, solange niemand
 * preventDefault() ruft. Ein IPC-Kanal dafuer waere ueberfluessig.
 *
 * Der Titel ist gleichzeitig der Text der eigenen Titelzeile — darum gibt der Hook ihn
 * zurueck: `document.title` zu lesen loest kein Rerender aus, ein Rueckgabewert schon.
 */
export function useDokumentTitel(): string {
  const { projekt } = useDateien()
  const { jobs } = useActiveJob()
  const imEditor = useMatch('/p/:project/:base')
  const datei = imEditor?.params.base ?? null

  // NUR die Jobs dieses Projekts: Basisnamen wiederholen sich ueber Projekte hinweg, und
  // mergePhases ist nach Basisnamen indiziert (siehe dessen Kommentar).
  const meine = jobs.filter(j => j.project === projekt && j.status === 'running')
  const lauf = meine.length
    ? (describePhases(mergePhases(meine)) || (KIND_LABEL[meine[0].kind] ?? 'läuft…'))
    : ''
  const ort = !projekt ? '' : datei ? `${projekt} · ${datei}` : projekt

  const titel = fensterTitel(ort, lauf)
  useEffect(() => { document.title = titel }, [titel])
  return titel
}
