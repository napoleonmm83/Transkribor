import { useState } from 'react'
import { useMatch, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Bot, FileDown, Languages, MoreHorizontal, Pencil, RotateCcw, Trash2 } from 'lucide-react'
import type { ProjectFile } from '@/lib/types'
import { deleteFile, fileMarkdownUrl, getDoc, renameFile, startCorrectFile, startRetranscribeFile, triggerDownload } from '@/lib/api'
import { UmbenennenDialog, sprecherNamen } from './UmbenennenDialog'
import { DateiEinstellungenDialog } from './DateiEinstellungenDialog'
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
  const [umbenennen, setUmbenennen] = useState(false)
  const [einstellungen, setEinstellungen] = useState(false)
  const [sprecher, setSprecher] = useState<string[]>([])
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
  // laedt es nach dem Lauf nach (EditorView lauscht auf onSettled, #123).
  const wegVomEditor = () => { if (offen) navigate(`/p/${encodeURIComponent(project)}`) }
  /** #106-Review C1/C2: bevor der Editor eine Datei verlaesst, die der Server gerade zerstoert
   *  oder verschiebt, verwirft er seine ungespeicherte Fassung — sonst spuelte der Verlassens-
   *  Flush sie als Waise ans alte Ziel zurueck (Backend save_file legt sie bedingungslos neu an).
   *  Nur wenn DIESE Datei offen ist: eine andere offene Datei darf nicht angestastet werden. */
  const editorVergessen = () => { if (offen) editor.current?.vergiss() }

  const jobStarten = (fn: () => Promise<{ job_id: string; started: boolean }>, kind: string,
                      label: string) =>
    start(() => fn().then(res => { if (res.started) adopt(res.job_id, project, kind, [file.base]); return res }),
      label, nachladen)

  const ausfuehren = async (was: Aktion) => {
    setDialog(null)
    if (was === 'correct') {
      jobStarten(() => startCorrectFile(project, file.base, file.has_edit), 'correct',
        `Korrigieren ${file.base}`)
    } else if (was === 'transcribe') {
      // Erst navigieren, wenn der Lauf wirklich angenommen ist: bei 409 (ein Job laeuft schon)
      // wurde nichts verworfen — den Editor trotzdem zu verlassen waere ein Verlust ohne Anlass.
      jobStarten(() => startRetranscribeFile(project, file.base)
        .then(res => { if (res.started) { editorVergessen(); wegVomEditor() }; return res }),
        'transcribe', `Transkribieren ${file.base}`)
    } else {
      try { await deleteFile(project, file.base) }
      catch (e) { toast.error(`Löschen fehlgeschlagen: ${(e as Error).message}`); return }
      editorVergessen()
      wegVomEditor()
      toast.success(`„${file.base}“ gelöscht`)
      nachladen()
    }
  }

  /** Beim Oeffnen des Umbenennen-Dialogs die Sprechernamen holen — EIN Request auf Klick,
   *  nicht in der Dateiliste: die haelt sich seit PR #67 bewusst von jedem Dokumentzugriff
   *  fern. Ohne Transkript gibt es nichts zu holen (der Endpunkt antwortete 404). */
  const umbenennenOeffnen = () => {
    setSprecher([])
    setUmbenennen(true)
    if (file.has_raw) getDoc(project, file.base).then(d => setSprecher(sprecherNamen(d))).catch(() => {})
  }

  const umbenannt = async (neu: string) => {
    // Der Editor laedt beim Pfadwechsel neu — ungespeichertes waere sonst still weg.
    if (offen && editor.current?.dirty && !window.confirm(
      `„${file.base}“ hat ungespeicherte Änderungen.\n\n`
      + 'Beim Umbenennen wird die Datei neu geladen — die Änderungen gehen verloren.')) return false
    const res = await renameFile(project, file.base, neu)
    editorVergessen()   // sonst spuelte der Flush die alte Fassung als Waise ans alte Base
    if (offen) navigate(`/p/${encodeURIComponent(project)}/${encodeURIComponent(res.name)}`, { replace: true })
    toast.success(`„${file.base}“ heisst jetzt „${res.name}“`)
    nachladen()
  }

  /** Sprache/Tiefe geändert und gespeichert -> die nötige Neuberechnung anstossen. Sprache-Wechsel
   *  dominiert (Neu-Transkription, die Kette zieht die Korrektur nach); nur Tiefe -> Neu-Korrektur
   *  mit force=true (sonst überspränge correct.py eine human_edited-Datei still). Ohne has_raw
   *  bleibt es beim Override — die nächste Transkription übernimmt ihn. */
  const einstellungenGespeichert = ({ neuTranskribieren, neuKorrigieren }: {
    neuTranskribieren: boolean; neuKorrigieren: boolean }) => {
    toast.success(`Einstellungen für „${file.base}“ gespeichert`)
    if (!file.has_raw) return
    // neuTranskribieren deckt Sprachwechsel UND den Mehrsprachig-Haken ab — beide aendern,
    // wie der Decoder laeuft, ein vorhandenes Transkript ist danach nach anderen Regeln entstanden.
    if (neuTranskribieren) {
      jobStarten(() => startRetranscribeFile(project, file.base)
        .then(res => { if (res.started) { editorVergessen(); wegVomEditor() }; return res }),
        'transcribe', `Neu transkribieren ${file.base}`)
    // neuKorrigieren deckt die Korrektur-Tiefe UND die Sprecherzahl ab: die akustische
    // Diarisierung laeuft als Prep-Schritt von `correct run`, eine neue Sprecherzahl wirkt
    // also ueber genau diesen Job (und ueber keinen anderen).
    } else if (neuKorrigieren) {
      jobStarten(() => startCorrectFile(project, file.base, true), 'correct',
        `Neu korrigieren ${file.base}`)
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
      titel: `„${file.base}“ neu korrigieren?`,
      text: 'Überschreibt die vorhandene — womöglich von Hand bearbeitete — Fassung.',
      knopf: 'Neu korrigieren',
    },
    transcribe: {
      titel: `„${file.base}“ neu transkribieren?`,
      text: 'Verwirft Transkript, Korrektur und Export dieser Aufnahme und lässt Whisper neu '
        + 'laufen. Das Audio bleibt erhalten; die Korrektur läuft danach automatisch erneut.',
      knopf: 'Neu transkribieren',
    },
    delete: {
      titel: `„${file.base}“ löschen?`,
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
              title="Aktionen" aria-label={`Aktionen für „${file.base}“`}>
              <MoreHorizontal className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {/* title am UMSCHLIESSENDEN span, nicht am Eintrag: ein gesperrter Eintrag traegt
                pointer-events:none und zeigt seinen eigenen Tooltip nie an — dieselbe Falle wie
                bei den gesperrten Knoepfen in Arbeitsflaeche und Leiste. Genau der Grund, warum
                der Eintrag ueberhaupt gesperrt ist, stuende sonst nirgends. */}
            <span title={aiReason || undefined} className="block">
              <DropdownMenuItem disabled={!file.has_raw || !!aiReason}
                onSelect={() => waehlen('correct')}>
                <Bot /> {file.has_edit ? 'Neu korrigieren' : 'Korrigieren'}
              </DropdownMenuItem>
            </span>
            <span title={file.has_audio ? undefined : 'Kein Audio vorhanden'} className="block">
              <DropdownMenuItem disabled={!file.has_audio} onSelect={() => waehlen('transcribe')}>
                <RotateCcw /> {file.has_raw ? 'Neu transkribieren' : 'Transkribieren'}
              </DropdownMenuItem>
            </span>
            <DropdownMenuItem onSelect={umbenennenOeffnen}>
              <Pencil /> Umbenennen
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setEinstellungen(true)}>
              <Languages /> Sprache, Sprecher &amp; Korrektur
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <span title={file.has_raw || file.has_edit ? undefined : 'Noch kein Transkript vorhanden'} className="block">
              <DropdownMenuItem disabled={!file.has_raw && !file.has_edit}
                onSelect={() => triggerDownload(fileMarkdownUrl(project, file.base), `${file.base}.md`)}>
                <FileDown /> Markdown herunterladen (.md)
              </DropdownMenuItem>
            </span>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => waehlen('delete')}>
              <Trash2 /> Löschen
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>

      <UmbenennenDialog offen={umbenennen} onOpenChange={setUmbenennen} wert={file.base}
        titel="Aufnahme umbenennen" vorschlaege={sprecher}
        beschreibung="Audio und alle Transkripte dieser Aufnahme wandern mit. Nichts wird neu gerechnet."
        onSpeichern={umbenannt} />

      <DateiEinstellungenDialog project={project} base={file.base} file={file}
        offen={einstellungen} onOpenChange={setEinstellungen}
        onGespeichert={einstellungenGespeichert} />

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
