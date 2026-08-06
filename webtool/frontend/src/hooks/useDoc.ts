import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { EditDoc, Segment } from '@/lib/types'
import { renameSpeaker as renameInDoc } from '@/lib/grouping'
import { getDoc, saveDoc, exportMd } from '@/lib/api'

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

  const exportDownload = useCallback(async () => {
    if (!project || !base) return
    try {
      const md = await exportMd(project, base)
      const a = document.createElement('a')
      a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }))
      a.download = `${base}.md`; a.click()
    } catch (e) { toast.error('Export fehlgeschlagen: ' + (e as Error).message) }
  }, [project, base])

  return { doc, dirty, loading, updateSegment, renameSpeaker, save, exportDownload, reload }
}
