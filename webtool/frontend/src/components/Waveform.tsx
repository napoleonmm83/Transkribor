import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { useWavesurfer } from '@wavesurfer/react'
import { playWindow } from '@/lib/playback'
import { useTheme } from '@/components/ThemeProvider'
import type { Segment } from '@/lib/types'

export type WaveHandle = { playSegment: (s: Segment) => void; playTurn: (s: Segment[]) => void }

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

    useEffect(() => {
      if (!wavesurfer) return
      return wavesurfer.on('timeupdate', (t: number) => onTime(t))
    }, [wavesurfer, onTime])

    useEffect(() => { wavesurfer?.setOptions(colors(theme === 'dark')) }, [theme, wavesurfer])

    useImperativeHandle(ref, () => ({
      playSegment(s) {
        if (!wavesurfer) return
        const { from, to } = playWindow(s, wavesurfer.getDuration())
        wavesurfer.play(from, to)?.catch(() => {})
      },
      playTurn(segs) {
        if (!wavesurfer || !segs.length) return
        const dur = wavesurfer.getDuration()
        const from = playWindow(segs[0], dur).from
        const to = playWindow(segs[segs.length - 1], dur).to
        wavesurfer.play(from, to)?.catch(() => {})
      },
    }), [wavesurfer])

    return <div ref={container} />
  })
