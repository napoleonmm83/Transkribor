import { useState } from 'react'
import { toast } from 'sonner'
import { Trash2 } from 'lucide-react'
import { deleteProject } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog'

export function DeleteProjectDialog({ project, onDeleted }: { project: string; onDeleted: () => void }) {
  const [confirm, setConfirm] = useState('')
  const del = async () => {
    try { await deleteProject(project) } catch (e) { toast.error(`Löschen fehlgeschlagen: ${(e as Error).message}`); return }
    onDeleted()
  }
  return (
    <AlertDialog onOpenChange={() => setConfirm('')}>
      <AlertDialogTrigger asChild>
        <Button size="icon" variant="ghost" className="size-6" title="Projekt löschen" aria-label={`Projekt ${project} löschen`}>
          <Trash2 className="size-3.5" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Projekt „{project}" löschen?</AlertDialogTitle>
          <AlertDialogDescription>
            Löscht alle Audio- und Transkript-Dateien unwiderruflich. Zum Bestätigen den Projektnamen eintippen.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Input aria-label="Projektname bestätigen" value={confirm} onChange={e => setConfirm(e.target.value)} placeholder={project} />
        <AlertDialogFooter>
          <AlertDialogCancel>Abbrechen</AlertDialogCancel>
          <AlertDialogAction disabled={confirm !== project} onClick={del}>Löschen</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
