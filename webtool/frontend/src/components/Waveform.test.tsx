import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
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
    options: vi.fn(),
    getWaveform: vi.fn(),
    listeners: new Map<string, (...args: never[]) => void>(),
    ws: {
      play: vi.fn(() => Promise.resolve()),
      load: vi.fn((_url: string, _peaks?: number[][], _duration?: number) => Promise.resolve()),
      getMediaElement: () => ({ preload: '' }),
      pause: vi.fn(),
      stop: vi.fn(),
      skip: vi.fn(),
      setOptions: vi.fn(),
      on: vi.fn((event: string, callback: (...args: never[]) => void) => {
        h.listeners.set(event, callback)
        return () => { h.listeners.delete(event) }
      }),
      exportPeaks: () => [[0, 0.9]],
      getDuration: () => 60,
      getCurrentTime: () => zustand.zeit,
      isPlaying: () => zustand.isPlaying,
    },
  }
})

vi.mock('@wavesurfer/react', () => ({
  useWavesurfer: (options: unknown) => { h.options(options); return ({
    wavesurfer: h.ws, isPlaying: h.zustand.isPlaying,
    currentTime: h.zustand.zeit, isReady: h.zustand.isReady,
  }) },
}))

vi.mock('@/lib/api', () => ({ getWaveform: h.getWaveform }))

const SEG = { id: 3, start: 0, end: 5, text: '', speaker: 'A' } as never

function zeigen() {
  const ref = createRef<WaveHandle>()
  render(<Waveform ref={ref} url="blob:preview" onTime={() => {}} />)
  return ref
}

describe('Waveform — Knoepfe unter der Welle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.ws.load.mockImplementation(() => Promise.resolve())
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

const storedUrl = '/api/projects/Demo/audio/Clip'
const envelope = { peaks: [[0, 0.8, 0.2]], duration: 8764.248 }

describe('Waveform bounded stored recordings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.listeners.clear()
    Object.assign(h.zustand, { isPlaying: false, isReady: true, zeit: 0 })
    h.getWaveform.mockResolvedValue(envelope)
  })

  it('never starts a stored URL before peaks arrive and reports supplied duration', async () => {
    let resolve!: (value: typeof envelope) => void
    h.getWaveform.mockReturnValue(new Promise(r => { resolve = r }))
    const onBereit = vi.fn()
    render(<Waveform url={storedUrl} onTime={() => {}} onBereit={onBereit} />)
    expect(screen.getByRole('status')).toHaveTextContent('Wellenform')
    expect(h.options).not.toHaveBeenCalled()
    await act(async () => resolve(envelope))
    expect(h.options).toHaveBeenLastCalledWith(expect.objectContaining({ backend: 'MediaElement' }))
    expect(h.options.mock.calls.every(([options]) => !options.url && !options.peaks)).toBe(true)
    expect(h.ws.load).toHaveBeenCalledWith(storedUrl, envelope.peaks, envelope.duration)
    act(() => h.listeners.get('ready')?.(8764.248 as never))
    expect(onBereit).toHaveBeenCalledWith(new Float32Array(envelope.peaks[0]), envelope.duration)
  })

  it('aborts old URL requests and never mounts late old peaks', async () => {
    let resolve!: (value: typeof envelope) => void
    h.getWaveform.mockReturnValueOnce(new Promise(r => { resolve = r }))
    const { rerender } = render(<Waveform url={storedUrl} onTime={() => {}} />)
    const signal = h.getWaveform.mock.calls[0][1] as AbortSignal
    rerender(<Waveform url={`${storedUrl}2`} onTime={() => {}} />)
    expect(signal.aborted).toBe(true)
    await waitFor(() => expect(h.options).toHaveBeenCalled())
    await act(async () => resolve(envelope))
    expect(h.ws.load.mock.calls.every(([url]) => url === `${storedUrl}2`)).toBe(true)
  })

  it('keeps decode disabled on waveform request failure', async () => {
    h.getWaveform.mockRejectedValue(new Error('kein Audio'))
    render(<Waveform url={storedUrl} onTime={() => {}} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('kein Audio')
    expect(h.options).not.toHaveBeenCalled()
  })

  it('preserves local blob preview with onBereit', () => {
    const onBereit = vi.fn()
    render(<Waveform url="blob:preview" onTime={() => {}} onBereit={onBereit} />)
    expect(h.getWaveform).not.toHaveBeenCalled()
    act(() => h.listeners.get('ready')?.(60 as never))
    expect(onBereit).toHaveBeenCalledWith(new Float32Array([0, 0.9]), 60)
  })

  it('subscribes before a fast precomputed load emits ready', async () => {
    const onBereit = vi.fn()
    h.ws.load.mockImplementation(() => {
      h.listeners.get('ready')?.(8764.248 as never)
      return Promise.resolve()
    })
    render(<Waveform url={storedUrl} onTime={() => {}} onBereit={onBereit} />)
    await waitFor(() => expect(onBereit).toHaveBeenCalledWith(
      new Float32Array(envelope.peaks[0]), envelope.duration,
    ))
  })

  it('shows a media load failure', async () => {
    render(<Waveform url={storedUrl} onTime={() => {}} />)
    await waitFor(() => expect(h.options).toHaveBeenCalled())
    expect(h.listeners.has('error')).toBe(true)
    act(() => h.listeners.get('error')!(new Error('Audio fehlt') as never))
    expect(screen.getByRole('alert')).toHaveTextContent('Audio fehlt')
    expect(screen.getByLabelText('Abspielen')).toBeDisabled()
    expect(screen.getByLabelText('Stopp')).toBeDisabled()
  })
  it.each([
    ['Error', new Error('')],
    ['MediaError', { code: 3, message: '' }],
  ])('shows empty media error as an alert and disables controls: %s', async (_kind, error) => {
    render(<Waveform url={storedUrl} onTime={() => {}} />)
    await waitFor(() => expect(h.options).toHaveBeenCalled())
    expect(h.listeners.has('error')).toBe(true)
    act(() => h.listeners.get('error')!(error as never))
    expect(screen.getByRole('alert')).toHaveTextContent('Keine weiteren Angaben')
    expect(screen.getByLabelText('Abspielen')).toBeDisabled()
    expect(screen.getByLabelText('Stopp')).toBeDisabled()
  })

  it('preserves a nonempty MediaError diagnostic', async () => {
    render(<Waveform url={storedUrl} onTime={() => {}} />)
    await waitFor(() => expect(h.options).toHaveBeenCalled())
    expect(h.listeners.has('error')).toBe(true)
    act(() => h.listeners.get('error')!({ code: 3, message: 'Decoderdiagnose' } as never))
    expect(screen.getByRole('alert')).toHaveTextContent('Decoderdiagnose')
    expect(screen.getByLabelText('Abspielen')).toBeDisabled()
    expect(screen.getByLabelText('Stopp')).toBeDisabled()
  })

})
