import { describe, expect, it } from 'vitest'
import { ergaenzen, sprecherText, sprachText, alleGueltig,
         type Aufnahme } from './materialZeilen'

const z = (s: string, extra: Partial<Aufnahme> = {}): Aufnahme =>
  ({ schluessel: s, anzeige: s, sprecherText: '', sprache: 'ch', ...extra })

describe('ergaenzen', () => {
  it('haengt an, statt zu ersetzen — sonst ist „ich habe eine vergessen" Datenverlust', () => {
    expect(ergaenzen([z('a')], [z('b')]).map(x => x.schluessel)).toEqual(['a', 'b'])
  })

  it('erkennt Dubletten auch INNERHALB einer Auswahl', () => {
    /* Zwei gleichnamige Dateien aus verschiedenen Ordnern: ohne mitwachsendes Set
       entstuenden zwei Zeilen mit demselben key — React-Kollision, onAendern traefe
       beide, und der Server kollidierte mit 409. Eine der beiden waere verloren. */
    expect(ergaenzen([], [z('a'), z('a'), z('b')]).map(x => x.schluessel)).toEqual(['a', 'b'])
  })

  it('behaelt die getippte Zahl der schon vorhandenen Zeile', () => {
    const vorher = [z('a', { sprecherText: '5' })]
    expect(ergaenzen(vorher, [z('a')])[0].sprecherText).toBe('5')
  })
})

describe('Zusammenfassung', () => {
  it('zaehlt automatisch und von Hand getrennt', () => {
    expect(sprecherText([z('a'), z('b')], 20)).toBe('2× automatisch')
    expect(sprecherText([z('a', { sprecherText: '3' }), z('b')], 20)).toBe('1 von 2 gesetzt')
  })

  it('nennt „von Hand", wenn ALLE gesetzt sind', () => {
    /* Nicht im Plan, aber ein eigener Zweig: ohne diese Zusicherung liesse er sich durch
       „x von x gesetzt" ersetzen, ohne dass ein Test rot wird. */
    expect(sprecherText([z('a', { sprecherText: '3' }), z('b', { sprecherText: '2' })], 20))
      .toBe('2× von Hand')
  })

  it('fasst eine einheitliche Sprache zu einem Satz zusammen', () => {
    const labels = { ch: 'Schweizerdeutsch', en: 'Englisch' }
    expect(sprachText([z('a'), z('b')], labels)).toBe('Schweizerdeutsch für alle')
    expect(sprachText([z('a'), z('b', { sprache: 'en' })], labels))
      .toBe('1× Schweizerdeutsch, 1× Englisch')
  })

  it('sagt bei leerer Auswahl nichts Falsches', () => {
    /* Der dritte Zweig beider Funktionen. „0× automatisch" bzw. „undefined für alle"
       waeren beide Aussagen ueber eine Auswahl, die es nicht gibt. */
    expect(sprecherText([], 20)).toBe('—')
    expect(sprachText([], { ch: 'Schweizerdeutsch' })).toBe('—')
  })

  it('nennt die haeufigste Sprache zuerst', () => {
    const labels = { ch: 'Schweizerdeutsch', en: 'Englisch' }
    expect(sprachText([z('a', { sprache: 'en' }), z('b'), z('c')], labels))
      .toBe('2× Schweizerdeutsch, 1× Englisch')
  })
})

describe('alleGueltig', () => {
  it('sperrt bei EINER ungueltigen Zeile — sonst ginge sie als „automatisch" durch', () => {
    expect(alleGueltig([z('a', { sprecherText: '2' }), z('b', { sprecherText: 'x' })], 20))
      .toBe(false)
    expect(alleGueltig([z('a', { sprecherText: '2' }), z('b')], 20)).toBe(true)
  })
})
