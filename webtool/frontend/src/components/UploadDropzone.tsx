import { useRef, useState } from 'react'
import { Check, Loader2, TriangleAlert, Upload } from 'lucide-react'
import { uploadAudio } from '@/lib/api'
import { cn } from '@/lib/utils'
import { MehrsprachigKasten } from '@/components/MehrsprachigKasten'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { StartJob, SprachChoice } from '@/lib/types'

const AUDIO_RE = /\.(mp3|wav|m4a|aac|flac|ogg|opus|wma|mp4)$/i
type Status = 'uploading' | 'done' | 'exists' | 'error'
type Item = { name: string; status: Status; msg?: string }

export function UploadDropzone({ project, onDone, sprache = '', sprachChoices = [], onSpracheChange = () => {},
  mehrsprachig = false, onMehrsprachigChange = () => {} }: {
  project: string
  onDone?: (job?: StartJob) => void
  // Optional bis Task 5 (ProjectWorkspace) die Werte durchreicht. sprache='' wirkt wie
  // „nicht gesetzt": die API-Funktionen ignorieren einen leeren String (if sprache).
  sprache?: string
  /** Wie `sprache` aus den Projekt-Einstellungen vorbelegt und hier pro Upload aenderbar. */
  mehrsprachig?: boolean
  onMehrsprachigChange?: (w: boolean) => void
  sprachChoices?: SprachChoice[]
  onSpracheChange?: (id: string) => void
}) {
  const [items, setItems] = useState<Item[]>([])
  const [over, setOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const patch = (name: string, p: Partial<Item>) =>
    setItems(prev => prev.map(it => it.name === name ? { ...it, ...p } : it))

  const upload = async (files: File[]) => {
    const audio = files.filter(f => AUDIO_RE.test(f.name))
    if (!audio.length) return
    setItems(audio.map(f => ({ name: f.name, status: 'uploading' as Status })))
    // Jeder Upload stoesst serverseitig die Transkription an; der Job ist fuer alle derselbe
    // (Dedupe je Projekt+Art), also reicht die zuletzt gemeldete Job-ID zum Adoptieren.
    let job: StartJob | undefined
    // ponytail: sequentiell statt Pool — lokale Uploads sind quasi instant; Pool nachruesten bei Bedarf
    for (const f of audio) {
      try {
        const r = await uploadAudio(project, f, sprache, mehrsprachig)
        if (r.job_id) job = { job_id: r.job_id, started: !!r.started }
        patch(f.name, { status: 'done' })
      }
      catch (e) {
        const msg = (e as Error).message
        patch(f.name, { status: /existiert bereits/.test(msg) ? 'exists' : 'error', msg })
      }
    }
    onDone?.(job)
  }

  return (
    <div>
      <div
        role="button" tabIndex={0} aria-label="Audio hochladen"
        onClick={() => inputRef.current?.click()}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click() } }}
        onDragOver={e => { e.preventDefault(); setOver(true) }}
        onDragLeave={() => setOver(false)}
        onDrop={e => { e.preventDefault(); setOver(false); upload(Array.from(e.dataTransfer.files)) }}
        // blatt = dieselbe Flaeche wie die Dateiliste darunter; nur die Kante ist gestrichelt,
        // weil das die Konvention fuer "hier ablegen" ist. Vorher: eigener 4px-Radius und
        // kein Kartenuntergrund — zwei Kaesten uebereinander, die sichtbar nicht zusammengehoerten.
        // Fokusring explizit: die Flaeche ist ein div mit tabIndex, bekaeme also nur den
        // Standardring des Browsers. Jedes andere Bedienelement hier traegt denselben
        // ring-2 — ohne ihn faellt ausgerechnet die groesste Klickflaeche aus der Reihe.
        className={cn('blatt blatt-klickbar flex cursor-pointer items-center justify-center gap-2 border-dashed p-6 text-sm text-muted-foreground',
          'outline-none focus-visible:ring-2 focus-visible:ring-ring',
          over && 'border-primary bg-accent text-accent-foreground')}
      >
        <div className="text-center">
          <div className="flex items-center justify-center gap-2"><Upload className="size-4" /> Audio hierher ziehen oder klicken</div>
          <div className="mt-1 text-xs">Transkription und Korrektur starten automatisch.</div>
        </div>
      </div>
      <input ref={inputRef} data-testid="upload-input" type="file" hidden multiple
        accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.wma,.mp4"
        onChange={e => { upload(Array.from(e.target.files ?? [])); e.target.value = '' }} />
      {/* Sprachwaehler wie in den Einstellungen: shadcn-Select ist ein <button>, kein <select>,
          darum aria-labelledby statt htmlFor. Gleicher Stil wie SettingsPage-Modellauswahl.
          Erst gerendert, wenn sprachChoices da sind — Task 5 reicht sie aus ProjectWorkspace durch. */}
      {sprachChoices.length > 0 && (
        <div className="mt-2">
          <label id="lbl-upload-sprache" className="mb-1.5 block text-sm font-medium">Sprache</label>
          <Select value={sprache} onValueChange={onSpracheChange}>
            <SelectTrigger className="w-full" aria-labelledby="lbl-upload-sprache"><SelectValue /></SelectTrigger>
            <SelectContent>
              {sprachChoices.map(c => (
                <SelectItem key={c.id} value={c.id}>{c.label}{c.hint && ` — ${c.hint}`}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* Direkt unter der Sprache, weil er sie zur HAUPTsprache macht — und VOR dem Upload,
              denn der Job startet sofort; nachtraeglich kostet es einen kompletten zweiten Lauf. */}
          <div className="mt-2">
            <MehrsprachigKasten wert={mehrsprachig} setzen={onMehrsprachigChange} />
          </div>
        </div>
      )}
      {items.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs">
          {items.map(it => (
            <li key={it.name} className="flex items-center justify-between gap-2">
              <span className="min-w-0 flex-1 truncate">{it.name}</span>
              {/* Letztes Glyph-als-Symbol im Projekt: '✓' erbte die Textfarbe nicht und hiess
                  fuer einen Screenreader nichts. Gleiche Bildsprache wie FileStatusPill. */}
              <span className={cn('inline-flex shrink-0 items-center gap-1.5',
                it.status === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
                {it.status === 'uploading' && <><Loader2 className="size-3 animate-spin" aria-hidden="true" /> lädt…</>}
                {it.status === 'done' && <><Check className="size-3" aria-hidden="true" /> geladen</>}
                {it.status === 'exists' && 'existiert bereits'}
                {/* || statt ??: ein Error mit leerer message ist nicht null, liesse den Text
                    aber verschwinden — dann staende nur das Warndreieck ohne Grund da. */}
                {it.status === 'error' && <><TriangleAlert className="size-3" aria-hidden="true" /> {it.msg || 'Fehler'}</>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
