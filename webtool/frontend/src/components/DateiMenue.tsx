import { useState } from 'react'
import { useMatch, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { MoreHorizontal, Pencil, RotateCcw, Trash2 } from 'lucide-react'
import type { ProjectFile } from '@/lib/types'
import { deleteFile, startCorrectFile, startRetranscribeFile } from '@/lib/api'
import { useActiveJob } from '@/hooks/useActiveJob'
import { useDateien, useProjekte } from '@/hooks/useProjektDaten'
import { useEditorBruecke } from '@/hooks/useEditorBruecke'
import { useJob } from '@/hooks/useJob'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'

type Aktion = 'correct' | 'transcribe' | 'delete'

/**
 * Die Aktionen EINER Aufnahme — in der Arbeitsflaeche und in der Seitenleiste dasselbe Bauteil.
 *
 * Vorher standen Korrigieren-Knopf und Ueberschreib-Dialog zweimal getrennt im Code, und die
 * beiden Fassungen liefen auseinander: die Arbeitsflaeche schickte immer `force=false`, womit
 * eine handbearbeitete Datei serverseitig still uebersprungen wurde ("Korrektur laesst sich
 * nicht neu anstossen"). Ein Bauteil, ein Verhalten.
 *
 * Alle Anschluesse holt es sich aus den Kontexten (Listen nachladen, Job adoptieren) statt
 * ueber Requisiten — sonst muesste jeder Aufrufer dieselben drei Handler durchreichen, und
 * genau diese Verdopplung war die Ursache.
 */
export function DateiMenue({ project, file, aiReason }: {
  project: string; file: ProjectFile;
  /** Nicht leer = kein nutzbarer KI-Anbieter: Korrigieren gesperrt, Text als Tooltip. */
  aiReason?: string;
}) {
  const [dialog, setDialog] = useState<Aktion | null>(null)
  const { refresh } = useProjekte()
  const { refresh: refreshFiles } = useDateien()
  const { adopt } = useActiveJob()
  const { start } = useJob()
  const editor = useEditorBruecke()
  const navigate = useNavigate()
  const imEditor = useMatch('/p/:project/:base')
  const offen = imEditor?.params.project === project && imEditor?.params.base === file.base

  const nachladen = () => { refresh(); refreshFiles() }
  // Wer die offene Datei VERWIRFT, muss den Editor verlassen: der haelt das alte Dokument im
  // Speicher, und "Speichern" schriebe es zurueck — beim Loeschen legt es die Datei sogar neu
  // an. Fuer die Korrektur gilt das NICHT: dort bleibt das Dokument gueltig, und der Editor
  // laedt es nach dem Lauf nach (s. korrekturFertig).
  const wegVomEditor = () => { if (offen) navigate(`/p/${encodeURIComponent(project)}`) }

  const jobStarten = (fn: () => Promise<{ job_id: string; started: boolean }>, kind: string,
                      label: string, fertig?: () => void) =>
    start(() => fn().then(res => { if (res.started) adopt(res.job_id, project, kind); return res }),
      label, () => { nachladen(); fertig?.() })

  /** Listen allein reichen nicht: der Editor haelt weiter das Dokument von VOR der Korrektur,
   *  und "Speichern" schriebe es ueber die frisch erzeugte edit.json. */
  const korrekturFertig = () => {
    const e = editor.current
    if (e?.project !== project || e.base !== file.base) return
    // Ungespeichertes Nachladen waere stiller Datenverlust andersherum: man startet die
    // Korrektur und tippt weiter, waehrend sie laeuft. Darum die Wahl — und weil beide
    // Ausgaenge etwas kosten, stehen beide im Text.
    if (e.dirty && !window.confirm(
      `Die Korrektur von „${file.base}" ist fertig.\n\n`
      + 'OK: korrigierte Fassung laden — deine ungespeicherten Änderungen gehen verloren.\n'
      + 'Abbrechen: deine Fassung behalten — beim Speichern überschreibst du die Korrektur.')) return
    e.reload()
  }

  const ausfuehren = async (was: Aktion) => {
    setDialog(null)
    if (was === 'correct') {
      jobStarten(() => startCorrectFile(project, file.base, file.has_edit), 'correct',
        `Korrigieren ${file.base}`, korrekturFertig)
    } else if (was === 'transcribe') {
      wegVomEditor()
      jobStarten(() => startRetranscribeFile(project, file.base), 'transcribe', `Transkribieren ${file.base}`)
    } else {
      try { await deleteFile(project, file.base) }
      catch (e) { toast.error(`Löschen fehlgeschlagen: ${(e as Error).message}`); return }
      wegVomEditor()
      toast.success(`„${file.base}" gelöscht`)
      nachladen()
    }
  }

  // Ohne Rueckfrage nur dort, wo nichts verloren geht: eine noch nie korrigierte Datei.
  const waehlen = (was: Aktion) => {
    if (was === 'correct' && !file.has_edit) return ausfuehren('correct')
    if (was === 'transcribe' && !file.has_raw) return ausfuehren('transcribe')
    setDialog(was)
  }

  const texte: Record<Aktion, { titel: string; text: string; knopf: string }> = {
    correct: {
      titel: `„${file.base}" neu korrigieren?`,
      text: 'Überschreibt die vorhandene — womöglich von Hand bearbeitete — Fassung.',
      knopf: 'Neu korrigieren',
    },
    transcribe: {
      titel: `„${file.base}" neu transkribieren?`,
      text: 'Verwirft Transkript, Korrektur und Export dieser Aufnahme und lässt Whisper neu '
        + 'laufen. Das Audio bleibt erhalten; die Korrektur läuft danach automatisch erneut.',
      knopf: 'Neu transkribieren',
    },
    delete: {
      titel: `„${file.base}" löschen?`,
      text: 'Löscht Audio und alle Transkripte dieser Aufnahme unwiderruflich. Das Projekt bleibt bestehen.',
      knopf: 'Löschen',
    },
  }

  return (
    <>
      {/* stopPropagation: in der Seitenleiste ist die ganze Zeile ein Klickziel (Datei oeffnen). */}
      <span onClick={e => e.stopPropagation()} className="inline-flex">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="ghost" className="size-8"
              title="Aktionen" aria-label={`Aktionen für „${file.base}"`}>
              <MoreHorizontal className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {/* title am Element, nicht am Knopf: ein gesperrter Eintrag hat pointer-events:none
                und zeigt seinen eigenen Tooltip nie an. */}
            <DropdownMenuItem disabled={!file.has_raw || !!aiReason} title={aiReason || undefined}
              onSelect={() => waehlen('correct')}>
              <Pencil /> {file.has_edit ? 'Neu korrigieren' : 'Korrigieren'}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!file.has_audio} onSelect={() => waehlen('transcribe')}
              title={file.has_audio ? undefined : 'Kein Audio vorhanden'}>
              <RotateCcw /> {file.has_raw ? 'Neu transkribieren' : 'Transkribieren'}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => waehlen('delete')}>
              <Trash2 /> Löschen
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>

      {/* Ausserhalb des Menues: ein Dialog IM Menue wird beim Schliessen mit ausgehaengt. */}
      <AlertDialog open={dialog !== null} onOpenChange={o => { if (!o) setDialog(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{dialog && texte[dialog].titel}</AlertDialogTitle>
            <AlertDialogDescription>{dialog && texte[dialog].text}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <AlertDialogAction onClick={() => dialog && ausfuehren(dialog)}>
              {dialog && texte[dialog].knopf}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
