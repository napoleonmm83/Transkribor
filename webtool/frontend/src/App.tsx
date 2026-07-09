import { useMemo, useRef, useState } from 'react'
import { useProjects } from '@/hooks/useProjects'
import { useDoc } from '@/hooks/useDoc'
import { useThresholds } from '@/hooks/useThresholds'
import { uploadAudio, audioUrl } from '@/lib/api'
import { Sidebar } from '@/components/Sidebar'
import { Toolbar } from '@/components/Toolbar'
import { Transcript } from '@/components/Transcript'
import { ThresholdPopover } from '@/components/ThresholdPopover'
import { PlayerDock } from '@/components/PlayerDock'
import type { WaveHandle } from '@/components/Waveform'

export default function App() {
  const { projects, refresh } = useProjects()
  const [sel, setSel] = useState<{ project: string; base: string } | null>(null)
  const { doc, dirty, updateSegment, save, exportDownload } = useDoc(sel?.project ?? null, sel?.base ?? null)
  const { thr, setThr } = useThresholds()
  const title = useMemo(() => (sel ? `${sel.project} / ${sel.base}` : '— keine Datei —'), [sel])
  const waveRef = useRef<WaveHandle>(null)
  const [currentTime, setCurrentTime] = useState(0)
  // ponytail: editing lands in Task 11; Transcript here is read-only, onEdit is a stub.
  void updateSegment
  const onUpload = async (project: string, file: File) => { await uploadAudio(project, file); refresh() }
  const noop = () => {}

  return (
    <div className="grid h-screen grid-rows-[auto_1fr_auto] grid-cols-[260px_1fr]">
      <aside className="row-span-3 border-r overflow-auto">
        <Sidebar projects={projects} active={sel} onOpen={setSel} onUpload={onUpload}
          onTranscribe={noop} onCorrect={noop} onCorrectFile={noop} />
      </aside>
      <div className="col-start-2"><Toolbar title={title} dirty={dirty} canSave={!!doc}
        onSave={save} onExport={exportDownload} settings={<ThresholdPopover thr={thr} setThr={setThr} />} /></div>
      <main className="col-start-2 overflow-auto">
        <Transcript doc={doc} thr={thr} currentTime={currentTime}
          onPlaySeg={s => waveRef.current?.playSegment(s)}
          onPlayTurn={segs => waveRef.current?.playTurn(segs)}
          onEdit={noop} />
      </main>
      <div className="col-start-2">
        <PlayerDock url={sel ? audioUrl(sel.project, sel.base) : undefined} onTime={setCurrentTime} waveRef={waveRef} />
      </div>
    </div>
  )
}
