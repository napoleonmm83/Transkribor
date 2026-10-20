/**
 * Waechter fuer den Thinking Orb (`src/components/ThinkingOrb.tsx`). Liegt im Frontend-Stamm
 * aus demselben Grund wie `rollbalken.test.ts`: unter `src/` liefert `index.css?raw` in vitest
 * einen leeren String.
 * - Jede Phase, die der Orb bekommen kann, hat eine eigene Farbregel — sonst faellt ein
 *   umbenannter Phasenwert still auf die Standardfarbe.
 * - Die `.orb`-Regeln stehen IN `@layer components`: ausserhalb schlug die spaetere
 *   Animationsregel den ungeschichteten reduced-motion-Block (im Browser gemessen, der Orb
 *   lief unter „Bewegung reduzieren" weiter).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PHASE_LABEL, GLOBAL_LABEL } from './src/lib/jobPhases'

const roh = readFileSync(resolve(import.meta.dirname, 'src/index.css'), 'utf8')
const css = roh.replace(/\/\*[\s\S]*?\*\//g, '')

describe('Thinking Orb CSS', () => {
  it('jede Phase hat eine Farbregel', () => {
    const phasen = [...Object.keys(PHASE_LABEL), ...Object.keys(GLOBAL_LABEL)]
    expect(phasen.length).toBeGreaterThan(5)
    for (const p of phasen) expect(css, p).toContain(`.orb[data-phase="${p}"]`)
  })
  it('die Orb-Regeln liegen in @layer components, der reduced-motion-Stopp dahinter', () => {
    // Verankert an der Schlussmarke der Schicht im ROHtext (die Regeln darin sind nicht
    // eingerueckt, eine Spalte-0-Klammer taugt nicht als Ende).
    const layer = roh.indexOf('@layer components {')
    const orb = roh.indexOf('.orb {')
    const schichtEnde = roh.indexOf('}  /* @layer components */')
    const stopp = roh.indexOf('.orb, .orb::after { animation: none; }')
    expect(layer).toBeGreaterThan(-1)
    expect(orb).toBeGreaterThan(layer)
    expect(schichtEnde).toBeGreaterThan(orb)
    expect(stopp).toBeGreaterThan(schichtEnde)
  })
})
