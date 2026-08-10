import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useProjekte } from '@/hooks/useProjektDaten'
import { useDoc } from '@/hooks/useDoc'
import { useActiveJob } from '@/hooks/useActiveJob'
import { audioUrl } from '@/lib/api'
import { SKIP, segIdAusFokus } from '@/lib/playback'
import { Toolbar } from '@/components/Toolbar'
import { Transcript } from '@/components/Transcript'
import { PlayerDock } from '@/components/PlayerDock'
import type { WaveHandle } from '@/components/Waveform'

export function EditorView() {
  const { project, base } = useParams<{ project: string; base: string }>()
  const { projects } = useProjekte()
  const sel = project && base ? { project, base } : null
  const { doc, dirty, loading: docLoading, updateSegment, renameSpeaker, save, exportDownload } = useDoc(sel?.project ?? null, sel?.base ?? null)
  const { adopt } = useActiveJob()
  const activeProject = projects.find(x => x.name === project)
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

  return (
    // Nur noch der Inhalt: die Projektnavigation zieht in die AppShell (Task 5).
    <div className="grid h-full grid-rows-[auto_1fr_auto]">
      <Toolbar title={title} dirty={dirty} canSave={!!doc} onSave={save} onExport={exportDownload} />
      <main className="min-h-0 overflow-auto">
        <Transcript doc={doc} loading={docLoading} activeId={activeId}
          onPlaySeg={s => waveRef.current?.playSegment(s)}
          onPlayTurn={segs => waveRef.current?.playTurn(segs)}
          updateSegment={updateSegment} renameSpeaker={renameSpeaker} />
      </main>
      <PlayerDock url={sel ? audioUrl(sel.project, sel.base) : undefined} onTime={onTime} waveRef={waveRef} />
    </div>
  )
}
