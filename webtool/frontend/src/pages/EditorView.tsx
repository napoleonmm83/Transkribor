import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
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

export function EditorView() {
  const { project, base } = useParams<{ project: string; base: string }>()
  const navigate = useNavigate()
  const { projects, loading: projectsLoading, refresh } = useProjects()
  const sel = project && base ? { project, base } : null
  const { doc, dirty, loading: docLoading, updateSegment, save, exportDownload, reload } = useDoc(sel?.project ?? null, sel?.base ?? null)
  const { thr, setThr } = useThresholds()
  const { start } = useJob()
  const title = useMemo(() => (sel ? `${sel.project} / ${sel.base}` : '— keine Datei —'), [sel])
  const waveRef = useRef<WaveHandle>(null)
  const [activeId, setActiveId] = useState<number | null>(null)
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
    navigate(`/p/${encodeURIComponent(s.project)}/${encodeURIComponent(s.base)}`)
  }

  const onUpload = async (p: string, file: File) => { await uploadAudio(p, file); refresh() }
  const onTranscribe = (p: string) => start(() => startTranscribe(p), `Transkribieren ${p}`, refresh)
  const onCorrect = (p: string) => start(() => startCorrect(p), `Korrigieren ${p}`, refresh)
  const onCorrectFile = (p: string, b: string, force: boolean) =>
    start(() => startCorrectFile(p, b, force), `Korrigieren ${b}`,
      () => { refresh(); if (sel?.project === p && sel?.base === b) reload() })

  return (
    <div className="grid h-screen grid-rows-[auto_1fr_auto] grid-cols-[260px_1fr]">
      <aside className="row-span-3 border-r overflow-auto">
        <Sidebar projects={projects} loading={projectsLoading} active={sel} onOpen={openFile} onUpload={onUpload}
          onTranscribe={onTranscribe} onCorrect={onCorrect} onCorrectFile={onCorrectFile} />
      </aside>
      <div className="col-start-2"><Toolbar title={title} dirty={dirty} canSave={!!doc}
        onSave={save} onExport={exportDownload} settings={<ThresholdPopover thr={thr} setThr={setThr} />} /></div>
      <main className="col-start-2 overflow-auto">
        <Transcript doc={doc} loading={docLoading} thr={thr} activeId={activeId}
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
