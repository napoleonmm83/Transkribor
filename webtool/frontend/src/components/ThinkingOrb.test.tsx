import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { PHASE_LABEL, GLOBAL_LABEL } from '@/lib/jobPhases'
import { Ctx } from '@/hooks/useTheme'

// Das Paket zeichnet auf Canvas — jsdom sieht davon nichts. Gemessen wird deshalb, WAS bei ihm
// ankommt (state, color, theme); ohne das blieb eine Mutation „Tabelle ignorieren" gruen.
const orbProps = vi.fn()
vi.mock('thinking-orbs', () => ({
  ThinkingOrb: (p: Record<string, unknown>) => { orbProps(p); return null },
}))
const { ThinkingOrb, ORB_PHASE } = await import('./ThinkingOrb')

describe('ThinkingOrb', () => {
  it('jede Phase hat eine eigene Animation und Farbe', () => {
    // Ein umbenannter Phasenwert faellt sonst still auf den Standard-Orb zurueck.
    const phasen = [...Object.keys(PHASE_LABEL), ...Object.keys(GLOBAL_LABEL)]
    expect(phasen.length).toBeGreaterThan(5)
    for (const p of phasen) {
      const e = ORB_PHASE[p as keyof typeof ORB_PHASE]
      expect(e?.state, p).toBeTruthy()
      expect(e?.color, p).toMatch(/^#[0-9A-F]{6}$/i)
    }
  })
  it('reicht Animation, Farbe und das App-Thema an den Orb weiter', () => {
    orbProps.mockClear()
    render(<Ctx.Provider value={{ theme: 'light', toggle: () => {} }}><ThinkingOrb phase="correct" /></Ctx.Provider>)
    expect(orbProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'composing', color: '#8B5CF6', theme: 'light', size: 20 }))
  })
})
