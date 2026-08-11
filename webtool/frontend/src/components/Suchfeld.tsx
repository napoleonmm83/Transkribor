import { Search, ChevronUp, ChevronDown, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

/**
 * Sichtbares Suchfeld in der Editor-Werkzeugleiste — keine Tastatur-Shortcuts. Tippen graut
 * im Editor alle Nicht-Treffer aus; ▲/▽ springen von Treffer zu Treffer, ✕ leert das Feld.
 * Zähler und Knöpfe erscheinen erst, sobald eine Eingabe dasteht.
 */
export function Suchfeld({ value, onChange, count, index, onPrev, onNext }: {
  value: string; onChange: (v: string) => void
  count: number; index: number
  onPrev: () => void; onNext: () => void
}) {
  const aktiv = value.trim() !== ''
  return (
    <div className="flex items-center gap-1">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        {/* type="text" (nicht "search"): der Browser-Eigenbau-Clear-Knopf wuerde sonst doppelt
            neben unserem ✕ stehen. */}
        <Input type="text" value={value} onChange={e => onChange(e.target.value)}
          placeholder="Im Transkript suchen …" aria-label="Im Transkript suchen"
          className="h-8 w-44 pl-7 text-sm" />
      </div>
      {aktiv && (
        <>
          <span className="min-w-[4rem] text-center text-xs tabular-nums text-muted-foreground" aria-live="polite">
            {count === 0 ? 'keine Treffer' : `${index + 1} / ${count}`}
          </span>
          <Button variant="ghost" size="icon-xs" aria-label="Voriger Treffer" disabled={count === 0} onClick={onPrev}>
            <ChevronUp className="size-3.5" aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="icon-xs" aria-label="Nächster Treffer" disabled={count === 0} onClick={onNext}>
            <ChevronDown className="size-3.5" aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="icon-xs" aria-label="Suche leeren" onClick={() => onChange('')}>
            <X className="size-3.5" aria-hidden="true" />
          </Button>
        </>
      )}
    </div>
  )
}
