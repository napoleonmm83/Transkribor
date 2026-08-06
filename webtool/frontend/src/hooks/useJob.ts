import { toast } from 'sonner'
import { getJob, cancelJob } from '@/lib/api'
import { describePhases, parseJobPhases } from '@/lib/jobPhases'
import type { StartJob } from '@/lib/types'

export function useJob() {
  async function start(fn: () => Promise<StartJob>, label: string, onDone?: () => void) {
    let res: StartJob
    try { res = await fn() } catch (e) { toast.error(`${label} fehlgeschlagen: ${(e as Error).message}`); return }
    if (!res.started) { toast.warning('Es läuft bereits ein Job für dieses Projekt.'); return }
    let cancelling = false
    const id = toast.loading(`${label}…`, { duration: Infinity, action: { label: 'Abbrechen', onClick: () => cancel() } })
    const cancel = () => {
      cancelling = true
      cancelJob(res.job_id)
      toast.loading(`${label}\nwird abgebrochen…`, { id, duration: Infinity })
    }
    const tick = async () => {
      let j
      try { j = await getJob(res.job_id) } catch { toast.error(`${label}: Job nicht gefunden`, { id }); return }
      if (j.status === 'running') {
        // description statt roher Log-Zeilen: die enthalten Pfade und pyannote-Warnungen,
        // und Sonner rendert '\n' nicht als Umbruch -> alles klebte zu einem Klumpen zusammen.
        toast.loading(label, { id, duration: Infinity,
          description: describePhases(parseJobPhases(j.kind ?? '', j.lines)) || undefined,
          action: cancelling ? undefined : { label: 'Abbrechen', onClick: cancel } })
        setTimeout(tick, 1500)
      } else {
        if (j.status === 'done') toast.success(`${label} fertig`, { id, duration: 4000 })
        else if (j.status === 'cancelled') toast.warning(`${label} abgebrochen`, { id, duration: 4000 })
        // Im Fehlerfall bleiben die Roh-Zeilen die einzige Diagnose — sonst steht der Nutzer ohne da.
        else toast.error(`${label} — Fehler`, { id, duration: 8000,
          description: j.lines.filter(l => l.trim()).slice(-3).join(' · ') || undefined })
        onDone?.()
      }
    }
    tick()
  }
  return { start }
}
