import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { HoerBalken, ersteStelle } from './HoerBalken'

vi.mock('@/components/Waveform', () => ({
  Waveform: ({ url }: { url: string }) => <div data-testid="welle" data-url={url} />,
}))

const datei = (name: string) => new File(['x'], name, { type: 'audio/mpeg' })

describe('HoerBalken', () => {
  let erzeugt: string[]; let freigegeben: string[]
  beforeEach(() => {
    erzeugt = []; freigegeben = []
    let n = 0
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => { const u = `blob:${++n}`; erzeugt.push(u); return u },
      revokeObjectURL: (u: string) => { freigegeben.push(u) },
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('zeigt nichts, solange keine Datei klingt', () => {
    const { container } = render(<HoerBalken datei={null} anzeige="" onSchliessen={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('gibt die alte Blob-URL frei, wenn eine andere Datei klingt', () => {
    /* Wavesurfer dekodiert die GANZE Datei — gemessen 1595 ms und 659 MB Puffer fuer 30
       Minuten (Spec 7). Zehn Interviews waeren zehn Dekodierungen: es klingt deshalb nie
       mehr als eine, und die vorige wird freigegeben. */
    const { rerender } = render(
      <HoerBalken datei={datei('a.mp3')} anzeige="a.mp3" onSchliessen={() => {}} />)
    rerender(<HoerBalken datei={datei('b.mp3')} anzeige="b.mp3" onSchliessen={() => {}} />)
    expect(freigegeben).toEqual([erzeugt[0]])
    expect(screen.getByTestId('welle')).toHaveAttribute('data-url', erzeugt[1])
  })

  it('gibt die Blob-URL frei, wenn der Balken verschwindet', () => {
    /* Das ist der Ausgang, den die Spec zuerst vergessen hatte: Dialog geschlossen,
       Schrittwechsel, Projektwechsel — und der Fall, dass die klingende Zeile nach einem
       Teil-Fehlschlag aus der Liste faellt. Alle enden hier. */
    const { rerender } = render(
      <HoerBalken datei={datei('a.mp3')} anzeige="a.mp3" onSchliessen={() => {}} />)
    rerender(<HoerBalken datei={null} anzeige="" onSchliessen={() => {}} />)
    expect(freigegeben).toEqual([erzeugt[0]])
  })

  it('nennt den Marker „erstes Geraeusch", nicht „erste Sprache"', () => {
    /* Ein Pegelschwellwert findet Geraeusch. Applaus, Wind und eine zuschlagende Autotuer
       setzen ihn genauso — die Beschriftung darf nicht mehr behaupten als die Messung. */
    render(<HoerBalken datei={datei('a.mp3')} anzeige="a.mp3" onSchliessen={() => {}} />)
    expect(screen.getByText(/erstes Geräusch/i)).toBeInTheDocument()
    expect(screen.queryByText(/erste Sprache/i)).not.toBeInTheDocument()
  })

  it('nennt die Aufnahme beim Namen und laesst sie schliessen', () => {
    const onSchliessen = vi.fn()
    render(<HoerBalken datei={datei('a.mp3')} anzeige="a.mp3" onSchliessen={onSchliessen} />)
    expect(screen.getByText('a.mp3')).toBeInTheDocument()
    screen.getByRole('button', { name: /Reinhören beenden/i }).click()
    expect(onSchliessen).toHaveBeenCalled()
  })
})

describe('ersteStelle', () => {
  it('findet die erste Stelle ueber der Pegelschwelle, mit Vorlauf', () => {
    /* Der eigentliche Zweck des Balkens: bei Aufnahmen mit langer Stille am Anfang soll
       Play nicht bei 0:00 einsetzen. Reine Funktion, damit sie ohne Audio pruefbar ist. */
    const peaks = new Float32Array([0.002, 0.003, 0.002, 0.9, 0.8, 0.7])
    expect(ersteStelle(peaks, 60)).toBeCloseTo(60 * 3 / 6 - 0.25, 2)
  })

  it('bleibt bei 0, wenn durchgehend gesprochen wird', () => {
    expect(ersteStelle(new Float32Array([0.8, 0.9, 0.85]), 30)).toBe(0)
  })

  it('bleibt bei 0, wenn die Datei stumm ist — statt ans Ende zu springen', () => {
    /* Ohne diesen Zweig setzte die Schleife nie und `erste` bliebe auf einem Initialwert,
       den niemand geprueft hat. Eine stumme Datei ist selten, aber sie ist der Fall, in dem
       eine Sprunghilfe am meisten Schaden anrichten koennte. */
    expect(ersteStelle(new Float32Array([0, 0, 0]), 30)).toBe(0)
  })
})
