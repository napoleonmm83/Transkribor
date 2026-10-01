import { CircleHelp, TriangleAlert } from 'lucide-react'

/** Die Segment-Flags. Als Emoji (⚠ 🔇) rendern sie je nach System in einer fremden
 *  Schrift, erben die Textfarbe nicht und heissen fuer einen Screenreader gar nichts.
 *  `erklaerung` steht hier statt in der Legende: ein Symbolname allein ("Halluzination")
 *  sagt niemandem, was er mit dem Segment tun soll. */
export const FLAGS = [
  { key: 'hallucination', icon: TriangleAlert, titel: 'Halluzination',
    erklaerung: 'Auffällig repetitiver Text — Whisper hat sich womöglich verhakt. Gegen die Aufnahme prüfen.' },
  { key: 'low_conf', icon: CircleHelp, titel: 'Geringe Konfidenz',
    erklaerung: 'Whisper war im ganzen Segment unsicher, nicht nur bei einzelnen Wörtern.' },
] as const

