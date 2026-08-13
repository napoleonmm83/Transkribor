import { useEffect, useRef, type ReactNode } from 'react'
import { useLocation, useMatch, useNavigate } from 'react-router-dom'
import { ProjektDatenProvider, useProjekte, useDateien } from '@/hooks/useProjektDaten'
import { mergePhases, useActiveJob } from '@/hooks/useActiveJob'
import { useAiReady } from '@/hooks/useAiReady'
import { EditorBrueckeProvider, useEditorBruecke } from '@/hooks/useEditorBruecke'
import { useDokumentTitel } from '@/hooks/useDokumentTitel'
import { useJob } from '@/hooks/useJob'
import { useOsFortschritt } from '@/hooks/useOsFortschritt'
import { uploadAudio, startTranscribe, startCorrect } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Sidebar } from './Sidebar'
import { StatusBar } from './StatusBar'
import { TitleBar, hatTitelzeile } from './TitleBar'

/** Getrennt von AppShell, weil sie die Hooks des Providers braucht — die stehen einem
 *  Bauteil erst zur Verfuegung, wenn es INNERHALB des Providers gerendert wird. */
function Leiste() {
  const navigate = useNavigate()
  const { projects, loading, fehler, refresh } = useProjekte()
  const { projekt, files, loading: dateienLaden, refresh: refreshFiles } = useDateien()
  const { jobs } = useActiveJob()
  const { start } = useJob()
  const aiReason = useAiReady()

  const meine = jobs.filter(j => j.project === projekt && j.status === 'running')
  const phases = mergePhases(meine)     // nur eigenes Projekt, s. mergePhases

  const imEditor = useMatch('/p/:project/:base')
  const active = imEditor?.params.project && imEditor?.params.base
    ? { project: imEditor.params.project, base: imEditor.params.base }
    : null

  const editor = useEditorBruecke()
  // Jeder Klick hier verlaesst den Editor. Seit #106 fragt die Leiste nur noch bei stand='fehler':
  // in der Tipppause ('offen') hatte die Oberflaeche "wird gespeichert" versprochen, und useDoc
  // spült den neuesten Stand beim Verlassen selbst (useEffect-Cleanup an der Speicher-Kette). Auf
  // 'fehler' dagegen stand der nie beim Server — dort muss die Rueckfrage bleiben. `beforeunload`
  // greift nur beim Schliessen des Tabs, nicht bei Router-Navigation.
  // Die drei Server-Prozess-Rueckfragen (DateiMenue ×2, ProjektUmbenennen) pruefen weiter `dirty`
  // — dort laeuft ein Server-Prozess ueber dieselbe Datei, den der Browser-Flush nicht einholt.
  const wechselErlaubt = (ziel: { project: string; base: string } | null) => {
    const e = editor.current
    if (!e || e.stand !== 'fehler') return true
    if (ziel && ziel.project === e.project && ziel.base === e.base) return true   // dieselbe Datei
    return window.confirm('Ungespeicherte Änderungen verwerfen?')
  }

  const nachladen = () => { refresh(); refreshFiles() }
  return (
    <Sidebar
      projekte={projects} loading={loading} fehler={fehler}
      offen={projekt} dateien={files} dateienLaden={dateienLaden}
      onWaehlen={n => { if (wechselErlaubt(null)) navigate(n ? `/p/${encodeURIComponent(n)}` : '/') }}
      // Getrennt von onWaehlen (#74): dort heisst `null` „zuklappen", ein Anlegen kennt das
      // nicht. Der Wechsel-Waechter bleibt — auch ein frisch angelegtes Projekt navigiert
      // vom Editor weg und darf Ungespeichertes nicht stillschweigend hinter sich lassen.
      onAngelegt={n => { if (wechselErlaubt(null)) navigate(`/p/${encodeURIComponent(n)}`) }}
      active={active}
      onOpen={s => { if (wechselErlaubt(s)) navigate(`/p/${encodeURIComponent(s.project)}/${encodeURIComponent(s.base)}`) }}
      onUpload={(p, f) => uploadAudio(p, f).then(nachladen)}
      onTranscribe={p => start(() => startTranscribe(p), `Transkribieren ${p}`, nachladen)}
      onCorrect={p => start(() => startCorrect(p), `Korrigieren ${p}`, nachladen)}
      // Die Datei-Aktionen (korrigieren/neu transkribieren/loeschen) haengen nicht mehr hier:
      // sie stehen in DateiMenue, das sich Nachladen, Job-Adoption und die Editor-Bruecke selbst
      // aus den Kontexten holt. Eine durchgereichte Kette hatte zwei Fassungen desselben Knopfs
      // (Leiste mit Ueberschreib-Rueckfrage, Arbeitsflaeche ohne) auseinanderlaufen lassen.
      // Weg von der Seite des geloeschten Projekts -- sonst steht dort "Projekt nicht
      // gefunden". Keine zweite Rueckfrage: der Dialog hat den Namen abtippen lassen.
      onGeloescht={() => { navigate('/'); refresh() }}
      // Anders als beim Loeschen gibt es das Ziel noch — nur unter anderem Namen. Steht eine
      // Datei dieses Projekts im Editor, muss sie MITwandern: sonst zeigt die Adresse auf ein
      // Projekt, das es nicht mehr gibt. replace, weil der alte Pfad tot ist und der
      // Zurueck-Knopf sonst dorthin fuehrt.
      onUmbenannt={(alt, neu) => {
        const ziel = active?.project === alt
          ? `/p/${encodeURIComponent(neu)}/${encodeURIComponent(active.base)}`
          : `/p/${encodeURIComponent(neu)}`
        navigate(ziel, { replace: true })
        refresh()
      }}
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
  const inhalt = useRef<HTMLElement>(null)   // seit #72 ein <main>, kein <div>
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
          auf schmal bleibt Ctrl+K der Weg zu JEDEM Projekt — die Uebersicht listet nur die
          fuenf juengsten, ist also kein vollwertiger Ersatz. */}
      {/* Zeilenzahl NACH der Titelzeile: im Browser rendert sie `null` und steuert kein
          Rasterelement bei -- mit drei festen Zeilen rutscht dann alles hoch, der Inhalt in
          `auto`, die Statuszeile in `1fr` (gemessen 374 px Leerraum unter ihr). */}
      <div className={cn('grid h-screen md:grid-cols-[260px_1fr]',
        hatTitelzeile() ? 'grid-rows-[auto_1fr_auto]' : 'grid-rows-[1fr_auto]')}>
        <TitleBar titel={titel} />
        <aside className="hidden min-h-0 border-r md:block"><Leiste /></aside>
        {/* `<main>`, nicht `<div>` (#72) — und zwar an DIESER Stelle, weil hier der Sprunglink
            landet: ein Sprungziel ohne Landmarke ist fuer eine Vorlesehilfe eine Stelle ohne
            Namen. Der Umbau erledigt zugleich die zweite Haelfte des Issues: `<header>` gilt
            nur dann als `banner`, wenn es NICHT in `main`/`article`/`section`/`aside`/`nav`
            steckt. Vorher hingen `PageHeader` und `Toolbar` in einem blossen `div`, waren also
            beide `banner` — unter Electron zusammen mit der `TitleBar` gleich zwei davon auf
            einem Schirm. Seit sie in `main` liegen, bleibt genau EINE: die Titelzeile.
            Preis, bewusst bezahlt: im Browser (dort rendert `TitleBar` `null`) gibt es damit
            gar keinen `banner` mehr. Das ist erlaubt und ehrlicher — der Seitenkopf einer
            Unterseite ist kein seitenweiter Kopf.
            **`EditorView` musste dafuer sein eigenes `<main>` abgeben** (zwei ineinander sind
            ungueltig); die Huelle traegt es jetzt fuer alle Seiten. */}
        <main id="inhalt" tabIndex={-1} ref={inhalt}
          className="min-h-0 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-ring">{children}</main>
        <StatusBar />
      </div>
    </>
  )
}

/**
 * Rahmt die App EIN: der Datenprovider aussen (braucht `useMatch`, muss also innerhalb des
 * Routers stehen — und `AppShell` steht dort, `main.tsx` nicht), die Editor-Bruecke darin
 * (Leiste UND Editor liegen darunter), das Fensterraster innen.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <ProjektDatenProvider>
      <EditorBrueckeProvider>
        <Rahmen>{children}</Rahmen>
      </EditorBrueckeProvider>
    </ProjektDatenProvider>
  )
}
