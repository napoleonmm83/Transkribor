import { useId } from 'react'
import { Pause, Play, Users } from 'lucide-react'
import type { Aufnahme } from '@/lib/materialZeilen'
import { sprecherWahl } from '@/lib/sprecher'

/** EINE Aufnahme in der Auswahl: Hören · Name · Sprache · Sprecherzahl.
 *
 *  Reine Darstellung — jede Änderung geht mit ihrem `schluessel` nach oben. Der Zustand
 *  liegt im Dialog, damit ein Schrittwechsel nichts verliert (Spec 6.3).
 */
export function MaterialZeile({ zeile, sprachChoices, sprecherMax, hoerbar, klingt,
                                gesperrt, onSprecher, onSprache, onHoeren }: {
  zeile: Aufnahme
  sprachChoices: { id: string; label: string; hint?: string }[]
  sprecherMax: number
  hoerbar: boolean          // false beim URL-Import: noch nichts heruntergeladen
  klingt: boolean
  gesperrt?: boolean
  onSprecher: (schluessel: string, text: string) => void
  onSprache: (schluessel: string, id: string) => void
  onHoeren: (schluessel: string) => void
}) {
  // `useId()`, NICHT der Schluessel: `aria-describedby` ist eine durch LEERZEICHEN getrennte
  // Liste, und „Interview Mueller.mp3" zerfiele darin in zwei tote Referenzen (#244).
  const hilfeId = useId()
  const w = sprecherWahl(zeile.sprecherText, sprecherMax)
  return (
    <li className="flex min-h-9 items-center gap-2.5">
      <button type="button" disabled={!hoerbar} aria-pressed={klingt}
        aria-label={hoerbar ? `Reinhören: ${zeile.anzeige}`
                            : `${zeile.anzeige} — erst nach dem Herunterladen hörbar`}
        onClick={() => onHoeren(zeile.schluessel)}
        className="flex size-8 shrink-0 items-center justify-center rounded-md border
                   border-input disabled:opacity-40">
        {klingt ? <Pause className="size-3" /> : <Play className="size-3" />}
      </button>

      <span className="min-w-0 flex-1 truncate text-sm" title={zeile.anzeige}>{zeile.anzeige}</span>

      {/* Natives <select>, NICHT shadcn-Select: das rendert ein <button> plus Radix-Portal,
          und zehn davon in einer Scrollflaeche sind teurer als zehn native Felder. Dieselbe
          Abwaegung wie beim Kaestchen in MehrsprachigKasten. */}
      <select value={zeile.sprache} disabled={gesperrt}
        className="h-9 w-40 shrink-0 rounded-md border border-input bg-transparent px-2 text-sm"
        aria-label={`Sprache für ${zeile.anzeige}`}
        onChange={e => onSprache(zeile.schluessel, e.target.value)}>
        {sprachChoices.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
      </select>

      <div className="w-48 shrink-0">
        <span className="flex h-9 items-center overflow-hidden rounded-md border border-input
                         focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
          <span className="flex h-full shrink-0 items-center gap-1.5 border-r border-input
                           bg-muted px-2 text-xs text-muted-foreground">
            <Users className="size-3.5" aria-hidden="true" /> Sprecher
          </span>
          {/* type="text", NIE type="number" (#264): ein Zahlenfeld liefert bei einer
              ungueltigen Zwischeneingabe einen LEEREN value und zeigt den Text trotzdem —
              leer heisst hier „automatisch", die getippte Zahl verschwaende still. */}
          <input type="text" inputMode="numeric" value={zeile.sprecherText} disabled={gesperrt}
            placeholder="automatisch"
            aria-label={`Anzahl Sprecher für ${zeile.anzeige}`}
            aria-invalid={w === undefined || undefined}
            aria-describedby={w === undefined ? hilfeId : undefined}
            onChange={e => onSprecher(zeile.schluessel, e.target.value)}
            className="h-full min-w-0 flex-1 bg-transparent px-2.5 text-sm outline-none" />
        </span>
        {/* Die Id NUR vergeben, wenn der Text auch da ist — ein `aria-describedby` auf eine
            nicht existierende Id ist stumm. */}
        {w === undefined && (
          <p id={hilfeId} className="mt-1 text-xs text-destructive">
            Bitte eine ganze Zahl von 1 bis {sprecherMax} — oder leer lassen.
          </p>
        )}
      </div>
    </li>
  )
}
