import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useDoc } from '@/hooks/useDoc'
import { useEditorMelden } from '@/hooks/useEditorBruecke'
import { useActiveJob } from '@/hooks/useActiveJob'
import { useSuche } from '@/hooks/useSuche'
import { audioUrl } from '@/lib/api'
import { SKIP, segIdAusFokus } from '@/lib/playback'
import { Toolbar } from '@/components/Toolbar'
import { Transcript } from '@/components/Transcript'
import { PlayerDock } from '@/components/PlayerDock'
import type { WaveHandle } from '@/components/Waveform'

export function EditorView() {
  const { project, base } = useParams<{ project: string; base: string }>()
  const sel = project && base ? { project, base } : null
  const { doc, dirty, stand, loading: docLoading, updateSegment, updateDoc, renameSpeaker, exportDownload, reload, vergiss } = useDoc(sel?.project ?? null, sel?.base ?? null)
  // Die Leiste in der Huelle navigiert und startet Einzeldatei-Korrekturen — beides braucht
  // Dinge, die nur hier existieren. Ohne diese Meldung wechselt ein Klick ohne Rueckfrage
  // ueber ungespeicherte Aenderungen hinweg, und ein Korrekturlauf bleibt unsichtbar.
  useEditorMelden(sel ? { ...sel, dirty, stand, reload, vergiss } : null)

  // #123: Eine ferngestartete Korrektur (Workspace „Korrigieren" oder laeuft schon beim Oeffnen)
  // sieht der Editor sonst nicht — useJob.onDone erreicht nur das ⋯-Menue derselben Datei. Der
  // JobProvider adoptiert JEDE Korrektur (useProjektDaten aus active_jobs plus explizite adopt),
  // also ist onSettled die eine zuverlaessige Quelle und hat korrekturFertig im DateiMenue
  // ersetzt (sonst Doppel-Reload/Prompt bei ⋯-Menue-Korrekturen — useJob und JobProvider sind
  // zwei unabhaengige Polls). Base-Match per perBase[base]==='done': skip/failed aendern die
  // edit.json nicht, eine Rueckfrage waere dort irrefuehrend. Gleiche Dirty-Abfrage wie das alte
  // korrekturFertig; reload() beruehrt project/base nicht -> kein #106-Verlassens-Flush, der
  // haengende Autosave laeuft weiter (derselbe Pfad wie bisher). dirtyRef statt dirty in den Deps:
  // sonst neu abonniert bei jedem Tastendruck; der Ref ist im Render fresh.
  const { onSettled } = useActiveJob()
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty
  useEffect(() => {
    if (!project || !base) return
    const p = project, b = base
    return onSettled(beendet => {
      const j = beendet.find(j => j.kind === 'correct' && j.project === p && j.phases.perBase[b] === 'done')
      if (!j) return
      if (dirtyRef.current && !window.confirm(
        `Die Korrektur von „${b}“ ist fertig.\n\n`
        + 'OK: korrigierte Fassung laden — deine ungespeicherten Änderungen gehen verloren.\n'
        + 'Abbrechen: deine Fassung behalten — beim Speichern überschreibst du die Korrektur.')) return
      reload()
    })
  }, [project, base, reload, onSettled])

  const [suchQuery, setSuchQuery] = useState('')
  const [suchIndex, setSuchIndex] = useState(0)
  // useSuche durchsucht seit #128 Kontext, Zusammenfassung, Segmente und Anmerkungen — die
  // Trefferliste vereinigt alle Arten in Dokumentreihenfolge (Kopf, Segmente, Anmerkungen).
  const treffer = useSuche(doc, suchQuery)
  const suchAktiv = suchQuery.trim() !== ''
  const anzahl = treffer.treffer.length
  // Index clamp beim Lesen: schrumpft die Trefferliste (neuer Query), kann suchIndex
  // einen Tick überholen, bevor der Reset-Effekt greift — hier defensiv begrenzen.
  const idx = anzahl ? Math.min(suchIndex, anzahl - 1) : 0
  const aktivOrt = suchAktiv && anzahl ? (treffer.treffer[idx] ?? null) : null
  const suchAktivId = aktivOrt?.kind === 'segment' ? aktivOrt.id : null
  // Grey-out-Mengen je Treffer-Art; Memo ueber dem stabilen treffer-Objekt (useSuche memt selbst).
  const kopfTreffer = useMemo(() => {
    const s = new Set<'context' | 'summary'>()
    for (const t of treffer.treffer) if (t.kind === 'kopf') s.add(t.field)
    return s
  }, [treffer])
  const annotTreffer = useMemo(() => {
    const s = new Set<number>()
    for (const t of treffer.treffer) if (t.kind === 'annotation') s.add(t.index)
    return s
  }, [treffer])
  // Neuer Suchbegriff -> am ersten Treffer beginnen.
  useEffect(() => { setSuchIndex(0) }, [suchQuery])
  // Dateiwechsel -> altes Transkript ist hinfällig.
  useEffect(() => { setSuchQuery(''); setSuchIndex(0) }, [sel?.base])
  const suchNext = () => setSuchIndex(i => anzahl ? (i + 1) % anzahl : 0)
  const suchPrev = () => setSuchIndex(i => anzahl ? (i - 1 + anzahl) % anzahl : 0)
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

  // Bleibt trotz Autosave: zwischen dem letzten Tastendruck und dem Schreiben liegen 800 ms, und
  // ein fehlgeschlagener Lauf haelt `dirty` dauerhaft oben.
  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  return (
    // Nur noch der Inhalt: die Projektnavigation zieht in die AppShell (Task 5).
    <div className="grid h-full grid-rows-[auto_1fr_auto]">
      <Toolbar stand={stand} bereit={!!doc} onExport={exportDownload}
        suchQuery={suchQuery} onSuchChange={setSuchQuery} suchCount={anzahl} suchIndex={idx}
        onSuchPrev={suchPrev} onSuchNext={suchNext} />
      <main className="min-h-0 overflow-auto">
        <Transcript doc={doc} loading={docLoading} activeId={activeId}
          onPlaySeg={s => waveRef.current?.playSegment(s)}
          onPlayTurn={segs => waveRef.current?.playTurn(segs)}
          updateSegment={updateSegment} updateDoc={updateDoc} renameSpeaker={renameSpeaker}
          sucheAktiv={suchAktiv} trefferIds={treffer.segmentTreffer} suchAktivId={suchAktivId}
          kopfTreffer={kopfTreffer} annotTreffer={annotTreffer} aktivOrt={aktivOrt} />
      </main>
      <PlayerDock url={sel ? audioUrl(sel.project, sel.base) : undefined} onTime={onTime} waveRef={waveRef} />
    </div>
  )
}
