import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { useWavesurfer } from '@wavesurfer/react'
import { playWindow } from '@/lib/playback'
import { useTheme } from '@/components/ThemeProvider'
import type { Segment } from '@/lib/types'

export type WaveHandle = { playSegment: (s: Segment) => void; playTurn: (s: Segment[]) => void }

const colors = (dark: boolean) => ({
  waveColor: dark ? '#3f4657' : '#b9c6d6',
  progressColor: dark ? '#7b86f0' : '#4f5bd3',
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
        wavesurfer.play(from, to)
      },
      playTurn(segs) {
        if (!wavesurfer || !segs.length) return
        const dur = wavesurfer.getDuration()
        const from = playWindow(segs[0], dur).from
        const to = playWindow(segs[segs.length - 1], dur).to
        wavesurfer.play(from, to)
      },
    }), [wavesurfer])

    return <div ref={container} />
  })
