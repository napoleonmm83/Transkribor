import { describe, it, expect, vi, beforeEach } from 'vitest'
import { gestrichen, streichungenVergessen } from './streichen'

type Opts = {
  action: { label: string; onClick: () => void }
  onAutoClose: () => void
  onDismiss: () => void
}

const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { dismiss: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMock }))

let nr = 0
beforeEach(() => {
  vi.clearAllMocks()
  toastMock.mockImplementation(() => ++nr)
  streichungenVergessen()   // Modulzustand aus dem vorigen Test raeumen
  toastMock.dismiss.mockClear()
})

const optsVon = (i: number) => toastMock.mock.calls[i][1] as Opts

describe('gestrichen', () => {
  it('nennt den gestrichenen Text und kuerzt ihn auf 40 Zeichen', () => {
    gestrichen('Anmerkung', 'kurz', () => {})
    gestrichen('Anmerkung', 'x'.repeat(60), () => {})
    expect(toastMock.mock.calls[0][0]).toBe('Anmerkung „kurz“ gestrichen')
    expect(toastMock.mock.calls[1][0]).toBe(`Anmerkung „${'x'.repeat(40)}…“ gestrichen`)
  })

  it('faellt ohne Inhalt auf die blosse Gattung zurueck', () => {
    // Kann heute kein Aufrufer ausloesen (beide streichen nur nicht-leere Werte), waere aber
    // sonst ein Toast mit einem leeren Anfuehrungspaar.
    gestrichen('Notiz', '   ', () => {})
    expect(toastMock.mock.calls[0][0]).toBe('Notiz gestrichen')
  })
})

describe('streichungenVergessen', () => {
  it('nimmt alle offenen Rueckwege weg', () => {
    gestrichen('Anmerkung', 'eins', () => {})
    gestrichen('Notiz', 'zwei', () => {})
    streichungenVergessen()
    expect(toastMock.dismiss).toHaveBeenCalledTimes(2)
  })

  it('fasst einen bereits geschlossenen Toast nicht mehr an', () => {
    // Sonst waechst die Liste mit JEDER Streichung weiter (der Nutzer wechselt beim Arbeiten an
    // einem langen Transkript stundenlang nicht die Datei), und beim naechsten Wechsel gingen
    // lauter `dismiss` an Kennungen, die es nicht mehr gibt. Gefunden vom CodeRabbit-Bot.
    gestrichen('Anmerkung', 'abgelaufen', () => {})
    gestrichen('Anmerkung', 'noch offen', () => {})
    optsVon(0).onAutoClose()           // der erste laeuft von selbst ab

    streichungenVergessen()
    expect(toastMock.dismiss).toHaveBeenCalledTimes(1)
    expect(toastMock.dismiss).toHaveBeenCalledWith(toastMock.mock.results[1].value)
  })

  it('raeumt auch einen von Hand weggewischten Toast von der Liste', () => {
    gestrichen('Anmerkung', 'weggewischt', () => {})
    optsVon(0).onDismiss()
    streichungenVergessen()
    expect(toastMock.dismiss).not.toHaveBeenCalled()
  })
})
