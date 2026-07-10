import { Link, useParams } from 'react-router-dom'
import { useProjects } from '@/hooks/useProjects'

export function ProjectWorkspace() {
  const { project } = useParams<{ project: string }>()
  const { projects } = useProjects()
  const p = projects.find(x => x.name === project)
  return (
    <div className="p-6">
      <Link className="text-sm underline" to="/">‹ Home</Link>
      <h1 className="my-3 text-xl font-semibold">{project}</h1>
      <ul className="space-y-1">
        {p?.files.map(f => (
          <li key={f.base}>
            <Link className="underline" to={`/p/${encodeURIComponent(project!)}/${encodeURIComponent(f.base)}`}>{f.base}</Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
