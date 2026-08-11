import { describe, it, expect } from 'vitest'
import { playWindow, naechsteAktion, segIdAusFokus, zeitText } from './playback'
import type { Segment } from './types'

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9

describe('playWindow', () => {
  it.each([
    [{ start: 18.36, end: 20.06 }, 60, 18.21, 20.41],
    [{ start: 31.98, end: 42.76 }, 60, 31.83, 43.11],
    [{ start: 0.05, end: 2.0 }, 60, 0.0, 2.35],   // Pre-Roll auf 0 geklemmt
    [{ start: 50.0, end: 59.9 }, 60, 49.85, 60.0], // Post-Roll auf Dauer geklemmt
    [{ start: 5.0, end: 6.0 }, NaN, 4.85, 6.35],   // Dauer unbekannt -> kein oberes Clamp
  ])('bracketet Segment mit Lead-in/out', (seg, dur, ef, et) => {
    const { from, to } = playWindow(seg as any, dur as number)
    expect(near(from, ef)).toBe(true)
    expect(near(to, et)).toBe(true)
  })
})

describe('zeitText', () => {
  it.each([
    [0, '0:00'], [7, '0:07'], [63.9, '1:03'], [599, '9:59'],
    [3600, '1:00:00'], [3725, '1:02:05'],  // Stundenstelle erst, wenn es sie gibt
    [-1, '0:00'], [NaN, '0:00'],           // vor dem Dekodieren liefert wavesurfer NaN/0
  ])('%s s -> %s', (sek, text) => expect(zeitText(sek)).toBe(text))
})

/** Nur die Felder, die naechsteAktion liest — der Rest von Segment ist hier Ballast. */
const seg = (id: number, start: number, end: number) =>
  ({ id, start, end }) as unknown as Segment

describe('naechsteAktion', () => {
  it('pausiert, wenn etwas laeuft — egal was sonst anliegt', () => {
    expect(naechsteAktion({
      laeuft: true, fenster: { from: 1, to: 2, segId: 7 }, zeit: 1.5, segment: seg(9, 30, 31), dauer: 60,
    })).toEqual({ art: 'pause' })
  })

  it('spielt das gewaehlte Segment, wenn noch nichts gespielt wurde', () => {
    expect(naechsteAktion({
      laeuft: false, fenster: null, zeit: 0, segment: seg(47, 18.36, 20.06), dauer: 60,
    })).toEqual({
      art: 'fenster', from: expect.closeTo(18.21, 9), to: expect.closeTo(20.41, 9), segId: 47,
    })
  })

  it('setzt im gemerkten Fenster fort UND setzt die Grenze neu', () => {
    expect(naechsteAktion({
      laeuft: false, fenster: { from: 18.21, to: 20.41, segId: 47 }, zeit: 19.0, segment: null, dauer: 60,
    })).toEqual({ art: 'weiter', to: 20.41 })
  })

  it('setzt auch dann fort, wenn der Cursor im selben Segment steht (Pause -> weiter)', () => {
    expect(naechsteAktion({
      laeuft: false, fenster: { from: 18.21, to: 20.41, segId: 47 }, zeit: 19.0,
      segment: seg(47, 18.36, 20.06), dauer: 60,
    })).toEqual({ art: 'weiter', to: 20.41 })
  })

  it('springt zum anderen Segment, statt fortzusetzen', () => {
    expect(naechsteAktion({
      laeuft: false, fenster: { from: 18.21, to: 20.41, segId: 47 }, zeit: 19.0,
      segment: seg(48, 31.98, 42.76), dauer: 60,
    })).toEqual({
      // 31.98 - 0.15 ist in Fliesskomma 31.830000000000002 — darum closeTo und nicht 31.83.
      art: 'fenster', from: expect.closeTo(31.83, 9), to: expect.closeTo(43.11, 9), segId: 48,
    })
  })

  it('vergisst das Fenster, wenn die Position herausgespult wurde', () => {
    expect(naechsteAktion({
      laeuft: false, fenster: { from: 18.21, to: 20.41, segId: 47 }, zeit: 22.5, segment: null, dauer: 60,
    })).toEqual({ art: 'weiter' })
  })

  it('spielt blank weiter, wenn es weder Fenster noch Segment gibt', () => {
    expect(naechsteAktion({
      laeuft: false, fenster: null, zeit: 5, segment: null, dauer: 60,
    })).toEqual({ art: 'weiter' })
  })

  it('behandelt einen Redebeitrag (segId null) als fremdes Fenster', () => {
    expect(naechsteAktion({
      laeuft: false, fenster: { from: 10, to: 40, segId: null }, zeit: 20,
      segment: seg(47, 18.36, 20.06), dauer: 60,
    })).toEqual({
      art: 'fenster', from: expect.closeTo(18.21, 9), to: expect.closeTo(20.41, 9), segId: 47,
    })
  })

  // Die drei Faelle, die Important 1 gefunden haette: wavesurfer stoppt beim natuerlichen Ende
  // exakt auf `to`, nicht knapp davor.
  it('wiederholt, wenn die Position exakt auf dem Fensterende steht (durchgelaufen)', () => {
    expect(naechsteAktion({
      laeuft: false, fenster: { from: 18.21, to: 20.41, segId: 47 }, zeit: 20.41,
      segment: seg(47, 18.36, 20.06), dauer: 60,
    })).toEqual({
      art: 'fenster', from: expect.closeTo(18.21, 9), to: expect.closeTo(20.41, 9), segId: 47,
    })
  })

  it('zaehlt die untere Fenstergrenze noch als "im Fenster"', () => {
    expect(naechsteAktion({
      laeuft: false, fenster: { from: 18.21, to: 20.41, segId: 47 }, zeit: 18.21,
      segment: seg(47, 18.36, 20.06), dauer: 60,
    })).toEqual({ art: 'weiter', to: 20.41 })
  })

  it('spielt frei weiter (ohne Grenze), wenn das Fenster als frei markiert ist', () => {
    expect(naechsteAktion({
      laeuft: false, fenster: { from: 18.21, to: 20.41, segId: 47, frei: true }, zeit: 20.41,
      segment: seg(47, 18.36, 20.06), dauer: 60,
    })).toEqual({ art: 'weiter' })
  })
})

describe('segIdAusFokus', () => {
  it('liest die id aus dem umgebenden Segment-Div', () => {
    document.body.innerHTML = '<div data-seg-id="47"><textarea id="t"></textarea></div>'
    expect(segIdAusFokus(document.getElementById('t'), 3)).toBe(47)
  })

  it('faellt auf das hervorgehobene Segment zurueck, wenn der Fokus woanders steht', () => {
    document.body.innerHTML = '<button id="b"></button>'
    expect(segIdAusFokus(document.getElementById('b'), 3)).toBe(3)
  })

  it('faellt auch ohne Fokus zurueck', () => {
    expect(segIdAusFokus(null, 3)).toBe(3)
    expect(segIdAusFokus(null, null)).toBe(null)
  })
})
