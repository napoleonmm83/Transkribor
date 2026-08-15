import { useState } from 'react'
import { Link2 } from 'lucide-react'
import { fetchUrls } from '@/lib/api'
import { Button } from '@/components/ui/button'
import type { StartJob } from '@/lib/types'

export function UrlFetch({ project, onStart, sprache = '', mehrsprachig }: {
  project: string
  onStart: (res: StartJob) => void
  // Die Sprachauswahl steht EINMAL im Bereich „Material hinzufügen" (ProjectWorkspace) und
  // gilt fuer Upload UND URL-Import — hier kommen nur noch die Werte an, die der Import
  // mitschickt. sprache='' wirkt wie „nicht gesetzt": fetchUrls ignoriert einen leeren
  // String (sprache ? { sprache } : {}).
  sprache?: string
  /** undefined = kein Datei-Override (der Projektwert gilt); den Fall entscheidet der Aufrufer. */
  mehrsprachig?: boolean
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const urls = text.split('\n').map(u => u.trim()).filter(Boolean)

  const submit = async () => {
    setBusy(true); setErr('')
    try {
      const res = await fetchUrls(project, urls, sprache, mehrsprachig)
      if (res.started) setText('')   // nicht gestartet -> Eingabe stehen lassen
      onStart(res)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

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
