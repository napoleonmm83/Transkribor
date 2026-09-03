import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FehlerberichteFrage } from './FehlerberichteFrage'
import type { FehlerberichteZustand } from '@/hooks/useFehlerberichte'

const toastMock = vi.hoisted(() => Object.assign(vi.fn(),
  { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), dismiss: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMock }))

const FRAGE = 'Darf Transkribor Fehler automatisch an uns senden?'
const NIE_GEFRAGT: FehlerberichteZustand = { automatisch: false, gefragt: null }
const SCHON_GEFRAGT: FehlerberichteZustand = { automatisch: false, gefragt: '2026-09-03T00:00:00Z' }

type Schalter = { status: ReturnType<typeof vi.fn>; setzen: ReturnType<typeof vi.fn> }

/** Muster wie in useFehlerberichte.test.tsx — es gibt keinen geteilten Helfer fuer die Bruecke.
 *  `mitSchalter: false` ist die aeltere App-Huelle: Bruecke da, dieser Kanal nicht. */
function bruecke(start: FehlerberichteZustand | Promise<FehlerberichteZustand>, mitSchalter = true) {
  const fehlerberichte: Schalter = {
    status: vi.fn().mockReturnValue(Promise.resolve(start)),
    setzen: vi.fn((an: boolean) => Promise.resolve({ automatisch: an, gefragt: 'jetzt' })),
  }
  ;(window as unknown as { transkribor: unknown }).transkribor =
    mitSchalter ? { fehlerberichte } : { update: { status: vi.fn() } }
  return { fehlerberichte }
}

/** Rendern und den Rundlauf zum Hauptprozess abwarten — sonst steht `zustand` noch auf null. */
async function zeigen(start: FehlerberichteZustand, mitSchalter = true) {
  const api = bruecke(start, mitSchalter)
  await act(async () => { render(<FehlerberichteFrage />) })
  return api
}

describe('FehlerberichteFrage', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => { delete (window as unknown as { transkribor?: unknown }).transkribor })

  it('fragt, solange der Hauptprozess gefragt: null meldet', async () => {
    await zeigen(NIE_GEFRAGT)
    expect(screen.getByText(FRAGE)).toBeTruthy()
  })

  it('fragt nicht mehr, sobald eine Antwort in der Datei steht', async () => {
    await zeigen(SCHON_GEFRAGT)
    expect(screen.queryByText(FRAGE)).toBeNull()
  })

  it('fragt im Browser gar nicht — dort gibt es keine Bruecke und keinen Schalter', async () => {
    await zeigen(NIE_GEFRAGT, false)
    expect(screen.queryByText(FRAGE)).toBeNull()
  })

  it('wartet auf die Antwort des Hauptprozesses, statt beim Start aufzublitzen', async () => {
    // Der Zustand haengt noch in der Luft: `zustand === null` ist NICHT dasselbe wie
    // `gefragt === null`. Ohne diese Unterscheidung stuende der Dialog eine Runde lang da und
    // verschwaende wieder, sobald die Antwort kommt.
    let aufloesen: (z: FehlerberichteZustand) => void = () => {}
    bruecke(new Promise<FehlerberichteZustand>(r => { aufloesen = r }))
    render(<FehlerberichteFrage />)
    expect(screen.queryByText(FRAGE)).toBeNull()
    await act(async () => { aufloesen(NIE_GEFRAGT) })
    expect(screen.getByText(FRAGE)).toBeTruthy()
  })

  it('Ja schaltet an und schliesst', async () => {
    const api = await zeigen(NIE_GEFRAGT)
    await act(async () => { screen.getByRole('button', { name: 'Ja, automatisch senden' }).click() })
    expect(api.fehlerberichte.setzen).toHaveBeenCalledWith(true)
    await waitFor(() => expect(screen.queryByText(FRAGE)).toBeNull())
  })

  it('Nein schreibt die Ablehnung — und schreibt sie genau einmal', async () => {
    // Der Knopf ist ein AlertDialogCancel: Radix schliesst selbst, und das Schliessen ist der
    // EINE Weg, auf dem die Ablehnung geschrieben wird. Wuerde er zusaetzlich selbst schreiben,
    // stuenden hier zwei Aufrufe.
    const api = await zeigen(NIE_GEFRAGT)
    await act(async () => { screen.getByRole('button', { name: 'Nein' }).click() })
    expect(api.fehlerberichte.setzen.mock.calls).toEqual([[false]])
    await waitFor(() => expect(screen.queryByText(FRAGE)).toBeNull())
  })

  it('Escape heisst Nein — wie das cancelId des alten Systemfensters', async () => {
    const api = await zeigen(NIE_GEFRAGT)
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(api.fehlerberichte.setzen).toHaveBeenCalledWith(false)
  })

  it('Ja schreibt kein Nein hinterher, solange der Hauptprozess noch antwortet', async () => {
    // Das haengende Versprechen ist der Kern des Tests, nicht Beiwerk: antwortet die Attrappe
    // sofort, setzt `useFehlerberichte` selbst `gefragt` und der Dialog geht ohnehin zu — die
    // Luecke, um die es geht, gibt es dann gar nicht, und der Test bleibt auch OHNE den Riegel
    // gruen (gemessen in der Mutationsprobe: `setBeantwortet(true)` entfernt, Test blieb gruen).
    // Mit haengender Antwort steht der Dialog wie im Ernstfall waehrend des ipc-Rundlaufs, und
    // ein Escape darin schriebe ohne Riegel ein Nein ueber das eben gegebene Ja.
    const api = await zeigen(NIE_GEFRAGT)
    api.fehlerberichte.setzen.mockReturnValueOnce(new Promise(() => {}))
    await act(async () => { screen.getByRole('button', { name: 'Ja, automatisch senden' }).click() })
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(api.fehlerberichte.setzen.mock.calls).toEqual([[true]])
  })

  it('sagt es, wenn die Antwort nicht gespeichert werden konnte', async () => {
    const api = await zeigen(NIE_GEFRAGT)
    api.fehlerberichte.setzen.mockRejectedValueOnce(new Error('Platte voll'))
    await act(async () => { screen.getByRole('button', { name: 'Ja, automatisch senden' }).click() })
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled())
    expect(String(toastMock.error.mock.calls[0][0])).toContain('nächsten Start')
  })
})
