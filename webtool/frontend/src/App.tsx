import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useProjects } from '@/hooks/useProjects'
import { useDoc } from '@/hooks/useDoc'
import { useThresholds } from '@/hooks/useThresholds'
import { useJob } from '@/hooks/useJob'
import { uploadAudio, audioUrl, startTranscribe, startCorrect, startCorrectFile } from '@/lib/api'
import { Sidebar } from '@/components/Sidebar'
import { Toolbar } from '@/components/Toolbar'
import { Transcript } from '@/components/Transcript'
import { ThresholdPopover } from '@/components/ThresholdPopover'
import { PlayerDock } from '@/components/PlayerDock'
import type { WaveHandle } from '@/components/Waveform'

export default function App() {
  const { projects, refresh } = useProjects()
  const [sel, setSel] = useState<{ project: string; base: string } | null>(null)
  const { doc, dirty, updateSegment, save, exportDownload, reload } = useDoc(sel?.project ?? null, sel?.base ?? null)
  const { thr, setThr } = useThresholds()
  const { start } = useJob()
  const title = useMemo(() => (sel ? `${sel.project} / ${sel.base}` : '— keine Datei —'), [sel])
  const waveRef = useRef<WaveHandle>(null)
  const [activeId, setActiveId] = useState<number | null>(null)
  // onTime feuert ~60fps; nur bei tatsächlichem Segmentwechsel neu rendern (sonst rendert
  // der ganze Transcript-Baum pro Frame statt ein paar Mal pro Minute).
  const onTime = useCallback((t: number) => {
    const id = doc?.segments.find(s => t >= s.start && t < s.end)?.id ?? null
    setActiveId(prev => prev === id ? prev : id)
  }, [doc])

  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  const openFile = (s: { project: string; base: string }) => {
    const same = sel?.project === s.project && sel?.base === s.base
    if (!same && dirty && !window.confirm('Ungespeicherte Änderungen verwerfen?')) return
    setSel(s)
  }

  const onUpload = async (project: string, file: File) => { await uploadAudio(project, file); refresh() }
  const onTranscribe = (project: string) => start(() => startTranscribe(project), `Transkribieren ${project}`, refresh)
  const onCorrect = (project: string) => start(() => startCorrect(project), `Korrigieren ${project}`, refresh)
  const onCorrectFile = (project: string, base: string, force: boolean) =>
    start(() => startCorrectFile(project, base, force), `Korrigieren ${base}`,
      () => { refresh(); if (sel?.project === project && sel?.base === base) reload() })

  return (
    <div className="grid h-screen grid-rows-[auto_1fr_auto] grid-cols-[260px_1fr]">
      <aside className="row-span-3 border-r overflow-auto">
        <Sidebar projects={projects} active={sel} onOpen={openFile} onUpload={onUpload}
          onTranscribe={onTranscribe} onCorrect={onCorrect} onCorrectFile={onCorrectFile} />
      </aside>
      <div className="col-start-2"><Toolbar title={title} dirty={dirty} canSave={!!doc}
        onSave={save} onExport={exportDownload} settings={<ThresholdPopover thr={thr} setThr={setThr} />} /></div>
      <main className="col-start-2 overflow-auto">
        <Transcript doc={doc} thr={thr} activeId={activeId}
          onPlaySeg={s => waveRef.current?.playSegment(s)}
          onPlayTurn={segs => waveRef.current?.playTurn(segs)}
          updateSegment={updateSegment} />
      </main>
      <div className="col-start-2">
        <PlayerDock url={sel ? audioUrl(sel.project, sel.base) : undefined} onTime={onTime} waveRef={waveRef} />
      </div>
    </div>
  )
}
