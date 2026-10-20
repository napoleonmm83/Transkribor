import type { OrbState } from 'thinking-orbs'
import type { FilePhase, GlobalPhase } from './types'

export type OrbPhase = FilePhase | GlobalPhase

/** Animation und Farbe je KI-Phase fuer `components/ThinkingOrb.tsx`. Nur kuehle Farben:
 *  Bernstein/Rot sind im Editor fuer unsichere Woerter belegt. Ein Waechter in
 *  `ThinkingOrb.test.tsx` haelt jede Phase gedeckt. Eigene Datei, weil `only-export-components`
 *  neben einer Komponente nur Komponenten erlaubt. */
export const ORB_PHASE: Record<OrbPhase, { state: OrbState; color: string }> = {
  transcribe: { state: 'listening', color: '#3B82F6' },
  audio: { state: 'listening', color: '#64748B' },
  diarize: { state: 'connecting', color: '#0891B2' },
  context: { state: 'weaving', color: '#6366F1' },
  prep: { state: 'weaving', color: '#6366F1' },
  glossary: { state: 'weaving', color: '#6366F1' },
  correct: { state: 'composing', color: '#8B5CF6' },
  verify: { state: 'solving', color: '#10B981' },
  download: { state: 'searching', color: '#64748B' },
}
