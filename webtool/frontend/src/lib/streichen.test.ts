import { describe, it, expect, vi, beforeEach } from 'vitest'
import { gestrichen, streichungenVergessen } from './streichen'

type Opts = {
  duration: number
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

  it('steht 10 Sekunden und traegt den Rueckgaengig-Knopf', () => {
    // Beides sind Entscheidungen, keine Vorgaben: sonners Default sind 4 s, und die reichen zum
    // Lesen, nicht zum Entscheiden — das hier ist eine Datenrettung. Gefahrlos wurde die
    // laengere Standzeit erst dadurch, dass der Rueckweg beim Dokumentwechsel entwertet wird;
    // wer sie anfasst, soll den Zusammenhang sehen statt eine Zahl zu drehen.
    const zurueck = vi.fn()
    gestrichen('Anmerkung', 'egal', zurueck)
    expect(optsVon(0)).toMatchObject({ duration: 10_000, action: { label: 'Rückgängig' } })
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

  it('raeumt den Toast auch weg, wenn der Rueckweg GEKLICKT wurde', () => {
    // Der Normalfall dieses Toasts — und der einzige Weg hinaus, den sonner weder ueber
    // `onDismiss` noch ueber `onAutoClose` meldet: `dist/index.mjs:882` ruft `action.onClick`
    // und danach `deleteToast()`, sonst nichts. Ohne das Aufraeumen im Rueckruf selbst waere
    // ausgerechnet der haeufigste Fall der einzige, der die Liste wachsen laesst.
    const zurueck = vi.fn()
    gestrichen('Anmerkung', 'geklickt', zurueck)
    optsVon(0).action.onClick()
    expect(zurueck).toHaveBeenCalledTimes(1)

    streichungenVergessen()
    expect(toastMock.dismiss).not.toHaveBeenCalled()
  })

  it('raeumt auch einen von Hand weggewischten Toast von der Liste', () => {
    gestrichen('Anmerkung', 'weggewischt', () => {})
    optsVon(0).onDismiss()
    streichungenVergessen()
    expect(toastMock.dismiss).not.toHaveBeenCalled()
  })
})
