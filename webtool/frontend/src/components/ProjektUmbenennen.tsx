import { useState } from 'react'
import { TextCursorInput } from 'lucide-react'
import { renameProject } from '@/lib/api'
import { useEditorBruecke } from '@/hooks/useEditorBruecke'
import { Button } from '@/components/ui/button'
import { UmbenennenDialog } from './UmbenennenDialog'

/**
 * Knopf + Dialog zum Umbenennen eines Projekts — Zwilling von DeleteProjectDialog: er ruft die
 * API selbst und meldet nur das Ergebnis, statt drei Handler durch die Leiste zu reichen.
 *
 * Die Rueckfrage bei Ungespeichertem holt er sich aus der Editor-Bruecke (wie DateiMenue):
 * das Projekt umzubenennen aendert den Pfad des offenen Dokuments, der Editor laedt darauf neu.
 */
export function ProjektUmbenennen({ project, onUmbenannt }: {
  project: string; onUmbenannt: (neu: string) => void
}) {
  const [offen, setOffen] = useState(false)
  const editor = useEditorBruecke()

  const speichern = async (neu: string) => {
    const e = editor.current
    if (e?.project === project && e.dirty && !window.confirm(
      'Im Editor stehen ungespeicherte Änderungen.\n\n'
      + 'Beim Umbenennen wird das Dokument neu geladen — sie gehen verloren.')) return false
    onUmbenannt((await renameProject(project, neu)).name)
  }

  return (
    <>
      <Button size="icon" variant="ghost" className="size-7" title="Projekt umbenennen"
        aria-label={`Projekt ${project} umbenennen`} onClick={() => setOffen(true)}>
        <TextCursorInput className="size-3.5" />
      </Button>
      <UmbenennenDialog offen={offen} onOpenChange={setOffen} wert={project}
        titel="Projekt umbenennen"
        beschreibung="Der Ordner wird umbenannt, alle Aufnahmen wandern mit. Nichts wird neu gerechnet."
        onSpeichern={speichern} />
    </>
  )
}
