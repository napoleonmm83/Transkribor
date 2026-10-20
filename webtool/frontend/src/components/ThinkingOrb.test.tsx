import { describe, it, expect } from 'vitest'
import { PHASE_LABEL, GLOBAL_LABEL } from '@/lib/jobPhases'
import { ORB_PHASE } from './ThinkingOrb'

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
})
