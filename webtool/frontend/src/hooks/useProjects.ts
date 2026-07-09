import { useCallback, useEffect, useState } from 'react'
import type { Project } from '@/lib/types'
import { listProjects } from '@/lib/api'

export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const refresh = useCallback(() => {
    setLoading(true)
    listProjects().then(setProjects).catch(() => setProjects([])).finally(() => setLoading(false))
  }, [])
  useEffect(() => { refresh() }, [refresh])
  return { projects, loading, refresh }
}
