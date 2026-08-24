import { toast } from 'sonner'
import type { StartJob } from '@/lib/types'

export function useJob() {
  async function start(fn: () => Promise<StartJob>, label: string, onDone?: () => void) {
    let res: StartJob
    try {
      res = await fn()
    } catch (e) {
      toast.error(`${label} fehlgeschlagen: ${(e as Error).message}`)
      return
    }
    if (!res.started) {
      toast.warning('Es läuft bereits ein Job für dieses Projekt.')
      return
    }
    onDone?.()
  }
  return { start }
}
