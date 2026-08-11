import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { createRef } from 'react'
import { Waveform, type WaveHandle } from './Waveform'

/** wavesurfer braucht echtes Audio und ein Canvas — beides gibt es in jsdom nicht. Die Attrappe
 *  liefert nur, was `steuerung` anfasst. Sie prueft die VERDRAHTUNG (Knopf -> Aktion), nicht
 *  wavesurfers Verhalten; dass `stop()` wirklich pausiert und auf 0 springt, bleibt Sichtpruefung.
 *  `vi.hoisted`, weil `vi.mock` ueber die Konstanten hochgezogen wird. */
const h = vi.hoisted(() => {
  const zustand = { isPlaying: false, isReady: true, zeit: 0 }
  return {
    zustand,
    ws: {
      play: vi.fn(() => Promise.resolve()),
      pause: vi.fn(),
      stop: vi.fn(),
      skip: vi.fn(),
      setOptions: vi.fn(),
      on: vi.fn(() => () => {}),
      getDuration: () => 60,
      getCurrentTime: () => zustand.zeit,
      isPlaying: () => zustand.isPlaying,
    },
  }
})

vi.mock('@wavesurfer/react', () => ({
  useWavesurfer: () => ({
    wavesurfer: h.ws, isPlaying: h.zustand.isPlaying,
    currentTime: h.zustand.zeit, isReady: h.zustand.isReady,
  }),
}))

const SEG = { id: 3, start: 0, end: 5, text: '', speaker: 'A' } as never

function zeigen() {
  const ref = createRef<WaveHandle>()
  render(<Waveform ref={ref} url="/audio/x.m4a" onTime={() => {}} />)
  return ref
}

describe('Waveform — Knoepfe unter der Welle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(h.zustand, { isPlaying: false, isReady: true, zeit: 0 })
  })

  it('Abspielen loest die Wiedergabe aus', () => {
    zeigen()
    fireEvent.click(screen.getByLabelText('Abspielen'))
    expect(h.ws.play).toHaveBeenCalled()
    expect(h.ws.pause).not.toHaveBeenCalled()
  })

  it('waehrend der Wiedergabe heisst derselbe Knopf Pause und pausiert', () => {
    h.zustand.isPlaying = true
    zeigen()
    fireEvent.click(screen.getByLabelText('Pause'))
    expect(h.ws.pause).toHaveBeenCalled()
    expect(h.ws.play).not.toHaveBeenCalled()
  })

  it('Stopp haelt an und loescht das gemerkte Fenster', () => {
    const ref = zeigen()
    act(() => ref.current!.playSegment(SEG))
    expect(h.ws.play).toHaveBeenCalledWith(0, 5.35)      // Fenster gesetzt (playWindow-Polster)

    fireEvent.click(screen.getByLabelText('Stopp'))
    expect(h.ws.stop).toHaveBeenCalled()

    // Der Beleg, dass das Fenster weg ist: nach dem Ruecksprung auf 0 laege die Zeit INNERHALB
    // des alten Fensters (0 <= 0 < 5.35). Bliebe es stehen, setzte der naechste Druck dessen
    // Endgrenze wieder scharf — die Wiedergabe stoppte bei 5,35 s statt durchzulaufen.
    h.ws.play.mockClear()
    fireEvent.click(screen.getByLabelText('Abspielen'))
    expect(h.ws.play).toHaveBeenCalledWith(undefined, undefined)
  })

  it('solange die Datei nicht dekodiert ist, sind beide Knoepfe gesperrt', () => {
    h.zustand.isReady = false
    zeigen()
    expect(screen.getByLabelText('Abspielen')).toBeDisabled()
    expect(screen.getByLabelText('Stopp')).toBeDisabled()
  })
})
