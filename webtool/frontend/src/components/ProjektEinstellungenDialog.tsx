import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { getProjektEinstellungen, saveProjektEinstellungen } from '@/lib/api'
import { autoHinweis } from '@/lib/autoHinweis'
import type { ProjectEinstellungen } from '@/lib/types'
import { MehrsprachigKasten } from '@/components/MehrsprachigKasten'
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
  const [mehrsprachig, setMehrsprachig] = useState(false)
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
        setMehrsprachig(d.mehrsprachig)
      })
      .catch(e => { if (aktiv) toast.error(`Einstellungen laden fehlgeschlagen: ${(e as Error).message}`) })
      .finally(() => { if (aktiv) setLaedt(false) })
    return () => { aktiv = false }
  }, [open, project])

  const speichern = async () => {
    setSpeichert(true)
    try {
      await saveProjektEinstellungen(project, { sprache, korrektur, mehrsprachig })
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
              {/* `null` als Bezug: hier SETZT man den Projekt-Standard gerade, einen
                  darueber gibt es nicht. `correct._ziel_dialekt` reichte in diesem Fall
                  `auto` als `bevorzugt` weiter — und das trifft nie, weil `auto` keinen
                  Whisper-Code hat. Also reine Detektion, und genau das sagt der Satz.
                  Denselben Text wie im Datei-Dialog zu zeigen waere hier schlicht falsch.

                  **Das `null` ist heute allerdings NICHT unterscheidbar von `sprache`, und
                  das gehoert hierhin statt in eine Behauptung.** Mutationsprobe: `null` →
                  `sprache` liess alle Tests gruen. Der Grund ist strukturell — in diesem
                  Dialog ist die gewaehlte Sprache ZUGLEICH der Standard, der Satz erscheint
                  nur bei `auto`, und `autoHinweis` kehrt fuer `projektStandard === 'auto'`
                  ohnehin frueh zurueck. Beide Argumente laufen also in denselben Zweig.
                  `null` bleibt trotzdem stehen: es ist die semantisch wahre Angabe („es gibt
                  keinen uebergeordneten Standard"), und sollte der Satz je auch bei fester
                  Sprache erscheinen, waere `sprache` dort sofort falsch. Ein Test dafuer ist
                  heute nicht baubar — das ist eine benannte Luecke, keine gepruefte Zeile. */}
              {autoHinweis(sprache, null, data.sprach_choices) && (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {autoHinweis(sprache, null, data.sprach_choices)}
                </p>
              )}
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
            <MehrsprachigKasten wert={mehrsprachig} setzen={setMehrsprachig} id="mehr-projekt" />
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
