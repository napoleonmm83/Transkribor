import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { useWavesurfer } from '@wavesurfer/react'
import { playWindow, naechsteAktion, skipZiel, type Fenster } from '@/lib/playback'
import { useTheme } from '@/components/ThemeProvider'
import type { Segment } from '@/lib/types'

export type WaveHandle = {
  playSegment: (s: Segment) => void
  playTurn: (s: Segment[]) => void
  /** Play/Pause. `seg` = das Segment unter dem Cursor, falls es eines gibt. */
  toggle: (seg?: Segment | null) => void
  skip: (sekunden: number) => void
}

// Wavesurfer malt auf Canvas und kann keine CSS-Variablen lesen — die Werte muessen hier
// stehen. Sie spiegeln die Tokens aus index.css: Neutralton fuer die ungespielte Welle,
// --primary fuer den Fortschritt. Bei einer Palettenaenderung mit anpassen.
const colors = (dark: boolean) => ({
  waveColor: dark ? '#3F3F46' : '#D4D4D8',        // zinc-700 / zinc-300
  progressColor: dark ? '#818CF8' : '#4F46E5',    // --primary hell/dunkel
})

export const Waveform = forwardRef<WaveHandle, { url: string; onTime: (t: number) => void }>(
  function Waveform({ url, onTime }, ref) {
    const container = useRef<HTMLDivElement>(null)
    const { theme } = useTheme()
    const { wavesurfer } = useWavesurfer({
      container, url, height: 72, barWidth: 2, barGap: 1,
      ...colors(theme === 'dark'),
    })

    // Das zuletzt angespielte Stueck. Muss hier liegen und nicht in wavesurfer: der loescht
    // seine eigene Endgrenze (stopAtPosition) im pause-Handler, ein blosses playPause() liefe
    // darum ueber das Segmentende hinaus.
    const fenster = useRef<Fenster | null>(null)
    useEffect(() => { fenster.current = null }, [url])   // andere Datei -> alte Grenze gilt nicht

    useEffect(() => {
      if (!wavesurfer) return
      return wavesurfer.on('timeupdate', (t: number) => onTime(t))
    }, [wavesurfer, onTime])

    useEffect(() => { wavesurfer?.setOptions(colors(theme === 'dark')) }, [theme, wavesurfer])

    useImperativeHandle(ref, () => ({
      playSegment(s) {
        if (!wavesurfer) return
        const { from, to } = playWindow(s, wavesurfer.getDuration())
        fenster.current = { from, to, segId: s.id }
        wavesurfer.play(from, to)?.catch(() => {})
      },
      playTurn(segs) {
        if (!wavesurfer || !segs.length) return
        const dur = wavesurfer.getDuration()
        const from = playWindow(segs[0], dur).from
        const to = playWindow(segs[segs.length - 1], dur).to
        fenster.current = { from, to, segId: null }
        wavesurfer.play(from, to)?.catch(() => {})
      },
      toggle(seg) {
        if (!wavesurfer) return
        const a = naechsteAktion({
          laeuft: wavesurfer.isPlaying(),
          fenster: fenster.current,
          zeit: wavesurfer.getCurrentTime(),
          segment: seg ?? null,
          dauer: wavesurfer.getDuration(),
        })
        if (a.art === 'pause') { wavesurfer.pause(); return }
        if (a.art === 'fenster') {
          fenster.current = { from: a.from, to: a.to, segId: a.segId }
          wavesurfer.play(a.from, a.to)?.catch(() => {})
          return
        }
        if (a.to == null) fenster.current = null
        // Kein Startwert: die Position bleibt stehen, nur die Grenze wird neu gesetzt.
        wavesurfer.play(undefined, a.to)?.catch(() => {})
      },
      skip(sekunden) {
        if (!wavesurfer) return
        // setTime loescht stopAtPosition — hier erwuenscht: wer vorspult, will ueber das
        // Segmentende hinaus hoeren. Das Ref bleibt stehen, naechsteAktion verwirft es dann.
        wavesurfer.setTime(skipZiel(wavesurfer.getCurrentTime(), sekunden, wavesurfer.getDuration()))
      },
    }), [wavesurfer])

    return <div ref={container} />
  })
