import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { EditDoc, Segment } from '@/lib/types'
import { renameSpeaker as renameInDoc } from '@/lib/grouping'
import { getDoc, saveDoc, exportText, type ExportFmt } from '@/lib/api'

const MIME: Record<ExportFmt, string> = { md: 'text/markdown', srt: 'application/x-subrip' }

/** Ruhe nach der letzten Aenderung, bevor gespeichert wird. */
const AUTOSAVE_MS = 800

/**
 * Was die Anzeige ueber den Speicherstand sagen darf.
 *
 * `ruhig` heisst „seit dem Laden nichts angefasst“ und wird bewusst NICHT als „gespeichert“
 * gezeigt: liegt noch keine `edit.json` auf der Platte, baut der Server das Dokument beim
 * Oeffnen aus dem Rohtranskript — „gespeichert“ waere dort schlicht falsch.
 */
export type SpeicherStand = 'ruhig' | 'offen' | 'speichert' | 'gespeichert' | 'fehler'

export function useDoc(project: string | null, base: string | null) {
  const [doc, setDoc] = useState<EditDoc | null>(null)
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(false)
  const [stand, setStand] = useState<SpeicherStand>('ruhig')
  /** Zaehlt Aenderungen. Nur so laesst sich erkennen, ob waehrend eines Speicherlaufs getippt wurde. */
  const fassung = useRef(0)

  const reload = useCallback(() => {
    if (!project || !base) { setDoc(null); setDirty(false); setStand('ruhig'); return }
    setLoading(true)
    getDoc(project, base).then(d => { setDoc(d); setDirty(false); setStand('ruhig') })
      .catch(() => setDoc(null)).finally(() => setLoading(false))
  }, [project, base])
  useEffect(() => { reload() }, [reload])

  const beruehrt = useCallback(() => { fassung.current++; setDirty(true); setStand('offen') }, [])

  const updateSegment = useCallback((id: number, patch: Partial<Segment>) => {
    setDoc(d => d && ({ ...d, segments: d.segments.map(s => s.id === id ? { ...s, ...patch } : s) }))
    beruehrt()
  }, [beruehrt])

  const renameSpeaker = useCallback((from: string, to: string) => {
    if (!from || !to || from === to) return   // Guard hier, nicht im setDoc-Updater: der muss rein bleiben
    setDoc(d => d && renameInDoc(d, from, to))
    beruehrt()
  }, [beruehrt])

  const save = useCallback(async () => {
    if (!doc || !project || !base) return
    const v = fassung.current
    setStand('speichert')
    try {
      await saveDoc(project, base, doc)
      // Wurde waehrend des Laufs weitergetippt, ist das Geschriebene schon wieder alt: `dirty`
      // muss stehen bleiben, sonst faellt genau diese Aenderung lautlos unter den Tisch. Die
      // Entprellung unten hat fuer sie bereits einen neuen Lauf angesetzt.
      if (fassung.current !== v) { setStand('offen'); return }
      setDirty(false); setStand('gespeichert')
    } catch (e) {
      setStand('fehler')   // `dirty` bleibt -> die Rueckfragen beim Verlassen greifen weiter
      toast.error('Speichern fehlgeschlagen: ' + (e as Error).message)
    }
  }, [doc, project, base])

  // Autosave. `save` haengt an `doc`, wechselt also mit jedem Tastendruck die Identitaet — der
  // Effekt raeumt den alten Timer ab und legt einen neuen. Genau das IST die Entprellung, ein
  // zweiter Zeitgeber waere daneben nur eine zweite Wahrheit.
  // Nach einem Fehlschlag aendert sich keine Abhaengigkeit mehr: es wird also nicht in einer
  // Schleife nachgetreten, der naechste Tastendruck versucht es erneut.
  useEffect(() => {
    if (!dirty) return
    const t = setTimeout(() => { void save() }, AUTOSAVE_MS)
    return () => clearTimeout(t)
  }, [dirty, save])

  const exportDownload = useCallback(async (fmt: ExportFmt, sprecher = true) => {
    if (!project || !base) return
    try {
      const text = await exportText(project, base, fmt, sprecher)
      const a = document.createElement('a')
      a.href = URL.createObjectURL(new Blob([text], { type: MIME[fmt] }))
      a.download = `${base}.${fmt}`; a.click()
      // Erst im naechsten Task freigeben: click() stoesst den Download nur an, sofort
      // widerrufen zieht ihm die URL unter den Fuessen weg. Ohne das Freigeben haelt der
      // Editor jeden je exportierten Blob bis zum Reload fest.
      setTimeout(() => URL.revokeObjectURL(a.href), 0)
    } catch (e) { toast.error('Export fehlgeschlagen: ' + (e as Error).message) }
  }, [project, base])

  // `save` wandert bewusst NICHT nach draussen: es gibt keinen Speichern-Knopf mehr, und eine
  // zweite Ausloesestelle waere eine, die neben der Entprellung herlaeuft.
  return { doc, dirty, stand, loading, updateSegment, renameSpeaker, exportDownload, reload }
}
