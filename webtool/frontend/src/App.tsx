import { Routes, Route } from 'react-router-dom'
import { HomeGallery } from '@/pages/HomeGallery'
import { ProjectWorkspace } from '@/pages/ProjectWorkspace'
import { EditorView } from '@/pages/EditorView'
import { SettingsPage } from '@/pages/SettingsPage'
import { ProjektPalette } from '@/components/ProjektPalette'
import { AppShell } from '@/components/AppShell'

export default function App() {
  // ProjektPalette hier, nicht in HomeGallery: das ist die oberste Stelle, an der der
  // Router rahmt -- Ctrl+K muss auch im Editor greifen, wo es kein Suchfeld gibt.
  // Sie steht NEBEN der AppShell, nicht darin: ein Dialog gehoert nicht in eine Rasterzelle
  // mit `overflow-auto`, sonst scrollt der Hintergrund unter ihm weg.
  return (
    <>
      <ProjektPalette />
      <AppShell>
        <Routes>
          <Route path="/" element={<HomeGallery />} />
          <Route path="/einstellungen" element={<SettingsPage />} />
          <Route path="/p/:project" element={<ProjectWorkspace />} />
          <Route path="/p/:project/:base" element={<EditorView />} />
        </Routes>
      </AppShell>
    </>
  )
}
