import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { HoerBalken, ersteStelle } from './HoerBalken'

// Die Attrappe ruft `onBereit` bei JEDEM Render und reicht `springeZu` durch — sonst waere
// die Sprung-Wache (`gesprungen.current`) ungedeckt: mit einer stummen Attrappe bleibt die
// Mutation „Wache raus" gruen, weil `onBereit` nie faellt (Reviewbefund W4).
const springeZu = vi.hoisted(() => vi.fn())
vi.mock('@/components/Waveform', () => ({
  Waveform: (() => {
    const { forwardRef, useEffect, useImperativeHandle } = require('react')
    return forwardRef(function Welle({ url, onBereit }: any, ref: any) {
      useImperativeHandle(ref, () => ({ springeZu }))
      useEffect(() => { onBereit?.(new Float32Array([0.001, 0.002, 0.9, 0.8]), 40) })
      return <div data-testid="welle" data-url={url} />
    })
  })(),
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

  it('springt EINMAL je Datei, nicht bei jedem Render', () => {
    /* Sonst kaeme man nach einem bewussten Klick an den Anfang nie wieder dorthin zurueck:
       jeder Tastendruck in einem Sprecherfeld rendert den Dialog — und damit den Balken —
       neu, und der Abspieler spraenge jedes Mal zurueck an die Geraeuschstelle. */
    springeZu.mockClear()
    // DIESELBE Datei ueber alle Renders — ein neues File-Objekt je Render waere eine neue
    // Blob-URL und damit ein anderer Fall (der ist der Dateiwechsel, eine Zeile tiefer).
    const d = datei('a.mp3')
    const { rerender } = render(
      <HoerBalken datei={d} anzeige="a.mp3" onSchliessen={() => {}} />)
    rerender(<HoerBalken datei={d} anzeige="a.mp3" onSchliessen={() => {}} />)
    rerender(<HoerBalken datei={d} anzeige="a.mp3" onSchliessen={() => {}} />)
    expect(springeZu).toHaveBeenCalledTimes(1)
    expect(springeZu).toHaveBeenCalledWith(expect.closeTo(40 * 2 / 4 - 0.25, 2))
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

  it('zaehlt eine NEGATIVE Spitze als laut', () => {
    /* `exportPeaks` behaelt das Vorzeichen: wavesurfer nimmt je Fenster das Sample mit dem
       groessten BETRAG und pusht es unveraendert (wavesurfer.js:441, nachgelesen). Ohne
       `Math.abs` laese diese Funktion rund die Haelfte aller lauten Fenster als Stille —
       hier: sie spraenge auf 19,75 statt auf 9,75. */
    expect(ersteStelle(new Float32Array([0.002, -0.9, 0.8]), 30)).toBeCloseTo(9.75, 2)
  })

  it('bleibt bei 0, wenn die Datei stumm ist — statt ans Ende zu springen', () => {
    /* Ohne diesen Zweig setzte die Schleife nie und `erste` bliebe auf einem Initialwert,
       den niemand geprueft hat. Eine stumme Datei ist selten, aber sie ist der Fall, in dem
       eine Sprunghilfe am meisten Schaden anrichten koennte. */
    expect(ersteStelle(new Float32Array([0, 0, 0]), 30)).toBe(0)
  })
})
