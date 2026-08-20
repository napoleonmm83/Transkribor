import { useEffect, useState } from 'react'
import { Link2 } from 'lucide-react'
import { fetchUrls } from '@/lib/api'
import { sprecherWahl } from '@/lib/sprecher'
import { Button } from '@/components/ui/button'
import { MaterialVorschau, type VorschauZeile } from '@/components/MaterialVorschau'
import type { StartJob } from '@/lib/types'

export function UrlFetch({ project, onStart, sprache = '', mehrsprachig,
                           sprecherMax = 20 }: {
  project: string
  onStart: (res: StartJob) => void
  /** Obergrenze aus `sprecher_max` (Server); der Rueckfall deckt einen aelteren Server. */
  sprecherMax?: number
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
  const [auswahl, setAuswahl] = useState<VorschauZeile[]>([])
  // Das Zerlegen bleibt HIER (es gehoert zur Eingabe): damit sind Anzeige und gesendete Liste
  // von Anfang an deckungsgleich, und die paarweise Filterung im Server ist der ZWEITE
  // Riegel, nicht der einzige — er sieht auch Anfragen, die nicht aus diesem Frontend kommen.
  const urls = text.split('\n').map(u => u.trim()).filter(Boolean)

  // Dieselbe Vorgabe wie in `UploadDropzone`: die Auswahl gehoert dem Projekt, in dem sie
  // getroffen wurde — React Router baut die Seite beim Wechsel NICHT neu auf.
  useEffect(() => { setAuswahl([]); setErr('') }, [project])

  /** „Holen" oeffnet die Vorschau — ERGAENZT, wie beim Upload (dieselbe Semantik; zwei
   *  verschiedene muesste man sich merken). Dubletten werden an der URL uebersprungen. */
  const waehlen = () => {
    if (!urls.length) return
    setAuswahl(alt => {
      // `bekannt` waechst WAEHREND des Filterns mit — dieselbe Falle wie beim Upload: zweimal
      // dieselbe URL im Textfeld ergaebe sonst zwei Zeilen mit demselben Schluessel, die sich
      // nicht mehr einzeln bearbeiten liessen (und einen doppelten Download).
      const bekannt = new Set(alt.map(z => z.schluessel))
      const neu: VorschauZeile[] = []
      for (const u of urls) {
        if (bekannt.has(u)) continue
        bekannt.add(u)
        neu.push({ schluessel: u, anzeige: u, sprecherText: '' })
      }
      return [...alt, ...neu]
    })
  }

  const submit = async (zeilen: VorschauZeile[]) => {
    setBusy(true); setErr('')
    try {
      // `?? null` — hier ANDERS als beim Upload: die Liste ist index-parallel zu den URLs,
      // ein leeres Feld muss also seinen PLATZ behalten. Mit `undefined` fiele der Eintrag in
      // JSON.stringify weg und jede folgende Zahl rutschte eine Aufnahme nach vorn.
      const liste = zeilen.map(z => sprecherWahl(z.sprecherText, sprecherMax) ?? null)
      const res = await fetchUrls(project, zeilen.map(z => z.schluessel), sprache, mehrsprachig,
                                  liste.some(s => s !== null) ? liste : undefined)
      if (res.started) { setText(''); setAuswahl([]) }   // nicht gestartet -> stehen lassen
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
        <Button variant="outline" size="sm" disabled={!urls.length || busy} onClick={waehlen}>
          <Link2 className="size-4" /> {busy ? 'startet…' : 'Holen'}
        </Button>
        {urls.length > 1 && (
          <span className="text-xs text-muted-foreground">{urls.length} URLs</span>
        )}
        {err && <span className="text-xs text-destructive">{err}</span>}
      </div>
      {auswahl.length > 0 && (
        <div className="mt-3">
          <MaterialVorschau
            titel={`${auswahl.length} ${auswahl.length === 1 ? 'Link' : 'Links'} bereit`}
            zeilen={auswahl} sprecherMax={sprecherMax} laeuft={busy}
            startText="Holen & starten"
            onAendern={(k, t) => setAuswahl(alt => alt.map(z =>
              z.schluessel === k ? { ...z, sprecherText: t } : z))}
            onStart={() => submit(auswahl)}
            onAbbrechen={() => setAuswahl([])} />
        </div>
      )}
    </div>
  )
}
