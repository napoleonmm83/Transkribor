import type { Ref } from 'react'
import { Waveform, type WaveHandle } from './Waveform'

export function PlayerDock({ url, onTime, waveRef }: {
  url?: string; onTime: (t: number) => void; waveRef: Ref<WaveHandle>
}) {
  return (
    <footer className="border-t px-3 py-2">
      {url ? <Waveform url={url} onTime={onTime} ref={waveRef} /> : <div className="h-[72px]" />}
    </footer>
  )
}
