import { Routes, Route } from 'react-router-dom'
import { HomeGallery } from '@/pages/HomeGallery'
import { ProjectWorkspace } from '@/pages/ProjectWorkspace'
import { EditorView } from '@/pages/EditorView'
import { SettingsPage } from '@/pages/SettingsPage'
import { VersionPage } from '@/pages/VersionPage'
import { ProjektPalette } from '@/components/ProjektPalette'
import { AppShell } from '@/components/AppShell'

export default function App() {
  // ProjektPalette hier, nicht in HomeGallery: das ist die oberste Stelle, an der der
  // Router rahmt -- Ctrl+K muss auch im Editor greifen, wo es kein Suchfeld gibt.
  // Innerhalb der AppShell, seit die den ProjektDatenProvider mitbringt (Task 3): die Palette
  // liest jetzt useProjekte() und braucht dessen Kontext. Das schadet der Rasterzelle nicht --
  // ein Radix-Dialog portalt seinen Inhalt ohnehin nach document.body, unabhaengig davon, wo
  // er im Baum haengt.
  return (
    <AppShell>
      <ProjektPalette />
      <Routes>
        <Route path="/" element={<HomeGallery />} />
        <Route path="/einstellungen" element={<SettingsPage />} />
        <Route path="/version" element={<VersionPage />} />
        <Route path="/p/:project" element={<ProjectWorkspace />} />
        <Route path="/p/:project/:base" element={<EditorView />} />
      </Routes>
    </AppShell>
  )
}
