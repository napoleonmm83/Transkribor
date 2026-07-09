import { useCallback, useEffect, useState } from 'react'
import type { EditDoc, Segment } from '@/lib/types'
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

  const save = useCallback(async () => {
    if (!doc || !project || !base) return
    await saveDoc(project, base, doc); setDirty(false)
  }, [doc, project, base])

  const exportDownload = useCallback(async () => {
    if (!project || !base) return
    const md = await exportMd(project, base)
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }))
    a.download = `${base}.md`; a.click()
  }, [project, base])

  return { doc, dirty, loading, updateSegment, save, exportDownload, reload }
}
