import { useEffect, useState } from 'react'
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
 * setzt den Namen ins Feld, geschickt wird er trotzdem erst mit „Umbenennen" — der Vorschlag
 * ist eine Abkuerzung, keine Entscheidung.
 */
export function UmbenennenDialog({ offen, onOpenChange, titel, beschreibung, wert, vorschlaege, onSpeichern }: {
  offen: boolean
  onOpenChange: (o: boolean) => void
  titel: string
  beschreibung: string
  wert: string
  vorschlaege?: string[]
  onSpeichern: (name: string) => Promise<void>
}) {
  const [name, setName] = useState(wert)
  const [laeuft, setLaeuft] = useState(false)
  // Kontrolliert und beim Oeffnen aktiv zurueckgesetzt: sonst haelt das Feld den Namen der
  // zuletzt umbenannten Datei fest (dieselbe Falle wie beim Modellfeld der Einstellungen).
  useEffect(() => { if (offen) { setName(wert); setLaeuft(false) } }, [offen, wert])

  const speichern = async () => {
    const n = name.trim()
    if (!n || n === wert) { onOpenChange(false); return }
    setLaeuft(true)
    try { await onSpeichern(n); onOpenChange(false) }
    catch (e) { toast.error(`Umbenennen fehlgeschlagen: ${(e as Error).message}`); setLaeuft(false) }
  }

  return (
    <Dialog open={offen} onOpenChange={onOpenChange}>
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
    </Dialog>
  )
}

/** Die Sprechernamen eines Dokuments in der Reihenfolge ihres ersten Auftretens.
 *  Ohne Filter: welcher Name als Dateiname taugt, weiss nur der Mensch davor — eine
 *  Heuristik („nimm den, der nicht Interviewer heisst") liegt beim ersten Sonderfall falsch. */
export function sprecherNamen(doc: { segments?: { speaker?: string }[] } | null): string[] {
  const gesehen: string[] = []
  for (const s of doc?.segments ?? []) {
    const n = (s.speaker || '').trim()
    if (n && !gesehen.includes(n)) gesehen.push(n)
  }
  return gesehen
}
