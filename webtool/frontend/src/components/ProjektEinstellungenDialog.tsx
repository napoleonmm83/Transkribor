import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { getProjektEinstellungen, saveProjektEinstellungen } from '@/lib/api'
import type { ProjectEinstellungen } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'

/** Per-Projekt-Einstellungen (Sprache + Korrektur-Tiefe). Kontrolliert aus dem ⋯-Menü
 *  (`offen`/`onOpenChange`), sonst eigener State — dieselbe Konvention wie
 *  `DeleteProjectDialog`. Ein Dialog-Trigger IM Menü wird beim Schliessen mit ausgehängt. */
export function ProjektEinstellungenDialog({ project, offen, onOpenChange, onGeaendert }: {
  project: string
  offen?: boolean
  onOpenChange?: (o: boolean) => void
  onGeaendert?: () => void
}) {
  const gesteuert = offen !== undefined
  const [eigen, setEigen] = useState(false)
  const open = gesteuert ? offen : eigen
  const setOpen = (o: boolean) => { if (gesteuert) onOpenChange?.(o); else setEigen(o) }

  const [data, setData] = useState<ProjectEinstellungen | null>(null)
  const [sprache, setSprache] = useState('')
  const [korrektur, setKorrektur] = useState('')
  const [laedt, setLaedt] = useState(false)
  const [speichert, setSpeichert] = useState(false)

  // Beim Öffnen laden (offen true→). Abhängig von `open`, nicht von `project`:
  // ein eigener Trigger lädt erst beim Aufklappen, nicht beim Mount.
  useEffect(() => {
    if (!open) return
    let aktiv = true
    setLaedt(true)
    getProjektEinstellungen(project)
      .then(d => {
        if (!aktiv) return
        setData(d)
        setSprache(d.sprache)
        setKorrektur(d.korrektur)
      })
      .catch(e => { if (aktiv) toast.error(`Einstellungen laden fehlgeschlagen: ${(e as Error).message}`) })
      .finally(() => { if (aktiv) setLaedt(false) })
    return () => { aktiv = false }
  }, [open, project])

  const speichern = async () => {
    setSpeichert(true)
    try {
      await saveProjektEinstellungen(project, { sprache, korrektur })
      onGeaendert?.()
      setOpen(false)
    } catch (e) {
      toast.error(`Speichern fehlgeschlagen: ${(e as Error).message}`)
    } finally {
      setSpeichert(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Projekt-Einstellungen</DialogTitle>
        </DialogHeader>
        {laedt ? (
          <p className="text-sm text-muted-foreground">Laden …</p>
        ) : data && (
          <div className="grid gap-4">
            <div>
              {/* shadcn-Select ist ein <button> — aria-labelledby bindet das Label, wie in SettingsPage. */}
              <label id="lbl-sprache" className="mb-1.5 block text-sm font-medium">Sprache</label>
              <Select value={sprache} onValueChange={setSprache}>
                <SelectTrigger className="w-full" aria-labelledby="lbl-sprache"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {data.sprach_choices.map(c => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.label}{c.hint && ` — ${c.hint}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label id="lbl-tiefe" className="mb-1.5 block text-sm font-medium">Korrektur-Tiefe</label>
              <Select value={korrektur} onValueChange={setKorrektur}>
                <SelectTrigger className="w-full" aria-labelledby="lbl-tiefe"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {data.tiefen.map(t => (
                    <SelectItem key={t.id} value={t.id}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={speichert}>Abbrechen</Button>
          <Button onClick={speichern} disabled={!data || speichert}>Speichern</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
