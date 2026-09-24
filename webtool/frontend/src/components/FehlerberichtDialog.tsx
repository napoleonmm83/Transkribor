import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { BerichtVorschau } from '@/hooks/useUpdate'

type Props = {
  offen: boolean
  schliessen: () => void
  vorschau: () => Promise<BerichtVorschau | undefined> | undefined
  senden: (id: string, indices: number[], kommentar: string) => Promise<{ id: string } | undefined> | undefined
}

export function FehlerberichtDialog({ offen, schliessen, vorschau, senden }: Props) {
  const [bericht, setBericht] = useState<BerichtVorschau | null>(null)
  const [auswahl, setAuswahl] = useState<number[]>([])
  const [kommentar, setKommentar] = useState('')
  const [laedt, setLaedt] = useState(false)
  const [sendet, setSendet] = useState(false)
  const [fehler, setFehler] = useState('')
  const [gesendet, setGesendet] = useState(false)
  // Abbrechen ist waehrend des Sendens erlaubt (der Transport hat selbst keine Frist); die spaete
  // Antwort eines abgebrochenen Versands darf dann nicht im neu geoeffneten Dialog landen.
  const lauf = useRef(0)

  useEffect(() => {
    if (!offen) return
    let aktiv = true
    lauf.current++
    setBericht(null); setFehler(''); setGesendet(false); setKommentar(''); setSendet(false); setLaedt(true)
    Promise.resolve(vorschau()).then(b => {
      if (!aktiv) return
      if (!b) throw new Error('Die Vorschau ist nicht verfuegbar.')
      setBericht(b)
      setAuswahl(b.zeilen.map((_, i) => i))
    }).catch((e: Error) => { if (aktiv) setFehler(e.message) })
      .finally(() => { if (aktiv) setLaedt(false) })
    return () => { aktiv = false }
  }, [offen, vorschau])

  async function abschicken() {
    if (!bericht || sendet) return
    const meiner = lauf.current
    setSendet(true); setFehler('')
    try {
      const antwort = await senden(bericht.id, auswahl, kommentar)
      if (meiner !== lauf.current) return
      if (!antwort || antwort.id !== bericht.id) throw new Error('Bugsink hat den Bericht nicht bestätigt.')
      setGesendet(true)
    } catch (e) {
      if (meiner === lauf.current) setFehler(e instanceof Error ? e.message : 'Bugsink konnte den Bericht nicht annehmen.')
    } finally { if (meiner === lauf.current) setSendet(false) }
  }

  return (
    <Dialog open={offen} onOpenChange={an => { if (!an) schliessen() }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Fehlerbericht an Bugsink</DialogTitle>
          <DialogDescription>Prüfe die Angaben. Unbekannte Pfade oder Schlüssel können noch sichtbar sein. Wähle solche Zeilen ab.</DialogDescription>
        </DialogHeader>
        {laedt && <p className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin" /> Vorschau wird geladen …</p>}
        {bericht && !gesendet && <>
          <div className="rounded-md border bg-muted/30 p-3 font-mono text-xs" aria-label="Systemangaben">
            {bericht.kopf.map((z, i) => <div key={i}>{z}</div>)}
          </div>
          <div>
            <p className="mb-2 text-sm font-medium">Protokollzeilen ({auswahl.length} von {bericht.zeilen.length})</p>
            <div className="relative max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
              {bericht.zeilen.length === 0 && <p className="text-sm text-muted-foreground">Keine passenden Protokollzeilen vorhanden.</p>}
              {bericht.zeilen.map((z, i) => <label key={i} className="flex items-start gap-2 rounded px-1 py-1 text-xs hover:bg-muted">
                <input type="checkbox" aria-label={`Zeile ${i + 1} mitsenden`} checked={auswahl.includes(i)}
                  onChange={e => setAuswahl(alt => e.target.checked ? [...alt, i].sort((a, b) => a - b) : alt.filter(n => n !== i))} />
                <span className="min-w-0 break-all font-mono">{z}</span>
              </label>)}
            </div>
          </div>
          <label className="text-sm font-medium" htmlFor="bericht-kommentar">Was ist passiert?</label>
          <Textarea id="bericht-kommentar" maxLength={2000} value={kommentar} onChange={e => setKommentar(e.target.value)}
            placeholder="Beschreibe kurz den Fehler (optional)" />
        </>}
        {gesendet && <p role="status" className="text-sm">Der Bericht wurde von Bugsink angenommen. Danke!</p>}
        {fehler && <p role="alert" className="text-sm text-destructive">{fehler}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={schliessen}>{gesendet ? 'Schließen' : 'Abbrechen'}</Button>
          {bericht && !gesendet && <Button onClick={abschicken} disabled={sendet}>
            {sendet && <Loader2 className="size-4 animate-spin" />} An Bugsink senden
          </Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
