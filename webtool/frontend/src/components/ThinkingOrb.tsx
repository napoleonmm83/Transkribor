import { ThinkingOrb as Orb, type OrbState } from 'thinking-orbs'
import type { FilePhase, GlobalPhase } from '@/lib/types'

type Phase = FilePhase | GlobalPhase

/** Animation und Farbe je KI-Phase. Nur kuehle Farben: Bernstein/Rot sind im Editor fuer
 *  unsichere Woerter belegt. Ein Waechter in `ThinkingOrb.test.tsx` haelt jede Phase gedeckt. */
export const ORB_PHASE: Record<Phase, { state: OrbState; color: string }> = {
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

/** Animierte Punkt-Kugel aus `thinking-orbs` (Canvas; bremst bei „Bewegung reduzieren" selbst).
 *  Reine Dekoration — das Etikett daneben traegt die Aussage. 20 px ist die abgestimmte
 *  Inline-Groesse des Pakets; kleiner bietet es nicht. */
export function ThinkingOrb({ phase }: { phase?: Phase | null; size?: 'sm' | 'md' }) {
  const p = phase ? ORB_PHASE[phase] : undefined
  return (
    <span aria-hidden="true" data-phase={phase ?? undefined} className="inline-flex shrink-0">
      <Orb state={p?.state ?? 'working'} color={p?.color} size={20} />
    </span>
  )
}
