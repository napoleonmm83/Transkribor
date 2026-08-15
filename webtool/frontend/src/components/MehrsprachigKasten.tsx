/** Das Kästchen „Enthält weitere Sprachen“ — geteilt von Projekt- und Datei-Dialog.
 *
 *  Eigenes Bauteil, weil Beschriftung UND Erklärtext an beiden Stellen identisch sein müssen:
 *  zweimal dasselbe Markup hiesse, es beim nächsten Mal an einer Stelle zu vergessen (dieselbe
 *  Lehre wie bei `DateiMenue` und `EditierbarerText`).
 *
 *  Ein natives `<input type="checkbox">` statt eines shadcn-Bauteils: `components/ui/` hat
 *  bewusst nur, was mehrfach gebraucht wird, und `@radix-ui/react-checkbox` liegt nicht vor —
 *  eine neue Abhängigkeit für ein Kästchen wäre teurer als das Kästchen.
 *
 *  Der Erklärtext steht AUSSERHALB des `<label>` und hängt über `aria-describedby` daran.
 *  Lag er darin, wurde er Teil des Accessible Name: ein Screenreader las die ganzen drei
 *  Zeilen als Beschriftung der Checkbox vor, statt „Enthält weitere Sprachen" zu sagen und
 *  die Erklärung als Beschreibung nachzuliefern. In jsdom fällt das nicht auf —
 *  `getByLabelText` findet den Kasten so wie so; gehört also zu dem, was man wissen muss,
 *  nicht zu dem, was ein Test hält.
 *
 *  `id` wird von aussen gereicht, weil zwei Kästchen gleichzeitig im DOM stehen können — die
 *  Arbeitsfläche zeigt eines im Bereich „Material hinzufügen", und der Einstellungs-Dialog
 *  daneben bringt sein eigenes mit. Doppelte ids wären ungültiges HTML und die Beschreibung
 *  landete am falschen Element.
 */
export function MehrsprachigKasten({ wert, setzen, id = 'mehrsprachig' }: {
  wert: boolean
  setzen: (w: boolean) => void
  id?: string
}) {
  const hinweisId = `${id}-hinweis`
  return (
    <div className="text-sm">
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-0.5 size-4 shrink-0 accent-primary"
          checked={wert}
          onChange={e => setzen(e.target.checked)}
          aria-describedby={hinweisId}
        />
        <span>Enthält weitere Sprachen</span>
      </label>
      <p id={hinweisId} className="mt-1 pl-6 text-muted-foreground">
        Die oben gewählte Sprache gilt als Hauptsprache; andere werden im Verlauf erkannt.
        Bei einsprachigen Aufnahmen ausgeschaltet lassen — dort schadet die Erkennung mehr,
        als sie nützt.
      </p>
    </div>
  )
}
