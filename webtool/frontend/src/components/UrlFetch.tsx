import { useState } from 'react'
import { Link2 } from 'lucide-react'
import { fetchUrls } from '@/lib/api'
import { Button } from '@/components/ui/button'
import type { StartJob } from '@/lib/types'

export function UrlFetch({ project, onStart }: { project: string; onStart: (res: StartJob) => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const urls = text.split('\n').map(u => u.trim()).filter(Boolean)

  const submit = async () => {
    setBusy(true); setErr('')
    try {
      const res = await fetchUrls(project, urls)
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
