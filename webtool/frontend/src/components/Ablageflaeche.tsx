import { useRef } from 'react'
import { Upload } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useState } from 'react'

/** Das Drop-Ziel, aus `UploadDropzone` herausgeloest: reine Darstellung, meldet nur Dateien.
 *
 *  Die Tastatur bekommt DIESELBE Sperre wie die Maus (PR #297) — sonst oeffnet Enter den
 *  Dateidialog, der Nutzer waehlt aus, und die Auswahl wird still verworfen. Ein toter Weg,
 *  und einer, der ausgerechnet die Tastaturbedienung trifft: mit der Maus passiert sichtbar
 *  nichts, per Tastatur passiert scheinbar etwas und dann doch nicht.
 */
export function Ablageflaeche({ gesperrt, onDateien }: {
  gesperrt?: boolean
  onDateien: (dateien: File[]) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const oeffnen = () => { if (!gesperrt) inputRef.current?.click() }
  return (
    <>
      <div
        role="button" tabIndex={0} aria-label="Audio hochladen"
        aria-disabled={gesperrt || undefined}
        onClick={oeffnen}
        onKeyDown={e => {
          if (gesperrt) return
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); oeffnen() }
        }}
        onDragOver={e => { e.preventDefault(); if (!gesperrt) setOver(true) }}
        onDragLeave={() => setOver(false)}
        onDrop={e => {
          e.preventDefault(); setOver(false)
          if (!gesperrt) onDateien(Array.from(e.dataTransfer.files))
        }}
        // Fokusring explizit: die Flaeche ist ein div mit tabIndex, bekaeme also nur den
        // Standardring des Browsers — und sie ist die groesste Klickflaeche hier.
        className={cn('flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed p-6 text-sm text-muted-foreground',
          'outline-none focus-visible:ring-2 focus-visible:ring-ring',
          over && 'border-primary bg-accent text-accent-foreground')}
      >
        <div className="text-center">
          <div className="flex items-center justify-center gap-2">
            <Upload className="size-4" /> Audio hierher ziehen oder klicken
          </div>
          <div className="mt-1 text-xs">Mehrere auf einmal sind möglich.</div>
        </div>
      </div>
      <input ref={inputRef} data-testid="ablage-input" type="file" hidden multiple
        accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.wma,.mp4"
        onChange={e => { onDateien(Array.from(e.target.files ?? [])); e.target.value = '' }} />
    </>
  )
}
