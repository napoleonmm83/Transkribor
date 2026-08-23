import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { JobProvider, useActiveJob } from './useActiveJob'
import { useJobAusgang } from './useJobAusgang'
import * as api from '@/lib/api'

vi.mock('@/lib/api')
const toastMock = vi.hoisted(() => Object.assign(vi.fn(),
  { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), dismiss: vi.fn(), loading: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMock, Toaster: () => null }))

function Probe() {
  useJobAusgang()
  const { adopt } = useActiveJob()
  ;(globalThis as unknown as { __adopt: typeof adopt }).__adopt = adopt
  return null
}

function zeigen() {
  render(<JobProvider intervalMs={10}><Probe /></JobProvider>)
  return (globalThis as unknown as { __adopt: (i: string, p: string, k: string) => void }).__adopt
}

/** Einen Job adoptieren und den Provider bis zum Terminalwerden laufen lassen. */
async function laufen(kind = 'correct') {
  const adopt = zeigen()
  await act(async () => { adopt('j1', 'Alpha', kind) })
  await act(async () => { await new Promise(r => setTimeout(r, 40)) })
}

describe('useJobAusgang (#376)', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('ein sauberer Lauf meldet Erfolg', async () => {
    vi.mocked(api.getJob).mockResolvedValue({ status: 'done', kind: 'correct',
      lines: ['apply: A -> edit.json'] })
    await laufen()
    expect(toastMock.success).toHaveBeenCalledTimes(1)
    expect(toastMock.success.mock.calls[0][0]).toContain('Alpha')
    expect(toastMock.warning).not.toHaveBeenCalled()
    expect(toastMock.error).not.toHaveBeenCalled()
  })

  it('ein TEILfehlschlag meldet NICHT „fertig" — und nennt die Datei', async () => {
    // Der Kern von #376. `correct.py:1064` wirft nur, wenn KEINE Datei gelang; eine von zweien
    // gescheitert heisst Exitcode 0 und damit Job-Status `done`. Vorher lief genau das als
    // „Korrigieren fertig" durch, und weil die Etiketten am laufenden Job haengen, verschwand
    // das rote „Fehler" in derselben Sekunde: wer nicht zusah, erfuhr es nie.
    vi.mocked(api.getJob).mockResolvedValue({ status: 'done', kind: 'correct',
      lines: ['apply: A -> edit.json', '✗ Fehler bei B: LLM-Ausgabe ungueltig'] })
    await laufen()
    expect(toastMock.success).not.toHaveBeenCalled()
    expect(toastMock.warning).toHaveBeenCalledTimes(1)
    const [text, opts] = toastMock.warning.mock.calls[0]
    expect(text).toContain('1 von 2')
    // WELCHE Datei — das ist die Frage, die die alten Rohzeilen nicht beantwortet haben.
    expect(opts?.description).toBe('B')
  })

  it('der Nenner zaehlt nur die VERSUCHTEN, nicht die uebersprungenen (#376/B7)', async () => {
    // Ein Lauf ueber ein gewachsenes Projekt druckt fuer jede schon fertige Datei
    // `skip (vorhanden)`. Zaehlte der Nenner die mit, hiesse es „1 von 4 fehlgeschlagen"
    // — und der Nutzer sucht drei Aufnahmen, die nie angefasst wurden.
    vi.mocked(api.getJob).mockResolvedValue({ status: 'done', kind: 'transcribe',
      lines: ['[P] skip (vorhanden): alt1', '[P] skip (vorhanden): alt2',
              '[P] fertig neu1: 10 Segmente', '[P] FEHLER neu2: kaputt'] })
    await laufen('transcribe')
    expect(toastMock.warning.mock.calls[0][0]).toContain('1 von 2')
  })

  it('ein URL-Import mit toten Videos meldet NICHT „fertig" (#376/B1)', async () => {
    // Der Import kennt keine Basisnamen (die Datei entsteht erst beim Laden), also gibt es
    // nie einen perBase-Eintrag — und `fetch.py:576` wirft nur, wenn GAR nichts geladen
    // wurde. Ohne die Bilanzzeile meldete dieser Lauf glatten Erfolg. Der Fehlschlag war
    // vorher unsichtbar; ihn als Erfolg zu BEHAUPTEN waere schlimmer.
    vi.mocked(api.getJob).mockResolvedValue({ status: 'done', kind: 'fetch',
      lines: ['[fetch] FEHLER https://x/1: Video nicht verfuegbar', '[fetch] 3 von 5 geladen'] })
    await laufen('fetch')
    expect(toastMock.success).not.toHaveBeenCalled()
    expect(toastMock.warning.mock.calls[0][0]).toContain('3 von 5 geladen')
  })

  it('ein vollstaendiger URL-Import meldet Erfolg', async () => {
    // Gegenrichtung: eine Bilanz ALLEIN darf nicht warnen, sonst ist jeder Import verdaechtig.
    vi.mocked(api.getJob).mockResolvedValue({ status: 'done', kind: 'fetch',
      lines: ['[fetch] 5 von 5 geladen'] })
    await laufen('fetch')
    expect(toastMock.warning).not.toHaveBeenCalled()
    expect(toastMock.success).toHaveBeenCalledTimes(1)
  })

  it('ohne Dateinamen wird der GRUND nachgereicht (#376/B2)', async () => {
    // Stirbt ein Lauf vor der ersten Datei, lautet die Frage nicht „welche?", sondern
    // „warum?" — und darauf antworten nur die Log-Zeilen. `useJob` zeigte dafuer die letzten
    // drei; mit dem Umzug hierher waere das ersatzlos entfallen, und weil die Zeilen mit dem
    // Job sterben (#371), stuende der Grund danach nirgends mehr.
    vi.mocked(api.getJob).mockResolvedValue({ status: 'error', kind: 'correct',
      lines: ['prep: 3 Datei(en)', 'run: FEHLER — 0 von 3 versuchten Datei(en) korrigiert'] })
    await laufen()
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })
    const letzter = toastMock.error.mock.calls.at(-1)
    expect(letzter?.[1]?.description).toContain('run: FEHLER')
  })

  it('ein ganz gescheiterter Lauf meldet einen Fehler', async () => {
    vi.mocked(api.getJob).mockResolvedValue({ status: 'error', kind: 'transcribe', lines: [] })
    await laufen('transcribe')
    expect(toastMock.error).toHaveBeenCalledTimes(1)
    expect(toastMock.error.mock.calls[0][0]).toContain('Alpha')
    expect(toastMock.success).not.toHaveBeenCalled()
  })

  it('ein Abbruch ist kein Fehler', async () => {
    // Eine Entscheidung des Nutzers darf nicht wie ein Unfall klingen — derselbe Wortlaut wie
    // in useOsFortschritt, damit dieselbe Sache nicht zwei Namen hat.
    vi.mocked(api.getJob).mockResolvedValue({ status: 'cancelled', kind: 'correct', lines: [] })
    await laufen()
    expect(toastMock.error).not.toHaveBeenCalled()
    expect(toastMock.warning).toHaveBeenCalledTimes(1)
    expect(toastMock.warning.mock.calls[0][0]).toContain('abgebrochen')
  })

  it('die Ellipse aus KIND_LABEL steht nicht im Ausgang', async () => {
    // `KIND_LABEL` ist als LAUFENDE Beschriftung gebaut ("Korrigieren…"); ungekuerzt ergaebe
    // das "Korrigieren… fertig", einen halben Satz. Kleiner Wachposten, aber er faellt sonst
    // beim naechsten Label-Umbau lautlos wieder auf.
    vi.mocked(api.getJob).mockResolvedValue({ status: 'done', kind: 'correct', lines: [] })
    await laufen()
    expect(toastMock.success.mock.calls[0][0]).not.toContain('…')
  })
})
