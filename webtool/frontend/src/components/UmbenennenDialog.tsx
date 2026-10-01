import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'

/**
 * Umbenennen — fuer Projekte wie fuer einzelne Aufnahmen dasselbe Bauteil.
 *
 * `vorschlaege` sind die Sprechernamen der Aufnahme: eine Aufnahme heisst nach dem Ueberspielen
 * `01172464`, und wer sie spaeter sucht, sucht nach dem Menschen, der darin spricht. Ein Klick
 * setzt den Namen ins Feld, geschickt wird er trotzdem erst mit „Umbenennen“ — der Vorschlag
 * ist eine Abkuerzung, keine Entscheidung.
 */
type Props = {
  offen: boolean
  onOpenChange: (o: boolean) => void
  titel: string
  beschreibung: string
  wert: string
  vorschlaege?: string[]
  /** `false` heisst: nicht umbenannt, Dialog offen lassen. Die Aufrufer fragen bei
   *  ungespeicherten Aenderungen nach — wer dort abbricht, hat NICHT umbenannt, und ein
   *  Dialog, der sich trotzdem schliesst, behauptet das Gegenteil. */
  onSpeichern: (name: string) => Promise<boolean | void>
}

export function UmbenennenDialog({ offen, onOpenChange, ...props }: Props) {
  return (
    <Dialog open={offen} onOpenChange={onOpenChange}>
      {offen && <UmbenennenInhalt key={props.wert} {...props} onOpenChange={onOpenChange} />}
    </Dialog>
  )
}

function UmbenennenInhalt({ onOpenChange, titel, beschreibung, wert, vorschlaege, onSpeichern }: Omit<Props, 'offen'>) {
  const [name, setName] = useState(wert)
  const [laeuft, setLaeuft] = useState(false)
  // Kontrolliert und beim Oeffnen aktiv zurueckgesetzt: sonst haelt das Feld den Namen der
  // zuletzt umbenannten Datei fest (dieselbe Falle wie beim Modellfeld der Einstellungen).
  const generation = useRef({ active: false })
  useEffect(() => {
    const stand = { active: true }
    generation.current = stand
    return () => { stand.active = false }
  }, [])

  const speichern = async () => {
    const n = name.trim()
    if (!n || n === wert) { onOpenChange(false); return }
    setLaeuft(true)
    const stand = generation.current
    try {
      const umbenannt = await onSpeichern(n)
      if (!stand.active) return
      if (umbenannt === false) { setLaeuft(false); return }
      onOpenChange(false)
    }
    catch (e) { if (stand.active) { toast.error(`Umbenennen fehlgeschlagen: ${(e as Error).message}`); setLaeuft(false) } }
  }

  return (
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{titel}</DialogTitle>
          <DialogDescription>{beschreibung}</DialogDescription>
        </DialogHeader>
        <Input aria-label="Neuer Name" value={name} autoFocus disabled={laeuft}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') speichern() }} />
        {!!vorschlaege?.length && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Sprecher übernehmen:</span>
            {vorschlaege.map(v => (
              <Button key={v} size="sm" variant="outline" className="h-7" disabled={laeuft}
                onClick={() => setName(v)}>{v}</Button>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={laeuft}>Abbrechen</Button>
          <Button onClick={speichern} disabled={laeuft || !name.trim()}>Umbenennen</Button>
        </DialogFooter>
      </DialogContent>
  )
}
