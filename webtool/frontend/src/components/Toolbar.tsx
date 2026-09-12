import { ArrowLeft, Check, CircleHelp, Download, Subtitles, TriangleAlert } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { ExportFmt } from '@/lib/api'
import type { SpeicherStand } from '@/hooks/useDoc'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { FLAGS } from './SegmentView'
import { Suchfeld } from './Suchfeld'

/**
 * Der Speicherstand in Worten. `offen` und `speichert` tragen denselben Text: dazwischen liegen
 * 800 ms, und zwei Wechsel je Tipppause waeren ein Flackern an einer Stelle, die man im
 * Augenwinkel hat — „wird gespeichert“ stimmt fuer beide (die Aenderung ist angesetzt bzw. laeuft).
 */
const STAND: Record<Exclude<SpeicherStand, 'ruhig'>, { text: string; punkt: 'warten' | 'gut' | 'fehler' }> = {
  offen: { text: 'wird gespeichert …', punkt: 'warten' },
  speichert: { text: 'wird gespeichert …', punkt: 'warten' },
  gespeichert: { text: 'gespeichert', punkt: 'gut' },
  fehler: { text: 'nicht gespeichert', punkt: 'fehler' },
}

export function Toolbar({ projekt, zurueckErlaubt, stand, bereit, onExport, suchQuery, onSuchChange, suchCount = 0, suchIndex = 0, onSuchPrev, onSuchNext }: {
  /** Projekt der offenen Aufnahme — Ziel des Rueckwegs. Fehlt es, entfaellt der Link, und die
   *  Leiste rendert damit auch AUSSERHALB eines Routers (ein unbedingter `Link` wuerde dort
   *  werfen; zwei Tests dieser Datei laufen genau so). */
  projekt?: string;
  /** Darf der Rueckweg jetzt gegangen werden? Fehlt er, gilt ja. Der Klick verlaesst den
   *  Editor wie ein Klick in der Leiste — und muss deshalb durch dieselbe Rueckfrage
   *  (`useEditorBruecke.darfWechseln`); ohne sie ginge die Aenderung nach einem
   *  fehlgeschlagenen Speichern STILL verloren. */
  zurueckErlaubt?: () => boolean;
  stand: SpeicherStand; bereit: boolean;
  onExport: (fmt: ExportFmt, sprecher?: boolean) => void;
  suchQuery?: string; onSuchChange?: (v: string) => void;
  suchCount?: number; suchIndex?: number; onSuchPrev?: () => void; onSuchNext?: () => void;
}) {
  const anzeige = stand === 'ruhig' ? null : STAND[stand]
  const sucht = onSuchChange !== undefined
  return (
    // Kein sticky noetig: EditorView setzt die Leiste als eigene Grid-Zeile, gescrollt wird
    // nur das <main> darunter.
    <header className="flex items-center gap-2 border-b px-3 py-2">
      {/* Der EINZIGE Weg aus einer geoeffneten Aufnahme zurueck zum Projekt — der Editor ist
          die einzige Seite ohne `PageHeader`, und die Leiste links faellt unter `md` ganz weg.
          Bewusst dieselbe Geste wie dort (Pfeil + Ziel, gedaempft, Hover auf `foreground`):
          ein zweites Muster fuer dieselbe Bewegung waere eines zu viel. Beschriftet mit dem
          ZIEL statt mit dem Wort „zurueck"; das `aria-label` nennt den Ort ausdruecklich und
          enthaelt den sichtbaren Text (WCAG 2.5.3). Kein `outline-none` — wie in `PageHeader`
          bleibt der Standard-Fokusring stehen.
          `min-w-0 max-w-48 truncate`: Projektnamen sind Nutzereingaben, und diese Zeile traegt
          schon Speicherstand, Suche, Legende und zwei Export-Knoepfe. */}
      {projekt && (
        <Link to={`/p/${encodeURIComponent(projekt)}`}
          onClick={e => { if (zurueckErlaubt && !zurueckErlaubt()) e.preventDefault() }}
          aria-label={`Zur Projektseite von ${projekt}`}
          className="-ml-1 inline-flex min-w-0 max-w-48 shrink items-center gap-1.5 rounded-md
                     px-2 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground">
          <ArrowLeft className="size-4 shrink-0" aria-hidden="true" />
          <span className="truncate">{projekt}</span>
        </Link>
      )}
      {/* aria-live: es speichert von selbst, es klickt also niemand und schaut hin. */}
      {anzeige && (
        <span aria-live="polite"
          className={'inline-flex shrink-0 items-center gap-1.5 text-xs '
            + (anzeige.punkt === 'fehler' ? 'text-destructive' : 'text-muted-foreground')}>
          {anzeige.punkt === 'gut' ? <Check className="size-3" aria-hidden="true" />
            : anzeige.punkt === 'fehler' ? <TriangleAlert className="size-3" aria-hidden="true" />
            : <span className="size-1.5 rounded-full bg-amber-500" aria-hidden="true" />}
          {anzeige.text}
        </span>
      )}
      <div className="flex-1" />
      {sucht && (
        <Suchfeld value={suchQuery ?? ''} onChange={onSuchChange!} count={suchCount} index={suchIndex}
          onPrev={onSuchPrev ?? (() => {})} onNext={onSuchNext ?? (() => {})} />
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="icon" variant="ghost" aria-label="Legende"><CircleHelp className="size-4" /></Button>
        </TooltipTrigger>
        {/* Symbole aus derselben Quelle wie die Segmente (FLAGS) — vorher standen sie doppelt
            im Code und konnten auseinanderlaufen. Die Wortfarben stehen seit dem Wegfall der
            Schwellen-Schieber nur noch hier: sonst erklaert sie im Editor nichts mehr. */}
        <TooltipContent className="max-w-80">
          <span className="flex flex-col gap-2.5">
            {FLAGS.map(f => (
              <span key={f.key} className="flex gap-1.5">
                <f.icon className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                <span>{f.titel} — <span className="opacity-70">{f.erklaerung}</span></span>
              </span>
            ))}
            <span className="border-t pt-2 opacity-70">
              Im unkorrigierten Text markiert die Farbe, wie sicher sich Whisper beim einzelnen
              Wort war: <span className="u-yellow">unsicher</span> unter 0.60,{' '}
              <span className="u-red">sehr unsicher</span> unter 0.40. Der genaue Wert steht im
              Tooltip des Wortes.
            </span>
          </span>
        </TooltipContent>
      </Tooltip>
      <Button size="sm" variant="secondary" disabled={!bereit} onClick={() => onExport('md')}>
        <Download className="size-4" /> Export .md
      </Button>
      {/* .srt laedt man bei YouTube unter "Untertitel > Datei hochladen" hoch. Zwei Eintraege
          statt eines Schalters: der Zustand muesste sonst irgendwo leben und waere beim
          naechsten Export wieder zu raten. */}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="secondary" disabled={!bereit}>
                <Subtitles className="size-4" /> Untertitel .srt
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>Zeitcodierte Untertitel für den YouTube-Upload</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => onExport('srt')}>Mit Sprechernamen</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onExport('srt', false)}>Ohne Sprechernamen</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Der Theme-Umschalter stand hier und NUR hier — jetzt in der Fusszeile, die auf
          jeder Seite da ist. Zweimal auf demselben Schirm waere er einmal zu viel. */}
    </header>
  )
}
