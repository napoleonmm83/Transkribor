import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { getFileEinstellungen, saveFileEinstellungen } from '@/lib/api'
import type { ProjectEinstellungen, ProjectFile } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'

/** Sprache + Korrektur-Tiefe EINER bereits liegenden Datei. Spiegelt
 *  `ProjektEinstellungenDialog`, ergänzt den kontext-abhängigen Hinweis und den dynamischen
 *  Knopf-Text. Der Dialog schreibt NUR den Override (`saveFileEinstellungen`); welche
 *  Neuberechnung nötig ist, entscheidet der Aufrufer via `onGespeichert` — denn die Job-Hooks
 *  (Adoption, Editor-Reload) hängen in `DateiMenue`.
 *
 *  Verzweigung (Spec #135): Sprache-Änderung + has_raw -> Neu-Transkription (dominiert, zieht
 *  die Korrektur nach); nur Tiefe + has_raw -> Neu-Korrektur; !has_raw -> nur Override. */
export function DateiEinstellungenDialog({ project, base, file, offen, onOpenChange, onGespeichert }: {
  project: string
  base: string
  file: ProjectFile
  offen?: boolean
  onOpenChange?: (o: boolean) => void
  onGespeichert?: (a: { spracheGeaendert: boolean; tiefeGeaendert: boolean }) => void
}) {
  const [data, setData] = useState<ProjectEinstellungen | null>(null)
  const [sprache, setSprache] = useState('')
  const [korrektur, setKorrektur] = useState('')
  const [laedt, setLaedt] = useState(false)
  const [speichert, setSpeichert] = useState(false)

  useEffect(() => {
    if (!offen) return
    let aktiv = true
    setLaedt(true)
    getFileEinstellungen(project, base)
      .then(d => { if (aktiv) { setData(d); setSprache(d.sprache); setKorrektur(d.korrektur) } })
      .catch(e => { if (aktiv) toast.error(`Einstellungen laden fehlgeschlagen: ${(e as Error).message}`) })
      .finally(() => { if (aktiv) setLaedt(false) })
    return () => { aktiv = false }
  }, [offen, project, base])

  const spracheGeaendert = !!data && sprache !== data.sprache
  const tiefeGeaendert = !!data && korrektur !== data.korrektur
  const geaendert = spracheGeaendert || tiefeGeaendert
  // Sprache-Wechsel dominiert (Neu-Transkription deckt die Tiefe über die Autokorrektur-Kette ab).
  const trigger = file.has_raw && geaendert
    ? (spracheGeaendert ? 'transcribe' : 'correct')
    : 'none'

  const knopf =
    trigger === 'transcribe' ? 'Speichern & neu transkribieren'
    : trigger === 'correct' ? 'Speichern & neu korrigieren'
    : 'Speichern'

  const hinweis =
    !file.has_raw ? 'Wird bei der nächsten Transkription verwendet.'
    : trigger === 'transcribe'
      ? `Neue Sprache erfordert Neu-Transkription: Transkript, Korrektur und Export werden verworfen (Audio bleibt)${file.has_edit ? ', inkl. der handbearbeiteten Fassung' : ''}.`
    : trigger === 'correct'
      ? (file.has_edit ? 'Die handbearbeitete Fassung wird überschrieben.'
                       : 'Die Korrektur wird mit der neuen Tiefe neu erstellt.')
    : ''

  const speichernFn = async () => {
    if (!geaendert) return
    setSpeichert(true)
    try {
      await saveFileEinstellungen(project, base, { sprache, korrektur })
      onGespeichert?.({ spracheGeaendert, tiefeGeaendert })
      onOpenChange?.(false)
    } catch (e) {
      toast.error(`Speichern fehlgeschlagen: ${(e as Error).message}`)
    } finally {
      setSpeichert(false)
    }
  }

  return (
    <Dialog open={offen} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sprache &amp; Korrektur-Tiefe — „{base}“</DialogTitle>
        </DialogHeader>
        {laedt ? (
          <p className="text-sm text-muted-foreground">Laden …</p>
        ) : data && (
          <div className="grid gap-4">
            <div>
              <label id="lbl-fs-sprache" className="mb-1.5 block text-sm font-medium">Sprache</label>
              <Select value={sprache} onValueChange={setSprache}>
                <SelectTrigger className="w-full" aria-labelledby="lbl-fs-sprache"><SelectValue /></SelectTrigger>
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
              <label id="lbl-fs-tiefe" className="mb-1.5 block text-sm font-medium">Korrektur-Tiefe</label>
              <Select value={korrektur} onValueChange={setKorrektur}>
                <SelectTrigger className="w-full" aria-labelledby="lbl-fs-tiefe"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {data.tiefen.map(t => (
                    <SelectItem key={t.id} value={t.id}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {hinweis && <p className="text-sm text-muted-foreground">{hinweis}</p>}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange?.(false)} disabled={speichert}>Abbrechen</Button>
          <Button onClick={speichernFn} disabled={!data || speichert || !geaendert}>{knopf}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
