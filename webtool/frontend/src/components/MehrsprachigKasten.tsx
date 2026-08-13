/** Das Kästchen „Enthält weitere Sprachen“ — geteilt von Projekt- und Datei-Dialog.
 *
 *  Eigenes Bauteil, weil Beschriftung UND Erklärtext an beiden Stellen identisch sein müssen:
 *  zweimal dasselbe Markup hiesse, es beim nächsten Mal an einer Stelle zu vergessen (dieselbe
 *  Lehre wie bei `DateiMenue` und `EditierbarerText`).
 *
 *  Ein natives `<input type="checkbox">` statt eines shadcn-Bauteils: `components/ui/` hat
 *  bewusst nur, was mehrfach gebraucht wird, und `@radix-ui/react-checkbox` liegt nicht vor —
 *  eine neue Abhängigkeit für ein Kästchen wäre teurer als das Kästchen. Das `<label>` umschliesst
 *  den Kasten, damit die Beschriftung ohne `id`-Vergabe klickbar und für `getByLabelText`
 *  auffindbar ist.
 */
export function MehrsprachigKasten({ wert, setzen }: {
  wert: boolean
  setzen: (w: boolean) => void
}) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 accent-primary"
        checked={wert}
        onChange={e => setzen(e.target.checked)}
      />
      <span>
        Enthält weitere Sprachen
        <span className="block text-muted-foreground">
          Die oben gewählte Sprache gilt als Hauptsprache; andere werden im Verlauf erkannt.
          Bei einsprachigen Aufnahmen ausgeschaltet lassen — dort schadet die Erkennung mehr,
          als sie nützt.
        </span>
      </span>
    </label>
  )
}
