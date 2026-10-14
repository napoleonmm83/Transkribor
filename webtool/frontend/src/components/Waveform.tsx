import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useWavesurfer } from '@wavesurfer/react'
import { Pause, Play, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { playWindow, naechsteAktion, zeitText, type Fenster } from '@/lib/playback'
import { useTheme } from '@/hooks/useTheme'
import { getWaveform, type WaveformData } from '@/lib/api'
import type { Segment } from '@/lib/types'

export type WaveHandle = {
  playSegment: (s: Segment) => void
  playTurn: (s: Segment[]) => void
  /** Play/Pause. `seg` = das Segment unter dem Cursor, falls es eines gibt. */
  toggle: (seg?: Segment | null) => void
  skip: (sekunden: number) => void
  /** Anhalten und an den Anfang zurueck. */
  stop: () => void
  /** Absolut an eine Sekunde springen. `skip` ist RELATIV und taugt dafuer nicht. */
  springeZu: (sekunde: number) => void
}

// Wavesurfer malt auf Canvas und kann keine CSS-Variablen lesen — die Werte muessen hier
// stehen. Sie spiegeln die Tokens aus index.css: Neutralton fuer die ungespielte Welle,
// --primary fuer den Fortschritt. Bei einer Palettenaenderung mit anpassen.
const colors = (dark: boolean) => ({
  waveColor: dark ? '#3F3F46' : '#D4D4D8',        // zinc-700 / zinc-300
  progressColor: dark ? '#818CF8' : '#4F46E5',    // --primary hell/dunkel
})

type WaveProps = {
  url: string
  onTime: (t: number) => void
  onBereit?: (peaks: Float32Array, dauer: number) => void
}

export const Waveform = forwardRef<WaveHandle, WaveProps>(function Waveform(props, ref) {
  const { url } = props
  const stored = url.startsWith('/api/projects/')
  const [loaded, setLoaded] = useState<{ url: string; data?: WaveformData; error?: string } | null>(null)
  useEffect(() => {
    if (!stored) return
    const abort = new AbortController()
    getWaveform(url, abort.signal).then(data => {
      if (!abort.signal.aborted) setLoaded({ url, data })
    }).catch(error => {
      if (!abort.signal.aborted) setLoaded({ url, error: error instanceof Error ? error.message : 'Wellenform konnte nicht geladen werden' })
    })
    return () => abort.abort()
  }, [url, stored])
  // A new URL must never render with the previous recording's envelope.
  if (stored && (loaded?.url !== url || !loaded.data)) {
    const error = loaded?.url === url ? loaded.error : undefined
    return <p role={error ? 'alert' : 'status'} className="py-4 text-sm text-muted-foreground">
      {error ? `Wellenform konnte nicht geladen werden: ${error}` : 'Wellenform wird vorbereitet …'}
    </p>
  }
  return <LoadedWaveform key={url} {...props} ref={ref} data={stored ? loaded?.data : undefined} />
})

const LoadedWaveform = forwardRef<WaveHandle, WaveProps & { data?: WaveformData }>(
  function LoadedWaveform({ url, onTime, onBereit, data }, ref) {
    const container = useRef<HTMLDivElement>(null)
    const { theme } = useTheme()
    // isPlaying/currentTime/isReady bringt der Hook ohnehin mit und rendert ohnehin bei jedem
    // timeupdate neu — eigener State dafuer waere ein zweiter, langsamerer Zaehler.
    const { wavesurfer, isPlaying, currentTime, isReady } = useWavesurfer({
      container, backend: 'MediaElement', height: 72, barWidth: 2, barGap: 1,
      ...colors(theme === 'dark'),
    })

    const [mediaError, setMediaError] = useState<string | null>(null)
    useEffect(() => {
      if (!wavesurfer) return
      return wavesurfer.on('error', (error: Error) => setMediaError(error.message || 'Keine weiteren Angaben'))
    }, [wavesurfer])

    // Das zuletzt angespielte Stueck. Muss hier liegen und nicht in wavesurfer: der loescht
    // seine eigene Endgrenze (stopAtPosition) im pause-Handler, ein blosses playPause() liefe
    // darum ueber das Segmentende hinaus.
    const fenster = useRef<Fenster | null>(null)
    useEffect(() => { fenster.current = null }, [url])   // andere Datei -> alte Grenze gilt nicht

    // Readiness belongs to the current loaded player. Stored recordings already
    // carry compact peaks; local blob previews retain exportPeaks behavior.
    useEffect(() => {
      if (!wavesurfer || !onBereit) return
      return wavesurfer.on('ready', (dauer: number) => {
        onBereit(new Float32Array(data?.peaks[0] ?? wavesurfer.exportPeaks({ channels: 1 })[0] ?? []), data?.duration ?? dauer)
      })
    }, [wavesurfer, onBereit, data])

    useEffect(() => {
      if (!wavesurfer) return
      return wavesurfer.on('timeupdate', (t: number) => onTime(t))
    }, [wavesurfer, onTime])

    useEffect(() => { wavesurfer?.setOptions(colors(theme === 'dark')) }, [theme, wavesurfer])

    // With precomputed data, load can finish before the hook's next render.
    // Start it after readiness/error subscriptions, never in the constructor.
    useEffect(() => {
      if (!wavesurfer) return
      wavesurfer.getMediaElement().preload = 'metadata'
      void wavesurfer.load(url, data?.peaks, data?.duration).catch(() => {
        // The error event above presents load failures to the user.
      })
    }, [wavesurfer, url, data])

    // useMemo statt direkt im useImperativeHandle: die Knoepfe unter der Welle brauchen
    // dieselben Aktionen wie die Tastenkuerzel — zweimal geschrieben liefen sie auseinander.
    const steuerung = useMemo<WaveHandle>(() => ({
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
        // Vor dem Dekodieren liefert getDuration() 0 -> playWindow klemmt `to` auf 0 und das
        // gemerkte Fenster waere {from, to:0}; der naechste Druck spielte dann grenzenlos
        // ab 0 (Review Minor 4).
        if (!wavesurfer.getDuration()) return
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
        // wavesurfer.skip() ist bereits setTime(getCurrentTime()+sekunden) geklemmt auf
        // [0, getDuration()] — dafuer keine eigene Klemm-Rechnung. setTime loescht
        // stopAtPosition, hier erwuenscht: wer vorspult, will ueber das Segmentende hinaus
        // hoeren. Das Fenster bleibt stehen, aber als `frei` markiert, damit naechsteAktion
        // weiss: das war ein Sprung, kein natuerliches Ende (Review Important 1).
        if (fenster.current) fenster.current = { ...fenster.current, frei: true }
        wavesurfer.skip(sekunden)
      },
      stop() {
        if (!wavesurfer) return
        // Das gemerkte Fenster muss mit: nach dem Ruecksprung auf 0 stimmt es nicht mehr, und
        // naechsteAktion wuerde sonst ein Segment wiederholen, das gerade verworfen wurde.
        fenster.current = null
        wavesurfer.stop()   // pause + setTime(0)
      },
      springeZu(sekunde) {
        if (!wavesurfer) return
        // Dieselbe Begruendung wie in `skip`: setTime loescht stopAtPosition, und das
        // gemerkte Fenster gilt danach nicht mehr fuer `naechsteAktion`.
        fenster.current = null
        wavesurfer.setTime(sekunde)
      },
    }), [wavesurfer])
    useImperativeHandle(ref, () => steuerung, [steuerung])

    return (
      <>
        <div ref={container} />
        {mediaError && <p role="alert" className="text-sm text-muted-foreground">Audio konnte nicht geladen werden: {mediaError}</p>}
        <div className="mt-1.5 flex items-center gap-1">
          <Button size="icon" variant="ghost" disabled={!isReady || !!mediaError}
            aria-label={isPlaying ? 'Pause' : 'Abspielen'} onClick={() => steuerung.toggle(null)}>
            {isPlaying ? <Pause className="size-4" /> : <Play className="size-4" />}
          </Button>
          <Button size="icon" variant="ghost" disabled={!isReady || !!mediaError}
            aria-label="Stopp" onClick={() => steuerung.stop()}>
            <Square className="size-4" />
          </Button>
          {/* tabular-nums: sonst zappelt die Zeile bei jeder Sekunde in der Breite. */}
          <span className="ml-1 text-xs tabular-nums text-muted-foreground">
            {zeitText(currentTime)} / {zeitText(isReady ? wavesurfer?.getDuration() ?? 0 : 0)}
          </span>
        </div>
      </>
    )
  })
