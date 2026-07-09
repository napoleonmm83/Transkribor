import { useMemo, useState } from 'react'
import { useProjects } from '@/hooks/useProjects'
import { useDoc } from '@/hooks/useDoc'
import { Toolbar } from '@/components/Toolbar'
import { PlayerDock } from '@/components/PlayerDock'

export default function App() {
  const { projects, refresh } = useProjects()
  const [sel, setSel] = useState<{ project: string; base: string } | null>(null)
  const { doc, dirty, updateSegment, save, exportDownload } = useDoc(sel?.project ?? null, sel?.base ?? null)
  const title = useMemo(() => (sel ? `${sel.project} / ${sel.base}` : '— keine Datei —'), [sel])
  // ponytail: projects/refresh/setSel/updateSegment are wired for Task 8 (Sidebar) / Task 10-11 (Transcript);
  // no consumer yet, so mark used to satisfy noUnusedLocals until those slots land.
  void projects; void refresh; void setSel; void updateSegment

  return (
    <div className="grid h-screen grid-rows-[auto_1fr_auto] grid-cols-[260px_1fr]">
      <aside className="row-span-3 border-r overflow-auto">
        {/* Task 8: <Sidebar projects={projects} onOpen={setSel} onRefresh={refresh} active={sel} /> */}
      </aside>
      <div className="col-start-2"><Toolbar title={title} dirty={dirty} canSave={!!doc}
        onSave={save} onExport={exportDownload} settings={null} /></div>
      <main className="col-start-2 overflow-auto">
        {/* Task 10/11: <Transcript doc={doc} updateSegment={updateSegment} ... /> */}
      </main>
      <div className="col-start-2"><PlayerDock /></div>
    </div>
  )
}
