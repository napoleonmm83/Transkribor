import type { FilePhase, GlobalPhase } from '@/lib/types'
import { cn } from '@/lib/utils'

/** Pulsierender Farbpunkt statt Drehkreis: Farbe und Tempo je Phase stehen in `index.css`
 *  (`.orb[data-phase=…]`). Reine Dekoration — das Etikett daneben traegt die Aussage. */
export function ThinkingOrb({ phase, size = 'sm', className }: {
  phase?: FilePhase | GlobalPhase | null; size?: 'sm' | 'md'; className?: string
}) {
  return (
    <span aria-hidden="true" data-phase={phase ?? undefined}
      className={cn('orb shrink-0', size === 'md' ? 'size-4' : 'size-3.5', className)} />
  )
}
