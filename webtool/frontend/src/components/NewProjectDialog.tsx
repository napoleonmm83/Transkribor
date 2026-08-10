import { useState } from 'react'
import { toast } from 'sonner'
import { createProject } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'

export function NewProjectDialog({ onCreated, trigger, vorbelegung }: {
  onCreated: (name: string) => void
  /** Eigener Ausloeser. Der Leerzustand der Uebersicht braucht einen einladenderen. */
  trigger?: React.ReactNode
  /** Name, mit dem das Feld beim Oeffnen startet (z.B. der Suchbegriff aus der leeren
   *  Trefferliste) -- der Knopf "»x« anlegen" waere sonst ein leeres Versprechen. */
  vorbelegung?: string
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const submit = async () => {
    const n = name.trim()
    if (!n) return
    try { await createProject(n) } catch (e) { toast.error(`Anlegen fehlgeschlagen: ${(e as Error).message}`); return }
    setOpen(false); setName(''); onCreated(n)
  }
  // Feld ist kontrolliert -- ein defaultValue wuerde beim Wiederoeffnen mit anderem
  // Suchbegriff den alten Wert behalten (dieselbe Falle wie beim Modellfeld der
  // Einstellungsseite), darum wird beim Oeffnen aktiv auf die Vorbelegung zurueckgesetzt.
  const setOpenState = (o: boolean) => { setOpen(o); if (o) setName(vorbelegung ?? '') }
  return (
    <Dialog open={open} onOpenChange={setOpenState}>
      <DialogTrigger asChild>{trigger ?? <Button size="sm">+ Neues Projekt</Button>}</DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Neues Projekt</DialogTitle></DialogHeader>
        <label className="text-sm" htmlFor="np-name">Projektname</label>
        <Input id="np-name" aria-label="Projektname" value={name} autoFocus
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit() }} />
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Abbrechen</Button>
          <Button onClick={submit}>Anlegen</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
