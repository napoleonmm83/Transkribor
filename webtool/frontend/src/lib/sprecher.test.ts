import { describe, expect, it } from 'vitest'
import { sprecherWahl } from './sprecher'

describe('sprecherWahl', () => {
  it('leer heisst automatisch, nicht ungueltig', () => {
    expect(sprecherWahl('', 20)).toBeNull()
    expect(sprecherWahl('   ', 20)).toBeNull()
  })
  it('eine Zahl im Bereich kommt als Zahl heraus', () => {
    expect(sprecherWahl('5', 20)).toBe(5)
    expect(sprecherWahl(' 5 ', 20)).toBe(5)
  })
  it('die Grenzen selbst sind gueltig — Untergrenze 1, nicht 2 (#264)', () => {
    expect(sprecherWahl('1', 20)).toBe(1)
    expect(sprecherWahl('20', 20)).toBe(20)
  })
  it('ausserhalb des Bereichs ist ungueltig, nicht geklemmt', () => {
    expect(sprecherWahl('0', 20)).toBeUndefined()
    expect(sprecherWahl('21', 20)).toBeUndefined()
    expect(sprecherWahl('1000000', 20)).toBeUndefined()
  })
  it('alles, was keine reine Ziffernfolge ist, ist ungueltig', () => {
    // Der Fall, fuer den es `type="text"` gibt: ein Zahlenfeld liefert hier "" und die
    // Eingabe verschwaende still (#264).
    expect(sprecherWahl('5e', 20)).toBeUndefined()
    expect(sprecherWahl('2.5', 20)).toBeUndefined()
    expect(sprecherWahl('-3', 20)).toBeUndefined()
    expect(sprecherWahl('1e1', 20)).toBeUndefined()
  })
  it('die Obergrenze kommt vom Aufrufer, nicht aus dem Modul', () => {
    expect(sprecherWahl('30', 20)).toBeUndefined()
    expect(sprecherWahl('30', 40)).toBe(30)
  })
})
