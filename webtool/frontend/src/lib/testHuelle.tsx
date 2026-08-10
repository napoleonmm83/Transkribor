import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { JobProvider } from '@/hooks/useActiveJob'
import { ProjektDatenProvider } from '@/hooks/useProjektDaten'
import { EditorBrueckeProvider } from '@/hooks/useEditorBruecke'

/**
 * Die Provider-Schichten der echten App fuer Tests einzelner Bauteile.
 *
 * Seit DateiMenue seine Anschluesse aus den Kontexten holt (statt sie als Requisiten
 * durchgereicht zu bekommen), brauchen auch die Tests seiner Wirte diese Huelle — ohne sie
 * wirft useEditorBruecke. Der Pfad ist einstellbar, weil DateiMenue an `/p/:project/:base`
 * erkennt, ob die betroffene Datei gerade im Editor offen ist.
 */
/** Der aktuelle Pfad als `data-testid="ort"` — beide Routen rendern dieselben Kinder, also
 *  laesst sich eine Navigation sonst nicht von "nicht navigiert" unterscheiden. */
function Ort() {
  return <span data-testid="ort">{useLocation().pathname}</span>
}

export function Huelle({ children, pfad = '/p/P' }: { children: ReactNode; pfad?: string }) {
  const inhalt = <><Ort />{children}</>
  return (
    <MemoryRouter initialEntries={[pfad]}>
      <JobProvider>
        <ProjektDatenProvider>
          <EditorBrueckeProvider>
            <Routes>
              <Route path="/p/:project" element={inhalt} />
              <Route path="/p/:project/:base" element={inhalt} />
            </Routes>
          </EditorBrueckeProvider>
        </ProjektDatenProvider>
      </JobProvider>
    </MemoryRouter>
  )
}
