import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { EditDoc, Segment } from '@/lib/types'
import { renameSpeaker as renameInDoc } from '@/lib/grouping'
import { getDoc, saveDoc, exportText, type ExportFmt } from '@/lib/api'

const MIME: Record<ExportFmt, string> = { md: 'text/markdown', srt: 'application/x-subrip' }

export function useDoc(project: string | null, base: string | null) {
  const [doc, setDoc] = useState<EditDoc | null>(null)
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(false)

  const reload = useCallback(() => {
    if (!project || !base) { setDoc(null); setDirty(false); return }
    setLoading(true)
    getDoc(project, base).then(d => { setDoc(d); setDirty(false) })
      .catch(() => setDoc(null)).finally(() => setLoading(false))
  }, [project, base])
  useEffect(() => { reload() }, [reload])

  const updateSegment = useCallback((id: number, patch: Partial<Segment>) => {
    setDoc(d => d && ({ ...d, segments: d.segments.map(s => s.id === id ? { ...s, ...patch } : s) }))
    setDirty(true)
  }, [])

  const renameSpeaker = useCallback((from: string, to: string) => {
    if (!from || !to || from === to) return   // Guard hier, nicht im setDoc-Updater: der muss rein bleiben
    setDoc(d => d && renameInDoc(d, from, to))
    setDirty(true)
  }, [])

  const save = useCallback(async () => {
    if (!doc || !project || !base) return
    try { await saveDoc(project, base, doc); setDirty(false); toast.success('Gespeichert') }
    catch (e) { toast.error('Speichern fehlgeschlagen: ' + (e as Error).message) }
  }, [doc, project, base])

  const exportDownload = useCallback(async (fmt: ExportFmt) => {
    if (!project || !base) return
    try {
      const text = await exportText(project, base, fmt)
      const a = document.createElement('a')
      a.href = URL.createObjectURL(new Blob([text], { type: MIME[fmt] }))
      a.download = `${base}.${fmt}`; a.click()
      // Erst im naechsten Task freigeben: click() stoesst den Download nur an, sofort
      // widerrufen zieht ihm die URL unter den Fuessen weg. Ohne das Freigeben haelt der
      // Editor jeden je exportierten Blob bis zum Reload fest.
      setTimeout(() => URL.revokeObjectURL(a.href), 0)
    } catch (e) { toast.error('Export fehlgeschlagen: ' + (e as Error).message) }
  }, [project, base])

  return { doc, dirty, loading, updateSegment, renameSpeaker, save, exportDownload, reload }
}
