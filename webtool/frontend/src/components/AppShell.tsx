import { useEffect, useRef, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { StatusBar } from './StatusBar'
import { ProjektDatenProvider } from '@/hooks/useProjektDaten'

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
  // Kehrseite des EINEN Bildlaufbehaelters: der Versatz ueberlebt den Routenwechsel. Aus
  // einem langen Transkript zurueck zur Uebersicht landete man sonst mitten in der Seite.
  // React Router setzt das absichtlich nicht selbst zurueck — es weiss nicht, welches
  // Element scrollt. `?.` an scrollTo, weil jsdom Element.scrollTo nicht kennt.
  useEffect(() => { inhalt.current?.scrollTo?.({ top: 0 }) }, [pathname])
  return (
    <div className="grid h-screen grid-rows-[1fr_auto]">
      <div ref={inhalt} className="min-h-0 overflow-auto">{children}</div>
      <StatusBar />
    </div>
  )
}
