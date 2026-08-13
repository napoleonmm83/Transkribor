import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { getFileEinstellungen, saveFileEinstellungen } from '@/lib/api'
import type { ProjectEinstellungen, ProjectFile } from '@/lib/types'
import { MehrsprachigKasten } from '@/components/MehrsprachigKasten'
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
  /** `neuTranskribieren` heisst nicht mehr „Sprache geändert“: auch der Mehrsprachig-Haken
   *  landet hier, weil er dieselbe Folge hat (der Decoder läuft anders, das alte Transkript
   *  ist hin). Ein Feld, das nur die halbe Ursache benennt, führt den nächsten Leser in die Irre. */
  onGespeichert?: (a: { neuTranskribieren: boolean; tiefeGeaendert: boolean }) => void
}) {
  const [data, setData] = useState<ProjectEinstellungen | null>(null)
  const [sprache, setSprache] = useState('')
  const [korrektur, setKorrektur] = useState('')
  const [mehrsprachig, setMehrsprachig] = useState(false)
  const [laedt, setLaedt] = useState(false)
  const [speichert, setSpeichert] = useState(false)

  useEffect(() => {
    if (!offen) return
    let aktiv = true
    setLaedt(true)
    getFileEinstellungen(project, base)
      .then(d => {
        if (!aktiv) return
        setData(d); setSprache(d.sprache); setKorrektur(d.korrektur); setMehrsprachig(d.mehrsprachig)
      })
      .catch(e => { if (aktiv) toast.error(`Einstellungen laden fehlgeschlagen: ${(e as Error).message}`) })
      .finally(() => { if (aktiv) setLaedt(false) })
    return () => { aktiv = false }
  }, [offen, project, base])

  const tiefeGeaendert = !!data && korrektur !== data.korrektur
  // Der Haken zaehlt wie ein Sprachwechsel: er schaltet multilingual + condition_on_previous_text
  // um, ein vorhandenes Transkript ist danach nach anderen Regeln entstanden.
  const neuTranskribieren = !!data && (sprache !== data.sprache || mehrsprachig !== data.mehrsprachig)
  const geaendert = neuTranskribieren || tiefeGeaendert
  // Neu-Transkription dominiert (sie deckt die Tiefe über die Autokorrektur-Kette ab).
  const trigger = file.has_raw && geaendert
    ? (neuTranskribieren ? 'transcribe' : 'correct')
    : 'none'

  const knopf =
    trigger === 'transcribe' ? 'Speichern & neu transkribieren'
    : trigger === 'correct' ? 'Speichern & neu korrigieren'
    : 'Speichern'

  const hinweis =
    !file.has_raw ? 'Wird bei der nächsten Transkription verwendet.'
    : trigger === 'transcribe'
      // „Die Änderung“, nicht „Neue Sprache“: der Mehrsprachig-Haken loest denselben Zweig aus.
      ? `Die Änderung erfordert eine Neu-Transkription: Transkript, Korrektur und Export werden verworfen (Audio bleibt)${file.has_edit ? ', inkl. der handbearbeiteten Fassung' : ''}.`
    : trigger === 'correct'
      ? (file.has_edit ? 'Die handbearbeitete Fassung wird überschrieben.'
                       : 'Die Korrektur wird mit der neuen Tiefe neu erstellt.')
    : ''

  const speichernFn = async () => {
    if (!geaendert) return
    setSpeichert(true)
    try {
      await saveFileEinstellungen(project, base, { sprache, korrektur, mehrsprachig })
      onGespeichert?.({ neuTranskribieren, tiefeGeaendert })
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
            <MehrsprachigKasten wert={mehrsprachig} setzen={setMehrsprachig} id="mehr-datei" />
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
