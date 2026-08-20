import { useId } from 'react'
import { sprecherWahl } from '@/lib/sprecher'
import { Button } from '@/components/ui/button'

export type VorschauZeile = { schluessel: string; anzeige: string; sprecherText: string }

/** Eine Zeile je Aufnahme, mit eigenem Feld „Anzahl Sprecher" — zwischen der Auswahl und dem
 *  Start.
 *
 *  **Warum sie ueberhaupt existiert:** Hochladen IST der Startschuss (der Endpunkt startet die
 *  Transkription selbst, danach laeuft die Korrektur nach). Wer die Sprecherzahl erst danach im
 *  ⋯-Menue eintraegt, rennt gegen die eigene Pipeline; kommt sie zu spaet, hilft nur ein
 *  zweiter, teurer Lauf. Hier steht sie in `projekt.json`, BEVOR ein Job laeuft.
 *
 *  **Warum je Zeile und nicht einmal fuer den Stapel:** ein Rutsch mischt 2er-Interviews mit
 *  einem 5er-Team. Ein Wert fuer alle waere fuer die Haelfte falsch — und falsch wiegt hier
 *  schwerer als leer, weil `num_speakers` exakt gilt und keine Obergrenze ist (#264).
 *
 *  Reine Darstellung, kein eigener Zustand: die Zeilen haelt der Aufrufer (dieselbe Trennung
 *  wie bei `MehrsprachigKasten`). Beide Eingangswege — Datei-Upload und URL-Import — benutzen
 *  dieselbe Komponente; zwei Fassungen liefen beim naechsten Zusatz auseinander.
 */
export function MaterialVorschau({ titel, zeilen, sprecherMax, laeuft, startText,
                                   onAendern, onStart, onAbbrechen }: {
  titel: string
  zeilen: VorschauZeile[]
  /** Obergrenze vom Server (`sprecher_max`), damit `sprachen.SPRECHER_MAX` nicht ein zweites
   *  Mal im Frontend steht. */
  sprecherMax: number
  /** Laeuft der Start gerade? Sperrt Felder und Knopf — sonst startete ein Doppelklick zwei
   *  Laeufe. */
  laeuft?: boolean
  startText: string
  onAendern: (schluessel: string, text: string) => void
  onStart: () => void
  onAbbrechen: () => void
}) {
  // Die Hilfetext-Id wird aus `useId` + Laufnummer gebaut, NICHT aus dem Schluessel.
  //
  // Der Schluessel ist ein Dateiname oder eine URL, und `aria-describedby` ist eine durch
  // LEERZEICHEN getrennte Liste von Ids: „Interview Mueller.mp3" zerfaellt darin in zwei
  // Referenzen, und beide zeigen ins Leere — gemessen. Die Begruendung, warum der Start
  // gesperrt ist, erreicht einen Screenreader-Nutzer dann gar nicht mehr (#244 durch eine
  // neue Tuer). `useId` deckt zugleich den zweiten Fall: Upload- und URL-Vorschau koennen
  // gleichzeitig offen stehen und haetten bei gleichem Schluessel dieselbe Id zweimal im
  // Dokument.
  const idBasis = useId()
  const wahl = (z: VorschauZeile) => sprecherWahl(z.sprecherText, sprecherMax)
  // EINE ungueltige Zeile sperrt den GANZEN Knopf — dieselbe Regel wie im Datei-Dialog.
  // Sonst liesse sich ueber eine gueltige Nachbarzeile starten, und die fehlerhafte Eingabe
  // ginge als „automatisch" durch, also als eine Entscheidung, die niemand getroffen hat.
  const gesperrt = !!laeuft || zeilen.some(z => wahl(z) === undefined)
  return (
    <div className="blatt p-4">
      <h3 className="mb-1 text-sm font-medium">{titel}</h3>
      <p className="mb-3 text-sm text-muted-foreground">
        Leer lassen heisst automatisch erkennen. Wer weiss, wie viele Personen gesprochen
        haben, trägt es hier ein — das trennt die Stimmen deutlich zuverlässiger, vor allem
        bei Aufnahmen mit einem Kameramikrofon.
      </p>
      <ul className="space-y-2">
        {zeilen.map((z, i) => {
          const w = wahl(z)
          const hilfeId = `${idBasis}-hilfe-${i}`
          return (
            <li key={z.schluessel} className="flex items-start gap-3">
              <span className="min-w-0 flex-1 truncate pt-2 text-sm" title={z.anzeige}>
                {z.anzeige}
              </span>
              <div className="w-40 shrink-0">
                {/* `type="text"`, NICHT `type="number"` — ein Datenverlust-Fix, keine
                    Geschmacksfrage (#264): bei einer ungueltigen Zwischeneingabe liefert ein
                    Zahlenfeld einen LEEREN value und zeigt dem Nutzer den getippten Text
                    trotzdem weiter an. Leer heisst hier „automatisch", die Zahl verschwaende
                    also still beim blossen Vertippen. `inputMode` holt die Ziffern-Tastatur
                    zurueck. */}
                <input type="text" inputMode="numeric"
                  aria-label={`Anzahl Sprecher für ${z.anzeige}`}
                  aria-describedby={w === undefined ? hilfeId : undefined}
                  aria-invalid={w === undefined || undefined}
                  value={z.sprecherText} disabled={laeuft}
                  onChange={e => onAendern(z.schluessel, e.target.value)}
                  placeholder="automatisch"
                  className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm
                             shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px]
                             focus-visible:ring-ring/50 aria-invalid:border-destructive
                             disabled:cursor-not-allowed disabled:opacity-50" />
                {/* Die Id wird nur vergeben, wenn der Text auch da ist: ein `aria-describedby`
                    auf eine nicht existierende Id ist fuer einen Screenreader stumm (#244). */}
                {w === undefined && (
                  <p id={hilfeId} className="mt-1 text-xs text-destructive">
                    Bitte eine ganze Zahl von 1 bis {sprecherMax} — oder leer lassen.
                  </p>
                )}
              </div>
            </li>
          )
        })}
      </ul>
      <div className="mt-4 flex justify-end gap-2">
        {/* Abbrechen ist waehrend des Laufs BEWUSST nicht gesperrt — es ist der einzige
            Rueckweg. `uploadAudio`/`fetchUrls` haben kein Zeitlimit (nur `getDoc` hat eines,
            mit genau dieser Begruendung im Kommentar daneben); haengt die Verbindung, bliebe
            `laeuft` fuer immer true. Mit gesperrtem Abbrechen waeren dann ALLE Bedienelemente
            tot, und der einzige Ausweg waere ein Neuladen — mitsamt Verlust der Auswahl und
            aller getippten Sprecherzahlen. Der Knopf raeumt nur lokalen Zustand auf; er
            bricht keine laufende Anfrage ab, aber er gibt die Oberflaeche zurueck. */}
        <Button variant="outline" onClick={onAbbrechen}>Abbrechen</Button>
        <Button onClick={onStart} disabled={gesperrt}>{startText}</Button>
      </div>
    </div>
  )
}
