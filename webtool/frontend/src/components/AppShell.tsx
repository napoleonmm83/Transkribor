import { useEffect, useRef, type ReactNode } from 'react'
import { useLocation, useMatch, useNavigate } from 'react-router-dom'
import { ProjektDatenProvider, useProjekte, useDateien } from '@/hooks/useProjektDaten'
import { mergePhases, useActiveJob } from '@/hooks/useActiveJob'
import { useAiReady } from '@/hooks/useAiReady'
import { useDokumentTitel } from '@/hooks/useDokumentTitel'
import { useJob } from '@/hooks/useJob'
import { useOsFortschritt } from '@/hooks/useOsFortschritt'
import { uploadAudio, startTranscribe, startCorrect, startCorrectFile } from '@/lib/api'
import { Sidebar } from './Sidebar'
import { StatusBar } from './StatusBar'
import { TitleBar } from './TitleBar'

/** Getrennt von AppShell, weil sie die Hooks des Providers braucht — die stehen einem
 *  Bauteil erst zur Verfuegung, wenn es INNERHALB des Providers gerendert wird. */
function Leiste() {
  const navigate = useNavigate()
  const { projects, loading, fehler, refresh } = useProjekte()
  const { projekt, files, loading: dateienLaden, refresh: refreshFiles } = useDateien()
  const { jobs, adopt } = useActiveJob()
  const { start } = useJob()
  const aiReason = useAiReady()

  const meine = jobs.filter(j => j.project === projekt && j.status === 'running')
  const phases = mergePhases(meine)     // nur eigenes Projekt, s. mergePhases

  const imEditor = useMatch('/p/:project/:base')
  const active = imEditor?.params.project && imEditor?.params.base
    ? { project: imEditor.params.project, base: imEditor.params.base }
    : null

  const nachladen = () => { refresh(); refreshFiles() }
  return (
    <Sidebar
      projekte={projects} loading={loading} fehler={fehler}
      offen={projekt} dateien={files} dateienLaden={dateienLaden}
      onWaehlen={n => navigate(n ? `/p/${encodeURIComponent(n)}` : '/')}
      active={active}
      onOpen={s => navigate(`/p/${encodeURIComponent(s.project)}/${encodeURIComponent(s.base)}`)}
      onUpload={(p, f) => uploadAudio(p, f).then(nachladen)}
      onTranscribe={p => start(() => startTranscribe(p), `Transkribieren ${p}`, nachladen)}
      onCorrect={p => start(() => startCorrect(p), `Korrigieren ${p}`, nachladen)}
      onCorrectFile={(p, b, force) => start(
        () => startCorrectFile(p, b, force).then(res => { if (res.started) adopt(res.job_id, p, 'correct'); return res }),
        `Korrigieren ${b}`, nachladen)}
      phases={phases} jobRunning={meine.length > 0} aiReason={aiReason} />
  )
}

/**
 * Das Fensterraster der App. Es gibt GENAU eine Stelle, an der das Fenster aufgeteilt wird,
 * und das ist diese — vorher brachte der Editor sein eigenes `h-screen`-Raster mit, waehrend
 * die drei anderen Seiten Lesespalten (`mx-auto max-w-3xl`) waren und bei 1280 px Fenster
 * rund 500 px leer liessen.
 *
 * `min-h-0` an der Inhaltszelle ist nicht schmueckend: eine Grid-Zeile hat `min-height:auto`,
 * womit `1fr` von ihrem Inhalt aufgeblaeht wird und das `overflow-auto` nie greift — die
 * Statuszeile wandert dann unter den unteren Fensterrand.
 */
function Rahmen({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  const inhalt = useRef<HTMLDivElement>(null)
  const titel = useDokumentTitel()
  useOsFortschritt()
  // Kehrseite des EINEN Bildlaufbehaelters: der Versatz ueberlebt den Routenwechsel. Aus
  // einem langen Transkript zurueck zur Uebersicht landete man sonst mitten in der Seite.
  // React Router setzt das absichtlich nicht selbst zurueck — es weiss nicht, welches
  // Element scrollt. `?.` an scrollTo, weil jsdom Element.scrollTo nicht kennt.
  useEffect(() => { inhalt.current?.scrollTo?.({ top: 0 }) }, [pathname])
  return (
    <>
      {/* Erstes fokussierbares Element der Seite. Die Leiste steht seit dieser Aenderung VOR
          dem Inhalt im DOM — ohne Sprunglink laeuft Tab bei dreihundert Projekten durch
          dreihundert Knoepfe, bevor es im Transkript ankommt. `tabIndex={-1}` am Ziel, damit
          der Sprung den Fokus wirklich mitnimmt und nicht nur die Bildlaufposition. */}
      <a href="#inhalt"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50
                   focus:rounded-md focus:border focus:bg-background focus:px-3 focus:py-2
                   focus:text-sm focus:ring-2 focus:ring-ring">
        Zum Inhalt
      </a>
      {/* Unter `md` faellt die Leiste weg. Das Electron-Fenster wird nie so schmal
          (minWidth: 900) — gemeint ist ein verkleinertes Browser-Fenster. Ein Telefon ist
          KEIN Fall: der Server bindet auf 127.0.0.1, von aussen erreicht ihn niemand.
          Darum hier nur ausblenden statt einer einklappbaren Leiste mit gemerktem Zustand:
          auf schmal bleiben die Uebersicht und Ctrl+K als Weg zum Projekt. */}
      <div className="grid h-screen grid-rows-[auto_1fr_auto] md:grid-cols-[260px_1fr]">
        <TitleBar titel={titel} />
        <aside className="hidden min-h-0 border-r md:block"><Leiste /></aside>
        <div id="inhalt" tabIndex={-1} ref={inhalt}
          className="min-h-0 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-ring">{children}</div>
        <StatusBar />
      </div>
    </>
  )
}

/**
 * Rahmt die App EIN: der Datenprovider aussen (braucht `useMatch`, muss also innerhalb des
 * Routers stehen — und `AppShell` steht dort, `main.tsx` nicht), das Fensterraster innen.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <ProjektDatenProvider>
      <Rahmen>{children}</Rahmen>
    </ProjektDatenProvider>
  )
}
