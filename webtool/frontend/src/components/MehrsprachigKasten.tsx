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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const ERKLAERUNG =
  'Die oben gewählte Sprache gilt als Hauptsprache; andere werden im Verlauf erkannt. '
  + 'Bei einsprachigen Aufnahmen ausgeschaltet lassen — dort schadet die Erkennung mehr, '
  + 'als sie nützt.'

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
      <p id={hinweisId} className="mt-1 pl-6 text-muted-foreground">{ERKLAERUNG}</p>
    </div>
  )
}

/** `null` = folgt dem Projekt. */
export type MehrWahl = boolean | null

/**
 * Dieselbe Frage für EINE Datei — und dort braucht sie einen dritten Zustand: „folgt dem
 * Projekt". Ein Kästchen kann das nicht, es kennt nur an und aus (#166).
 *
 * Warum das zählt: `projekt.datei_mehrsprachig` löst den Rückfall über die ANWESENHEIT des
 * Schlüssels auf (ein bewusst gesetztes `false` ist falsy und fiele mit `or` auf den
 * Projektwert zurück). Genau richtig — nur gab es danach keinen Weg zurück: sobald der
 * Schlüssel einmal in `projekt.json` stand, zog die Datei bei einer Änderung des
 * Projekt-Standards nicht mehr mit, und nichts in der Oberfläche sagte, warum.
 *
 * Der Projektwert steht IN der Beschriftung („folgt dem Projekt (aus)"), nicht daneben: die
 * Auswahl entscheidet sonst über einen Wert, den man erst woanders nachschlagen muss.
 */
export function MehrsprachigWahl({ wert, setzen, projektwert, id = 'mehrwahl' }: {
  wert: MehrWahl
  setzen: (w: MehrWahl) => void
  projektwert: boolean
  id?: string
}) {
  const hinweisId = `${id}-hinweis`
  const alsText = wert === null ? 'erben' : wert ? 'ja' : 'nein'
  return (
    <div className="text-sm">
      <label id={`${id}-lbl`} className="mb-1.5 block font-medium">Mehrere Sprachen</label>
      <Select
        value={alsText}
        onValueChange={v => setzen(v === 'erben' ? null : v === 'ja')}
      >
        <SelectTrigger className="w-full" aria-labelledby={`${id}-lbl`}
          aria-describedby={hinweisId}><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="erben">Folgt dem Projekt ({projektwert ? 'ja' : 'nein'})</SelectItem>
          <SelectItem value="ja">Ja — enthält weitere Sprachen</SelectItem>
          <SelectItem value="nein">Nein — nur die gewählte Sprache</SelectItem>
        </SelectContent>
      </Select>
      <p id={hinweisId} className="mt-1 text-muted-foreground">{ERKLAERUNG}</p>
    </div>
  )
}
