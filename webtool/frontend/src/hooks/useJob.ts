import { toast } from 'sonner'
import { useActiveJob } from './useActiveJob'
import type { StartJob } from '@/lib/types'

export function useJob() {
  // ZWEI der drei Startwege gehen durch diese Funktion (`AppShell`, `DateiMenue`) — hier
  // sitzt der `started: false`-Zweig. Ohne das Verfolgen erreichte die Vorgangsnummer den
  // Provider auf diesen Wegen nie, und der Nachlauf bliebe stumm wie vor #381.
  const { verfolge } = useActiveJob()

  async function start(fn: () => Promise<StartJob>, label: string, onDone?: () => void) {
    let res: StartJob
    try {
      res = await fn()
    } catch (e) {
      toast.error(`${label} fehlgeschlagen: ${(e as Error).message}`)
      return
    }
    if (!res.started) {
      if (res.vorgang) {
        verfolge(res.vorgang)
        // Der alte Text („Es läuft bereits ein Job") sagte nur die halbe Wahrheit: er nannte
        // den Grund und verschwieg die Folge — dass die Arbeit vorgemerkt IST.
        // BEWUSST ohne „deine Aufnahme": dieser Weg traegt auch das projektweite
        // „Korrigieren", bei dem gar nichts hochgeladen wurde.
        toast.info('Es läuft bereits etwas — die Arbeit ist vorgemerkt und kommt danach dran.')
      } else {
        toast.warning('Es läuft bereits ein Job für dieses Projekt.')
      }
      return
    }
    onDone?.()
  }
  return { start }
}
