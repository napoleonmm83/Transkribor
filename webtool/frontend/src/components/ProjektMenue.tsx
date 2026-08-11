import { useState } from 'react'
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ProjektUmbenennen } from './ProjektUmbenennen'
import { DeleteProjectDialog } from './DeleteProjectDialog'

/**
 * Die Projekt-Aktionen der Uebersicht — Zwilling von DateiMenue, eine Ebene hoeher.
 *
 * Bewusst NUR Umbenennen und Loeschen: die Uebersicht ist zum Finden da. Transkribieren und
 * Korrigieren gehoeren auf die Projektseite, wo man sieht, WAS gerade laeuft — in einer Liste
 * von dreihundert Zeilen einen GPU-Lauf zu starten, ist zu leicht danebengegriffen.
 *
 * Vorher stand hier nur ein Papierkorb; Umbenennen gab es ausschliesslich in der Seitenleiste.
 * Das Menue bringt die zerstoererische und die harmlose Aktion an EINE Stelle, statt eine
 * davon zu verstecken.
 */
export function ProjektMenue({ project, onUmbenannt, onGeloescht }: {
  project: string
  onUmbenannt: (neu: string) => void
  onGeloescht: () => void
}) {
  const [zeige, setZeige] = useState<'umbenennen' | 'loeschen' | null>(null)

  return (
    <>
      {/* stopPropagation + preventDefault: in der Uebersicht liegt das Menue neben einem Link,
          der die ganze Zeile fuellt — ohne das oeffnet ein Klick zusaetzlich das Projekt. */}
      <span onClick={e => { e.stopPropagation(); e.preventDefault() }} className="inline-flex">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="ghost" className="size-8"
              title="Aktionen" aria-label={`Aktionen für „${project}“`}>
              <MoreHorizontal className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setZeige('umbenennen')}>
              <Pencil /> Umbenennen
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => setZeige('loeschen')}>
              <Trash2 /> Löschen
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>

      {/* Ausserhalb des Menues: ein Dialog IM Menue wird beim Schliessen mit ausgehaengt.
          Beide Bauteile laufen hier im gesteuerten Modus und zeichnen darum keinen Knopf. */}
      <ProjektUmbenennen project={project} onUmbenannt={onUmbenannt}
        offen={zeige === 'umbenennen'} onOpenChange={o => setZeige(o ? 'umbenennen' : null)} />
      <DeleteProjectDialog project={project} onDeleted={onGeloescht}
        offen={zeige === 'loeschen'} onOpenChange={o => setZeige(o ? 'loeschen' : null)} />
    </>
  )
}
