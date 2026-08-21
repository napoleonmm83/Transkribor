import { describe, expect, it } from 'vitest'
import { ergaenzen, groesseText, sprecherText, sprachText, alleGueltig,
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

  it('benennt eine noch unbekannte Sprache, statt ein Loch zu lassen (#305)', () => {
    /* Solange der Einstellungs-GET nicht geantwortet hat — oder wenn er FEHLSCHLAEGT —, ist
       `projektSprache` der leere String, und eine in diesem Zustand angelegte Zeile traegt
       `sprache: ''`. `labels[''] ?? ''` machte daraus „ für alle": ein Loch in der
       Zusammenfassung, genau an der Stelle, die dem Nutzer sagen soll, was gleich passiert.
       Der Sendeweg ist davon unberuehrt (leer heisst „kein Override", der Projekt-Standard
       gilt) — es fehlte nur das Wort dafuer. */
    expect(sprachText([z('a', { sprache: '' })], {})).toBe('Projekt-Standard für alle')
    expect(sprachText([z('a'), z('b', { sprache: '' })], { ch: 'Schweizerdeutsch' }))
      .toBe('1× Schweizerdeutsch, 1× Projekt-Standard')
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

describe('groesseText', () => {
  it('rechnet dezimal — dieselbe MB-Definition wie das Upload-Zeitlimit', () => {
    // `api.uploadFrist` bemisst die Frist mit `bytes / 1_000_000`. Binaer gerechnet stuende
    // neben dem Namen eine andere Zahl als die, auf der die Frist beruht.
    expect(groesseText(4_200_000)).toBe('4,2 MB')
    expect(groesseText(1_000_000)).toBe('1,0 MB')
    expect(groesseText(812_000)).toBe('812 KB')
  })

  it('kennt eine GB-Stufe — `.mp4` steht in AUDIO_RE, ein langes Video kommt hier an', () => {
    // „4250,0 MB" liest niemand als vier Gigabyte.
    expect(groesseText(4_250_000_000)).toBe('4,3 GB')
    expect(groesseText(999_000_000)).toBe('999,0 MB')
  })

  it('kippt die Einheit dort, wo die ANZEIGE ueberlaeuft — an BEIDEN Grenzen', () => {
    /* Mit der Schwelle auf der runden Zahl stuende „1000,0 MB" direkt neben „1,0 GB" fuer
       ein Byte mehr (CodeRabbit-CLI). Dieselbe Kante hat die KB-Stufe; beide sind geprueft,
       weil ein Fix nur an der gemeldeten Stelle den Zwilling daneben stehen liesse. */
    expect(groesseText(999_999_999)).toBe('1,0 GB')
    expect(groesseText(999_949_999)).toBe('999,9 MB')
    expect(groesseText(999_999)).toBe('1,0 MB')
    expect(groesseText(999_499)).toBe('999 KB')
  })

  it('rundet eine 0-Byte-Aufnahme NICHT auf „1 KB" hoch', () => {
    // Ein abgebrochener Export ist genau der Fall, fuer den diese Spalte da ist: die Datei
    // sieht in der Liste normal aus, und nur die Groesse verraet, dass nichts drin ist.
    // Ein `Math.max(1, …)` verstellte den Blick darauf.
    expect(groesseText(0)).toBe('0 KB')
  })
})
