import { useRef, useState } from 'react'
import { Check, Loader2, TriangleAlert, Upload } from 'lucide-react'
import { uploadAudio } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { StartJob } from '@/lib/types'

const AUDIO_RE = /\.(mp3|wav|m4a|aac|flac|ogg|opus|wma|mp4)$/i
type Status = 'uploading' | 'done' | 'exists' | 'error'
type Item = { name: string; status: Status; msg?: string }

export function UploadDropzone({ project, onDone }: { project: string; onDone?: (job?: StartJob) => void }) {
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
        const r = await uploadAudio(project, f)
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
        className={cn('blatt blatt-klickbar flex cursor-pointer items-center justify-center gap-2 border-dashed p-6 text-sm text-muted-foreground',
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
      {items.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs">
          {items.map(it => (
            <li key={it.name} className="flex items-center justify-between gap-2">
              <span className="truncate">{it.name}</span>
              {/* Letztes Glyph-als-Symbol im Projekt: '✓' erbte die Textfarbe nicht und hiess
                  fuer einen Screenreader nichts. Gleiche Bildsprache wie FileStatusPill. */}
              <span className={cn('inline-flex shrink-0 items-center gap-1.5',
                it.status === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
                {it.status === 'uploading' && <><Loader2 className="size-3 animate-spin" aria-hidden="true" /> lädt…</>}
                {it.status === 'done' && <><Check className="size-3" aria-hidden="true" /> geladen</>}
                {it.status === 'exists' && 'existiert bereits'}
                {it.status === 'error' && <><TriangleAlert className="size-3" aria-hidden="true" /> {it.msg ?? 'Fehler'}</>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
