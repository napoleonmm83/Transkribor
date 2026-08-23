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
        // Den AUSGANG meldet seit #376 `useJobAusgang` — EINMAL im Rahmen, ueber den
        // JobProvider, also fuer JEDEN Startweg gleich. Hier stand er auch, und genau das war
        // die Spaltung: die Knoepfe der Seitenleiste (dieser Weg) meldeten einen Fehlschlag,
        // dieselben Knoepfe der Arbeitsflaeche (kein `useJob`) meldeten nichts.
        //
        // Uebrig bleibt, den Laufenden-Toast wegzunehmen — zwei Meldungen ueber dasselbe Ende
        // waeren die Kehrseite der Vereinheitlichung. Die Rohzeilen sind dabei ersatzlos
        // entfallen: sie sind fuer den Parser geschrieben, nicht fuer Menschen (derselbe
        // Grund, aus dem es `describePhases` gibt), und sie beantworteten die Frage nicht,
        // die zaehlt — WELCHE Datei. Das tut `useJobAusgang` aus `perBase`.
        //
        // VORBEDINGUNG: der Aufrufer muss den Job adoptieren (`adopt`), sonst kennt der
        // JobProvider ihn nicht und der Ausgang faellt ganz aus. Beide Aufrufer tun das
        // (AppShell.tsx, DateiMenue.tsx) und je ein Test haelt es fest.
        toast.dismiss(id)
        onDone?.()
      }
    }
    tick()
  }
  return { start }
}
