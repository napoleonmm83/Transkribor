import { useState } from 'react'
import { toast } from 'sonner'
import { Trash2 } from 'lucide-react'
import { deleteProject } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog'

export function DeleteProjectDialog({ project, onDeleted, offen, onOpenChange }: {
  project: string; onDeleted: () => void
  /** Von aussen gesteuert (ProjektMenue): dann OHNE eigenen Knopf. Ein Dialog-Trigger IM
   *  Menue wird beim Schliessen des Menues mit ausgehaengt — dieselbe Falle, die in
   *  DateiMenue schon dazu fuehrte, die Dialoge neben das Menue zu stellen. */
  offen?: boolean; onOpenChange?: (o: boolean) => void
}) {
  const gesteuert = offen !== undefined
  const [eigen, setEigen] = useState(false)
  const [confirm, setConfirm] = useState('')
  const open = gesteuert ? offen : eigen
  const setOpen = (o: boolean) => { if (gesteuert) onOpenChange?.(o); else setEigen(o) }
  const del = async () => {
    try { await deleteProject(project) } catch (e) { toast.error(`Löschen fehlgeschlagen: ${(e as Error).message}`); return }
    setOpen(false); onDeleted()
  }
  return (
    <AlertDialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setConfirm('') }}>
      {!gesteuert && (
        <AlertDialogTrigger asChild>
          <Button size="icon" variant="ghost" className="size-6" title="Projekt löschen" aria-label={`Projekt ${project} löschen`}>
            <Trash2 className="size-3.5" />
          </Button>
        </AlertDialogTrigger>
      )}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Projekt „{project}“ löschen?</AlertDialogTitle>
          <AlertDialogDescription>
            Löscht alle Audio- und Transkript-Dateien unwiderruflich. Zum Bestätigen den Projektnamen eintippen.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Input aria-label="Projektname bestätigen" value={confirm} onChange={e => setConfirm(e.target.value)} placeholder={project} />
        <AlertDialogFooter>
          <AlertDialogCancel>Abbrechen</AlertDialogCancel>
          <Button variant="destructive" disabled={confirm !== project} onClick={del}>Löschen</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
