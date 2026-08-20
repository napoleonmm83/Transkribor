import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import { useWavesurfer } from '@wavesurfer/react'
import { Pause, Play, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { playWindow, naechsteAktion, zeitText, type Fenster } from '@/lib/playback'
import { useTheme } from '@/components/ThemeProvider'
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

export const Waveform = forwardRef<WaveHandle,
  { url: string; onTime: (t: number) => void
    /** Einmal beim `ready`: Pegel-Spitzen und Dauer. Optional — der Editor braucht sie
     *  nicht, der Hoerbalken leitet daraus seine Sprungstelle ab. */
    onBereit?: (peaks: Float32Array, dauer: number) => void }>(
  function Waveform({ url, onTime, onBereit }, ref) {
    const container = useRef<HTMLDivElement>(null)
    const { theme } = useTheme()
    // isPlaying/currentTime/isReady bringt der Hook ohnehin mit und rendert ohnehin bei jedem
    // timeupdate neu — eigener State dafuer waere ein zweiter, langsamerer Zaehler.
    const { wavesurfer, isPlaying, currentTime, isReady } = useWavesurfer({
      container, url, height: 72, barWidth: 2, barGap: 1,
      ...colors(theme === 'dark'),
    })

    // Das zuletzt angespielte Stueck. Muss hier liegen und nicht in wavesurfer: der loescht
    // seine eigene Endgrenze (stopAtPosition) im pause-Handler, ein blosses playPause() liefe
    // darum ueber das Segmentende hinaus.
    const fenster = useRef<Fenster | null>(null)
    useEffect(() => { fenster.current = null }, [url])   // andere Datei -> alte Grenze gilt nicht

    // Peaks gibt es erst nach `ready` — vorher ist nichts dekodiert, es gaebe nichts zu
    // springen. `exportPeaks()` liefert ein Array je Kanal; der erste reicht (Mono-Faltung
    // waere teurer als der Nutzen fuer eine Pegelschwelle).
    useEffect(() => {
      if (!wavesurfer || !isReady || !onBereit) return
      const kanaele = wavesurfer.exportPeaks()
      onBereit(new Float32Array(kanaele[0] ?? []), wavesurfer.getDuration())
    }, [wavesurfer, isReady, onBereit])

    useEffect(() => {
      if (!wavesurfer) return
      return wavesurfer.on('timeupdate', (t: number) => onTime(t))
    }, [wavesurfer, onTime])

    useEffect(() => { wavesurfer?.setOptions(colors(theme === 'dark')) }, [theme, wavesurfer])

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
        <div className="mt-1.5 flex items-center gap-1">
          <Button size="icon" variant="ghost" disabled={!isReady}
            aria-label={isPlaying ? 'Pause' : 'Abspielen'} onClick={() => steuerung.toggle(null)}>
            {isPlaying ? <Pause className="size-4" /> : <Play className="size-4" />}
          </Button>
          <Button size="icon" variant="ghost" disabled={!isReady}
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
