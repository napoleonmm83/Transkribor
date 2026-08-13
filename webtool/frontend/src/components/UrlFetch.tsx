import { useState } from 'react'
import { Link2 } from 'lucide-react'
import { fetchUrls } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { MehrsprachigKasten } from '@/components/MehrsprachigKasten'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { StartJob, SprachChoice } from '@/lib/types'

export function UrlFetch({ project, onStart, sprache = '', sprachChoices = [], onSpracheChange = () => {},
  mehrsprachig = false, onMehrsprachigChange = () => {} }: {
  project: string
  onStart: (res: StartJob) => void
  // Optional bis Task 5 (ProjectWorkspace) die Werte durchreicht. sprache='' wirkt wie
  // „nicht gesetzt": fetchUrls ignoriert einen leeren String (sprache ? { sprache } : {}).
  sprache?: string
  /** Wie `sprache` aus den Projekt-Einstellungen vorbelegt und hier pro Upload aenderbar. */
  mehrsprachig?: boolean
  onMehrsprachigChange?: (w: boolean) => void
  sprachChoices?: SprachChoice[]
  onSpracheChange?: (id: string) => void
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const urls = text.split('\n').map(u => u.trim()).filter(Boolean)

  const submit = async () => {
    setBusy(true); setErr('')
    try {
      const res = await fetchUrls(project, urls, sprache, mehrWert)
      if (res.started) setText('')   // nicht gestartet -> Eingabe stehen lassen
      onStart(res)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // `sprache` wird von den API-Funktionen bei leerem String weggelassen; der Haken muss
  // GENAUSO degradieren. Sonst schickt ein Bereich, dessen Einstellungen gar nicht geladen
  // sind (Fehler beim GET -> keine Auswahl gerendert), ein hartes `false` mit und schlaegt
  // damit einen auf true stehenden Projekt-Standard — der Nutzer sieht kein Kaestchen und
  // bekommt trotzdem einen Datei-Override. undefined = kein Override.
  const mehrWert = sprachChoices.length > 0 ? mehrsprachig : undefined

  return (
    <div className="blatt p-4">
      {/* Beschriftung wie in den Einstellungen: text-sm font-medium in der Vordergrundfarbe.
          Vorher stand sie in muted-foreground und las sich als Hilfstext, nicht als Label. */}
      <label htmlFor="url-fetch" className="mb-1.5 block text-sm font-medium">
        Video-URLs
      </label>
      <textarea
        id="url-fetch" aria-label="Video-URLs" rows={2} value={text} disabled={busy}
        onChange={e => setText(e.target.value)}
        placeholder="YouTube- oder Instagram-Reel-Links, eine URL pro Zeile"
        className="w-full resize-y rounded-md border bg-background p-2 text-sm
                   outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      {/* Sprachwaehler zwischen Textarea und Buttonreihe; Stil wie SettingsPage-Modellauswahl.
          shadcn-Select ist ein <button> → aria-labelledby statt htmlFor.
          Erst gerendert, wenn sprachChoices da sind — Task 5 reicht sie aus ProjectWorkspace durch. */}
      {sprachChoices.length > 0 && (
        <div className="mt-2">
          <label id="lbl-url-sprache" className="mb-1.5 block text-sm font-medium">Sprache</label>
          <Select value={sprache} onValueChange={onSpracheChange}>
            <SelectTrigger className="w-full" aria-labelledby="lbl-url-sprache"><SelectValue /></SelectTrigger>
            <SelectContent>
              {sprachChoices.map(c => (
                <SelectItem key={c.id} value={c.id}>{c.label}{c.hint && ` — ${c.hint}`}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* Direkt unter der Sprache, weil er sie zur HAUPTsprache macht — und VOR dem Upload,
              denn der Job startet sofort; nachtraeglich kostet es einen kompletten zweiten Lauf. */}
          <div className="mt-2">
            <MehrsprachigKasten wert={mehrsprachig} setzen={onMehrsprachigChange} id="mehr-url" />
          </div>
        </div>
      )}
      <div className="mt-2 flex items-center gap-3">
        <Button variant="outline" size="sm" disabled={!urls.length || busy} onClick={submit}>
          <Link2 className="size-4" /> {busy ? 'startet…' : 'Holen'}
        </Button>
        {urls.length > 1 && (
          <span className="text-xs text-muted-foreground">{urls.length} URLs</span>
        )}
        {err && <span className="text-xs text-destructive">{err}</span>}
      </div>
    </div>
  )
}
