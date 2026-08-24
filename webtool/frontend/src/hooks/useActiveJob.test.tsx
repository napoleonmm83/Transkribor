import { StrictMode, useEffect } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { JobProvider, mergePhases, useActiveJob, type Job } from './useActiveJob'
import { parseJobPhases } from '@/lib/jobPhases'
import type { JobPhases } from '@/lib/types'
import * as api from '@/lib/api'

vi.mock('@/lib/api')

function Probe({ beiSettled }: { beiSettled?: (beendet: Job[]) => void } = {}) {
  const { jobs, adopt, onSettled } = useActiveJob()
  const phases = mergePhases(jobs.filter(j => j.status === 'running'))
  // GENAU wie ProjectWorkspace.tsx: der Verbraucher registriert sich in einem Effekt.
  useEffect(() => (beiSettled ? onSettled(beiSettled) : undefined), [onSettled, beiSettled])
  return (
    <div>
      <button onClick={() => adopt('j1', 'Demo', 'correct')}>go</button>
      <button onClick={() => adopt('j2', 'Demo', 'transcribe')}>go2</button>
      <span data-testid="active">
        {Object.entries(phases.active).map(([b, a]) => `${b}:${a.phase}`).sort().join(',') || '-'}
      </span>
      <span data-testid="status">{jobs.map(j => j.status).join(',') || 'none'}</span>
    </div>
  )
}

describe('useActiveJob', () => {
  it('adoptiert, pollt und parst bis Terminal', async () => {
    vi.mocked(api.getJob)
      .mockResolvedValueOnce({ status: 'running', lines: ['→ Korrigiere A …'] })
      .mockResolvedValueOnce({ status: 'done', lines: ['apply: A -> edit.json + md (2 Segmente)'] })
    render(<JobProvider intervalMs={5}><Probe /></JobProvider>)
    fireEvent.click(screen.getByText('go'))
    await waitFor(() => expect(screen.getByTestId('active').textContent).toBe('A:correct'))
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('done'))
  })

  it('uebersteht einen transienten getJob-Fehler und laeuft weiter', async () => {
    vi.mocked(api.getJob)
      .mockRejectedValueOnce(new Error('net'))
      .mockResolvedValueOnce({ status: 'running', lines: ['→ Korrigiere A …'] })
      .mockResolvedValueOnce({ status: 'done', lines: ['apply: A -> edit.json + md (2 Segmente)'] })
    render(<JobProvider intervalMs={5}><Probe /></JobProvider>)
    fireEvent.click(screen.getByText('go'))
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('done'))
  })

  // Die drei folgenden Faelle haengen an EINER Ursache: `settled` und `failures` wurden als
  // Seiteneffekte IM setJobs-Updater berechnet. React ruft Updater in der Render-Phase — also
  // erst NACH der Zeile, die `settled` auswertet, und unter StrictMode zweimal.

  it('ruft die onSettled-Listener, wenn ein Job terminal wird', async () => {
    // Gemessen vor dem Fix: 0 Aufrufe. ProjectWorkspace haengt daran sein refresh() — der
    // Ausfall blieb nur deshalb unbemerkt, weil useProjects ohnehin alle 4s pollt.
    vi.mocked(api.getJob)
      .mockResolvedValueOnce({ status: 'running', lines: ['→ Korrigiere A …'] })
      .mockResolvedValue({ status: 'done', lines: ['apply: A -> edit.json + md (2 Segmente)'] })
    const settled = vi.fn()
    render(<JobProvider intervalMs={5}><Probe beiSettled={settled} /></JobProvider>)
    fireEvent.click(screen.getByText('go'))
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('done'))
    await waitFor(() => expect(settled).toHaveBeenCalled())
  })

  it('meldet die Phasen aus DEM Tick, in dem der Job terminal wird', async () => {
    // `jobs` im Closure ist eine Runde alt -- ohne die frischen Zeilen traegt das Ereignis
    // die vorletzte Phase eines gerade beendeten Laufs.
    const fertig = ['apply: A -> edit.json + md (2 Segmente)']
    vi.mocked(api.getJob)
      .mockResolvedValueOnce({ status: 'running', lines: ['→ Korrigiere A …'] })
      .mockResolvedValue({ status: 'done', lines: fertig })
    const settled = vi.fn()
    render(<JobProvider intervalMs={5}><Probe beiSettled={settled} /></JobProvider>)
    fireEvent.click(screen.getByText('go'))
    await waitFor(() => expect(settled).toHaveBeenCalled())
    const beendet = settled.mock.calls.at(-1)![0] as Job[]
    expect(beendet[0].phases).toEqual(parseJobPhases('correct', fertig))
  })

  it('meldet beim Aufgeben die zuletzt gelesenen Phasen, nicht die vom Adoptieren', async () => {
    // Netz weg -> nach dreimal aufgeben. `jobs` im Closure steht auf dem Stand des
    // Effekt-Aufsatzes, also auf den leeren Phasen von adopt() -- der Zuhoerer bekaeme
    // damit nichts, obwohl der erste Poll laengst etwas gelesen hatte.
    const zeilen = ['→ Korrigiere A …']
    vi.mocked(api.getJob)
      .mockResolvedValueOnce({ status: 'running', lines: zeilen })
      .mockRejectedValue(new Error('net'))
    const settled = vi.fn()
    render(<JobProvider intervalMs={5}><Probe beiSettled={settled} /></JobProvider>)
    fireEvent.click(screen.getByText('go'))
    await waitFor(() => expect(settled).toHaveBeenCalled())
    const beendet = settled.mock.calls.at(-1)![0] as Job[]
    expect(beendet[0].status).toBe('error')
    expect(beendet[0].phases).toEqual(parseJobPhases('correct', zeilen))
  })

  it('pollt nach dem Terminal-Status nicht weiter', async () => {
    // Der Grund fuer den CI-Flake: tick() plante bedingungslos neu, und nur das Aufraeumen des
    // Effekts kam dem zuvor — ein Wettlauf, den ein langsamer Runner verliert. Der Extra-Aufruf
    // traf dann einen erschoepften mockResolvedValueOnce -> undefined.then -> Unhandled Rejection.
    let n = 0
    vi.mocked(api.getJob).mockImplementation(async () => {
      n += 1
      return n === 1 ? { status: 'running', lines: ['→ Korrigiere A …'] }
                     : { status: 'done', lines: ['apply: A -> edit.json + md (2 Segmente)'] }
    })
    render(<JobProvider intervalMs={5}><Probe /></JobProvider>)
    fireEvent.click(screen.getByText('go'))
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('done'))
    const beiTerminal = n
    await new Promise(r => setTimeout(r, 60))            // 12x das Poll-Intervall
    expect(n).toBe(beiTerminal)
  })

  it('zaehlt Fehlschlaege einmal pro Runde, auch unter StrictMode', async () => {
    // StrictMode ruft Updater doppelt. Mit failures.current IM Updater zaehlte jede Runde
    // doppelt — aus "dreimal weg -> aufgeben" wuerde nach zwei Netzhaengern aufgegeben.
    vi.mocked(api.getJob)
      .mockRejectedValueOnce(new Error('net'))
      .mockRejectedValueOnce(new Error('net'))
      .mockResolvedValue({ status: 'running', lines: ['→ Korrigiere A …'] })
    render(<StrictMode><JobProvider intervalMs={5}><Probe /></JobProvider></StrictMode>)
    fireEvent.click(screen.getByText('go'))
    // Zwei Fehlschlaege duerfen den Job NICHT toeten — der dritte Versuch klappt.
    await waitFor(() => expect(screen.getByTestId('active').textContent).toBe('A:correct'))
    expect(screen.getByTestId('status').textContent).toBe('running')
  })

  it('verfolgt Transkription und Korrektur gleichzeitig und mergt ihre Phasen', async () => {
    vi.mocked(api.getJob).mockImplementation(async (id: string) =>
      id === 'j1'
        ? { status: 'running', lines: ['→ Korrigiere A …'] }
        : { status: 'running', lines: ['[Demo] -> transkribiere B …'] })
    render(<JobProvider intervalMs={5}><Probe /></JobProvider>)
    fireEvent.click(screen.getByText('go'))
    fireEvent.click(screen.getByText('go2'))
    await waitFor(() =>
      expect(screen.getByTestId('active').textContent).toBe('A:correct,B:transcribe'))
  })
})

describe('mergePhases', () => {
  const job = (id: string, kind: string, phases: JobPhases): Job =>
    ({ id, kind, project: 'P', status: 'running', phases })

  it('ein laufender Job verdraengt den Terminal-Status desselben Files aus einem anderen Job', () => {
    // Sonst maskiert das 'done' der Transkription die laufende Korrektur — FileStatusPill
    // prueft state VOR active und wuerde 'Fertig' zeigen, waehrend gerade korrigiert wird.
    const m = mergePhases([
      job('j1', 'transcribe', { global: null, active: {}, perBase: { A: 'done', B: 'done' } }),
      job('j2', 'correct', { global: null, active: { A: { phase: 'correct' } }, perBase: {} }),
    ])
    expect(m.active).toEqual({ A: { phase: 'correct' } })
    expect(m.perBase).toEqual({ B: 'done' })
    expect(m.global).toBeNull()
  })

  it('bei gleicher Datei in zwei Jobs gewinnt transcribe — unabhaengig von der Reihenfolge', () => {
    // Das Transkript wird gerade ersetzt, die Korrektur arbeitet auf gleich veralteten Daten.
    const t = job('j1', 'transcribe', { global: null, active: { A: { phase: 'transcribe', pct: 20 } }, perBase: {} })
    const c = job('j2', 'correct', { global: null, active: { A: { phase: 'correct' } }, perBase: {} })
    expect(mergePhases([t, c]).active.A).toEqual({ phase: 'transcribe', pct: 20 })
    expect(mergePhases([c, t]).active.A).toEqual({ phase: 'transcribe', pct: 20 })
  })

  it('kollidieren zwei TERMINALE Ausgaenge, gewinnt der schwerere — in BEIDEN Reihenfolgen (#377)', () => {
    // Hier stand ein `Object.assign`, also „der spaetere Job im Array gewinnt". Die
    // Reihenfolge ist aber nicht zufaellig, sondern systematisch die schlechte: `jobs.py`
    // sortiert `active_for` nach `kind` (correct vor transcribe), und ein Transkriptionslauf
    // druckt beim Start fuer JEDE bereits transkribierte Datei `skip (vorhanden)` -> 'skipped'.
    // Sein harmloses 'skipped' ueberschrieb damit jedes 'failed' des parallel laufenden
    // Korrekturlaufs — genau das Signal, das am wenigsten verschwinden darf.
    const c = job('j1', 'correct', { global: null, active: {}, perBase: { A: 'failed' } })
    const t = job('j2', 'transcribe', { global: null, active: {}, perBase: { A: 'skipped' } })
    expect(mergePhases([c, t]).perBase.A).toBe('failed')   // die echte Adoptionsreihenfolge
    expect(mergePhases([t, c]).perBase.A).toBe('failed')   // und die Gegenrichtung
  })

  it('zwischen done und skipped gewinnt done', () => {
    // Zweite Haelfte der Rangfolge, eigener Test: ein `RANG`, der NUR 'failed' heraushebt,
    // liesse den Rest weiter an der Reihenfolge haengen und bliebe oben gruen.
    const a = job('j1', 'correct', { global: null, active: {}, perBase: { A: 'done' } })
    const b = job('j2', 'transcribe', { global: null, active: {}, perBase: { A: 'skipped' } })
    expect(mergePhases([a, b]).perBase.A).toBe('done')
    expect(mergePhases([b, a]).perBase.A).toBe('done')
  })

  it('global gilt nur, solange keine Datei laeuft', () => {
    expect(mergePhases([job('j1', 'correct', { global: 'glossary', active: {}, perBase: {} })]).global)
      .toBe('glossary')
  })

  it('fuehrt Scopes aller laufenden Jobs zusammen', () => {
    const j1 = job('j1', 'correct', { global: null, scope: new Set(['A', 'B']), active: {}, perBase: {} })
    const j2 = job('j2', 'transcribe', { global: null, scope: new Set(['B', 'C']), active: {}, perBase: {} })
    expect(mergePhases([j1, j2]).scope).toEqual(new Set(['A', 'B', 'C']))
  })

  it('erhaelt globale Phase pro Scope bei parallelen Jobs (Korrektur im Glossar, Transkription aktiv)', () => {
    // Job 1: Korrektur fuer Datei A im Schritt "glossary"
    const c = job('j1', 'correct', { global: 'glossary', scope: new Set(['A']), active: {}, perBase: {} })
    // Job 2: Transkription fuer Datei B aktiv
    const t = job('j2', 'transcribe', { global: null, scope: new Set(['B']), active: { B: { phase: 'transcribe', pct: 40 } }, perBase: {} })
    const m = mergePhases([c, t])
    expect(m.active).toEqual({ B: { phase: 'transcribe', pct: 40 } })
    // Datei A erhaelt ihre globale Phase 'glossary' trotz aktiver Datei B im parallelen Job
    expect(m.globalPerBase?.A).toBe('glossary')
    expect(m.globalPerBase?.B).toBeUndefined()
    expect(m.global).toBeNull()
  })

  it('wartende Datei B ausserhalb des Glossar-Scopes erhaelt kein Glossar', () => {
    // Job 1: Korrektur fuer Datei A im Schritt "glossary"
    const c = job('j1', 'correct', { global: 'glossary', scope: new Set(['A']), active: {}, perBase: {} })
    // Job 2: Transkription fuer Datei B wartend (noch nicht aktiv)
    const t = job('j2', 'transcribe', { global: null, scope: new Set(['B']), active: {}, perBase: {} })
    const m = mergePhases([c, t])
    expect(m.scope).toEqual(new Set(['A', 'B']))
    expect(m.globalPerBase?.A).toBe('glossary')
    expect(m.globalPerBase?.B).toBeUndefined()
    expect(m.global).toBeNull()
  })

  it('Job ohne Scope (scope: undefined) gilt fuer alle Dateien und liefert global', () => {
    const fetchJob = job('j1', 'fetch', { global: 'download', scope: undefined, active: {}, perBase: {} })
    const m = mergePhases([fetchJob])
    expect(m.scope).toBeUndefined()
    expect(m.global).toBe('download')
  })

  it('Mischung aus Scoped und Unscoped Job laesst scope undefined', () => {
    const scopedJob = job('j1', 'correct', { global: 'glossary', scope: new Set(['A']), active: {}, perBase: {} })
    const unscopedJob = job('j2', 'fetch', { global: 'download', scope: undefined, active: {}, perBase: {} })
    const m = mergePhases([scopedJob, unscopedJob])
    expect(m.scope).toBeUndefined()
    expect(m.globalPerBase?.A).toBe('glossary')
    expect(m.global).toBe('download')
  })
})
