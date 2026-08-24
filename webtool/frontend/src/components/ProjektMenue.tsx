import { useState } from 'react'
import { FileArchive, FolderDown, Languages, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { exportProjectMarkdownToDownloads, projectMarkdownZipUrl, triggerDownload } from '@/lib/api'
import { ProjektUmbenennen } from './ProjektUmbenennen'
import { DeleteProjectDialog } from './DeleteProjectDialog'
import { ProjektEinstellungenDialog } from './ProjektEinstellungenDialog'

/**
 * Die Projekt-Aktionen der Uebersicht — Zwilling von DateiMenue, eine Ebene hoeher.
 *
 * Bewusst kein Transkribieren/Korrigieren: die Uebersicht ist zum Finden da — in einer Liste
 * von dreihundert Zeilen einen GPU-Lauf zu starten, ist zu leicht danebengegriffen. Diese Läufe
 * gehören auf die Projektseite, wo man sieht, WAS gerade läuft. Umbenennen, Löschen und die
 * Per-Projekt-Einstellungen (Sprache + Korrektur-Tiefe) starten hingegen keinen Lauf.
 *
 * Vorher stand hier nur ein Papierkorb; Umbenennen gab es ausschliesslich in der Seitenleiste.
 * Das Menue bringt die zerstoererische und die harmlose Aktion an EINE Stelle, statt eine
 * davon zu verstecken.
 */
export function ProjektMenue({ project, onUmbenannt, onGeloescht, onEinstellungenGeaendert }: {
  project: string
  onUmbenannt: (neu: string) => void
  onGeloescht: () => void
  /** Nach dem Speichern der Einstellungen: Projekt-Daten im Workspace neu laden. Optional —
   *  Aufrufer ohne Workspace (z. B. die Galerie) geben nichts mit und es ist ein No-Op. */
  onEinstellungenGeaendert?: () => void
}) {
  const [zeige, setZeige] = useState<'umbenennen' | 'loeschen' | 'einstellungen' | null>(null)

  const exportDownloads = async () => {
    try {
      const res = await exportProjectMarkdownToDownloads(project)
      if (res.anzahl === 0) {
        toast.info('Keine fertigen Markdown-Transkripte im Projekt gefunden.')
      } else {
        toast.success(`${res.anzahl} Markdown-Datei${res.anzahl === 1 ? '' : 'en'} in „Downloads/${project}“ abgelegt`)
      }
    } catch (e) {
      toast.error(`Export fehlgeschlagen: ${(e as Error).message}`)
    }
  }

  const exportZip = () => {
    triggerDownload(projectMarkdownZipUrl(project), `${project}_markdown.zip`)
    toast.success('ZIP-Download gestartet')
  }

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
            <DropdownMenuItem onSelect={() => setZeige('einstellungen')}>
              <Languages /> Sprache &amp; Korrektur
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={exportDownloads}>
              <FolderDown /> Markdown in Downloads ablegen
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={exportZip}>
              <FileArchive /> Markdown als ZIP herunterladen
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => setZeige('loeschen')}>
              <Trash2 /> Löschen
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>

      {/* Ausserhalb des Menues: ein Dialog IM Menue wird beim Schliessen mit ausgehaengt.
          Alle drei Bauteile laufen hier im gesteuerten Modus und zeichnen darum keinen Knopf. */}
      <ProjektUmbenennen project={project} onUmbenannt={onUmbenannt}
        offen={zeige === 'umbenennen'} onOpenChange={o => setZeige(o ? 'umbenennen' : null)} />
      <ProjektEinstellungenDialog project={project}
        offen={zeige === 'einstellungen'} onOpenChange={o => setZeige(o ? 'einstellungen' : null)}
        onGeaendert={onEinstellungenGeaendert} />
      <DeleteProjectDialog project={project} onDeleted={onGeloescht}
        offen={zeige === 'loeschen'} onOpenChange={o => setZeige(o ? 'loeschen' : null)} />
    </>
  )
}
