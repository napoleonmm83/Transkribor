import { ThinkingOrb as Orb } from 'thinking-orbs'
import { useTheme } from '@/hooks/useTheme'
import { ORB_PHASE, type OrbPhase } from '@/lib/orbPhasen'

/** Animierte Punkt-Kugel aus `thinking-orbs` (Canvas; bei „Bewegung reduzieren" malt das Paket
 *  ein Standbild). Reine Dekoration — das Etikett daneben traegt die Aussage. 20 px ist die
 *  abgestimmte Inline-Groesse des Pakets; kleiner bietet es nicht.
 *  `theme` kommt aus UNSEREM ThemeProvider: dessen `auto` kennt nur eine `dark`-Klasse und faellt
 *  sonst aufs Betriebssystem zurueck — App hell bei OS dunkel ergaebe weisse Punkte auf Weiss.
 *  Je Orb laeuft eine eigene rAF-Schleife; deshalb nur fuer Arbeit, die WIRKLICH laeuft. */
export function ThinkingOrb({ phase }: { phase?: OrbPhase | null }) {
  const { theme } = useTheme()
  const p = phase ? ORB_PHASE[phase] : undefined
  return (
    <span aria-hidden="true" data-phase={phase ?? undefined} className="inline-flex shrink-0">
      <Orb state={p?.state ?? 'working'} color={p?.color} theme={theme} size={20} />
    </span>
  )
}
