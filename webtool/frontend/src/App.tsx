import { Routes, Route } from 'react-router-dom'
import { HomeGallery } from '@/pages/HomeGallery'
import { ProjectWorkspace } from '@/pages/ProjectWorkspace'
import { EditorView } from '@/pages/EditorView'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomeGallery />} />
      <Route path="/p/:project" element={<ProjectWorkspace />} />
      <Route path="/p/:project/:base" element={<EditorView />} />
    </Routes>
  )
}
