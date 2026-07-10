import { Link } from 'react-router-dom'
import { useProjects } from '@/hooks/useProjects'

export function HomeGallery() {
  const { projects } = useProjects()
  return (
    <div className="p-6">
      <h1 className="mb-4 text-xl font-semibold">Transkribor</h1>
      <ul className="space-y-1">
        {projects.map(p => (
          <li key={p.name}><Link className="underline" to={`/p/${encodeURIComponent(p.name)}`}>{p.name}</Link></li>
        ))}
      </ul>
    </div>
  )
}
