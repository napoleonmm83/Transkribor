import { useRef, useState } from 'react'
import { Upload } from 'lucide-react'
import { uploadAudio } from '@/lib/api'
import { cn } from '@/lib/utils'

const AUDIO_RE = /\.(mp3|wav|m4a|aac|flac|ogg|opus|wma|mp4)$/i
type Status = 'uploading' | 'done' | 'exists' | 'error'
type Item = { name: string; status: Status; msg?: string }

export function UploadDropzone({ project, onDone }: { project: string; onDone?: () => void }) {
  const [items, setItems] = useState<Item[]>([])
  const [over, setOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const patch = (name: string, p: Partial<Item>) =>
    setItems(prev => prev.map(it => it.name === name ? { ...it, ...p } : it))

  const upload = async (files: File[]) => {
    const audio = files.filter(f => AUDIO_RE.test(f.name))
    if (!audio.length) return
    setItems(audio.map(f => ({ name: f.name, status: 'uploading' as Status })))
    // ponytail: sequentiell statt Pool — lokale Uploads sind quasi instant; Pool nachruesten bei Bedarf
    for (const f of audio) {
      try { await uploadAudio(project, f); patch(f.name, { status: 'done' }) }
      catch (e) {
        const msg = (e as Error).message
        patch(f.name, { status: /existiert bereits/.test(msg) ? 'exists' : 'error', msg })
      }
    }
    onDone?.()
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
        className={cn('flex items-center justify-center gap-2 rounded border border-dashed p-6 text-sm text-muted-foreground cursor-pointer',
          over && 'border-primary bg-accent')}
      >
        <Upload className="size-4" /> Audio hierher ziehen oder klicken
      </div>
      <input ref={inputRef} data-testid="upload-input" type="file" hidden multiple
        accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.wma,.mp4"
        onChange={e => { upload(Array.from(e.target.files ?? [])); e.target.value = '' }} />
      {items.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs">
          {items.map(it => (
            <li key={it.name} className="flex justify-between gap-2">
              <span className="truncate">{it.name}</span>
              <span className="text-muted-foreground">
                {it.status === 'uploading' && 'lädt…'}
                {it.status === 'done' && '✓'}
                {it.status === 'exists' && 'existiert bereits'}
                {it.status === 'error' && `Fehler: ${it.msg ?? ''}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
