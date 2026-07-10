import { useState } from 'react'
import { toast } from 'sonner'
import { createProject } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'

export function NewProjectDialog({ onCreated }: { onCreated: (name: string) => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const submit = async () => {
    const n = name.trim()
    if (!n) return
    try { await createProject(n) } catch (e) { toast.error(`Anlegen fehlgeschlagen: ${(e as Error).message}`); return }
    setOpen(false); setName(''); onCreated(n)
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm">+ Projekt</Button></DialogTrigger>
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
