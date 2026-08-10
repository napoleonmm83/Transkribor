import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useProjects } from '@/hooks/useProjects'
import { useProjectFiles } from '@/hooks/useProjectFiles'
import { useAiReady } from '@/hooks/useAiReady'
import { useDoc } from '@/hooks/useDoc'
import { useJob } from '@/hooks/useJob'
import { mergePhases, useActiveJob } from '@/hooks/useActiveJob'
import { uploadAudio, audioUrl, startTranscribe, startCorrect, startCorrectFile } from '@/lib/api'
import { SKIP, segIdAusFokus } from '@/lib/playback'
import { Sidebar } from '@/components/Sidebar'
import { Toolbar } from '@/components/Toolbar'
import { Transcript } from '@/components/Transcript'
import { PlayerDock } from '@/components/PlayerDock'
import type { WaveHandle } from '@/components/Waveform'

export function EditorView() {
  const { project, base } = useParams<{ project: string; base: string }>()
  const navigate = useNavigate()
  const { projects, loading: projectsLoading, refresh } = useProjects()
  const { files: dateien, refresh: refreshFiles } = useProjectFiles(project!)
  const sel = project && base ? { project, base } : null
  const { doc, dirty, loading: docLoading, updateSegment, renameSpeaker, save, exportDownload, reload } = useDoc(sel?.project ?? null, sel?.base ?? null)
  const { start } = useJob()
  const { jobs, adopt } = useActiveJob()
  const aiReason = useAiReady()          // nicht leer -> Korrektur waere ein Leerlauf
  const meine = useMemo(() => jobs.filter(j => j.project === project && j.status === 'running'),
    [jobs, project])
  const phases = useMemo(() => mergePhases(meine), [meine])   // nur eigenes Projekt, s. mergePhases
  const running = meine.length > 0
  const activeProject = projects.find(x => x.name === project)
  // Dateien kommen jetzt aus useProjectFiles, nicht mehr aus useProjects — Sidebars Prop-Form
  // (Project[]) bleibt, nur die Quelle des `files`-Felds wechselt.
  const sidebarProjects = useMemo(
    () => (activeProject ? [{ ...activeProject, files: dateien }] : []),
    [activeProject, dateien],
  )
  const aktiveIds = (activeProject?.active_jobs ?? []).map(j => j.id).join(',')
  useEffect(() => {
    for (const aj of activeProject?.active_jobs ?? []) adopt(aj.id, project!, aj.kind)
  }, [aktiveIds, project, adopt])  // eslint-disable-line react-hooks/exhaustive-deps
  const title = useMemo(() => (sel ? `${sel.project} / ${sel.base}` : '— keine Datei —'), [sel])
  const waveRef = useRef<WaveHandle>(null)
  const [activeId, setActiveId] = useState<number | null>(null)
  const onTime = useCallback((t: number) => {
    const id = doc?.segments.find(s => t >= s.start && t < s.end)?.id ?? null
    setActiveId(prev => prev === id ? prev : id)
  }, [doc])

  // Ctrl+Space gilt drinnen wie draussen: die blosse Leertaste tippt im Segment ein Leerzeichen
  // und darf nicht umgedeutet werden, und zwei Belegungen je nach Fokus erzeugen nur die Frage
  // "warum geht das hier nicht". Ctrl+←/→ dagegen greifen NUR ausserhalb eines Textfelds: dort
  // sind sie auf Windows/Linux bereits der wortweise Cursorsprung, und der ist beim
  // Textkorrigieren wichtiger als das Spulen (Review Important 2).
  // ponytail: fest verdrahtet. Auf macOS faengt Mission Control Ctrl+←/→ ab und Cmd+Space ist
  // Spotlight — dort kommen die Kuerzel teils nicht an. Konfigurierbar machen, wenn das je
  // jemanden stoert (Issue #36: die Mac-Seite ist bis heute nie gestartet worden).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.shiftKey) return
      if (e.key === ' ') {
        if (e.repeat) return   // gehaltene Taste sonst ein Toggle-Sturm (Review Minor 2)
        e.preventDefault()
        const id = segIdAusFokus(document.activeElement, activeId)
        waveRef.current?.toggle(doc?.segments.find(s => s.id === id) ?? null)
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const el = document.activeElement
        if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement || (el as HTMLElement)?.isContentEditable) return
        e.preventDefault()
        waveRef.current?.skip(e.key === 'ArrowLeft' ? -SKIP : SKIP)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [doc, activeId])

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

  const onUpload = async (p: string, file: File) => { await uploadAudio(p, file); refresh(); refreshFiles() }
  const onTranscribe = (p: string) => start(() => startTranscribe(p), `Transkribieren ${p}`, () => { refresh(); refreshFiles() })
  const onCorrect = (p: string) => start(() => startCorrect(p), `Korrigieren ${p}`, () => { refresh(); refreshFiles() })
  const onCorrectFile = (p: string, b: string, force: boolean) =>
    start(() => startCorrectFile(p, b, force).then(res => { if (res.started) adopt(res.job_id, p, 'correct'); return res }),
      `Korrigieren ${b}`,
      () => { refresh(); refreshFiles(); if (sel?.project === p && sel?.base === b) reload() })

  return (
    <div className="grid h-screen grid-rows-[auto_1fr_auto] grid-cols-[260px_1fr]">
      <aside className="row-span-3 border-r overflow-auto">
        <Sidebar projects={sidebarProjects} loading={projectsLoading}
          active={sel} onOpen={openFile} onUpload={onUpload}
          onTranscribe={onTranscribe} onCorrect={onCorrect} onCorrectFile={onCorrectFile}
          backTo={project ? `/p/${encodeURIComponent(project)}` : '/'} phases={phases} jobRunning={running}
          aiReason={aiReason} />
      </aside>
      <div className="col-start-2"><Toolbar title={title} dirty={dirty} canSave={!!doc}
        onSave={save} onExport={exportDownload} /></div>
      <main className="col-start-2 overflow-auto">
        <Transcript doc={doc} loading={docLoading} activeId={activeId}
          onPlaySeg={s => waveRef.current?.playSegment(s)}
          onPlayTurn={segs => waveRef.current?.playTurn(segs)}
          updateSegment={updateSegment} renameSpeaker={renameSpeaker} />
      </main>
      <div className="col-start-2">
        <PlayerDock url={sel ? audioUrl(sel.project, sel.base) : undefined} onTime={onTime} waveRef={waveRef} />
      </div>
    </div>
  )
}
