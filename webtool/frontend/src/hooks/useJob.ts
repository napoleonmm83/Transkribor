import { toast } from 'sonner'
import { getJob, cancelJob } from '@/lib/api'
import type { StartJob } from '@/lib/types'

export function useJob() {
  async function start(fn: () => Promise<StartJob>, label: string, onDone?: () => void) {
    let res: StartJob
    try { res = await fn() } catch (e) { toast.error(`${label} fehlgeschlagen: ${(e as Error).message}`); return }
    if (!res.started) { toast.warning('Es läuft bereits ein Job für dieses Projekt.'); return }
    const id = toast.loading(`${label}…`, {
      duration: Infinity,
      action: { label: 'Abbrechen', onClick: () => { cancelJob(res.job_id) } },
    })
    const tick = async () => {
      let j
      try { j = await getJob(res.job_id) } catch { toast.error(`${label}: Job nicht gefunden`, { id }); return }
      const tail = j.lines.slice(-3).join('\n')
      if (j.status === 'running') {
        toast.loading(`${label}\n${tail}`, { id, duration: Infinity,
          action: { label: 'Abbrechen', onClick: () => { cancelJob(res.job_id) } } })
        setTimeout(tick, 1500)
      } else {
        if (j.status === 'done') toast.success(`${label} fertig`, { id, duration: 4000 })
        else if (j.status === 'cancelled') toast.warning(`${label} abgebrochen`, { id, duration: 4000 })
        else toast.error(`${label} — Fehler\n${tail}`, { id, duration: 8000 })
        onDone?.()
      }
    }
    tick()
  }
  return { start }
}
