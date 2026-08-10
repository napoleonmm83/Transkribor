import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
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
export function Huelle({ children, pfad = '/p/P' }: { children: ReactNode; pfad?: string }) {
  return (
    <MemoryRouter initialEntries={[pfad]}>
      <JobProvider>
        <ProjektDatenProvider>
          <EditorBrueckeProvider>
            <Routes>
              <Route path="/p/:project" element={<>{children}</>} />
              <Route path="/p/:project/:base" element={<>{children}</>} />
            </Routes>
          </EditorBrueckeProvider>
        </ProjektDatenProvider>
      </JobProvider>
    </MemoryRouter>
  )
}
