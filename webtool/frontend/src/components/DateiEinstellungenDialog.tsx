import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { getFileEinstellungen, saveFileEinstellungen } from '@/lib/api'
import type { DateiEinstellungen, ProjectFile } from '@/lib/types'
import { MehrsprachigWahl, type MehrWahl } from '@/components/MehrsprachigKasten'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'

/** Sprache, Korrektur-Tiefe und Sprecherzahl EINER bereits liegenden Datei. Spiegelt
 *  `ProjektEinstellungenDialog`, ergänzt den kontext-abhängigen Hinweis und den dynamischen
 *  Knopf-Text. Der Dialog schreibt NUR den Override (`saveFileEinstellungen`); welche
 *  Neuberechnung nötig ist, entscheidet der Aufrufer via `onGespeichert` — denn die Job-Hooks
 *  (Adoption, Editor-Reload) hängen in `DateiMenue`.
 *
 *  Verzweigung (Spec #135): Sprache-Änderung + has_raw -> Neu-Transkription (dominiert, zieht
 *  die Korrektur nach); nur Tiefe ODER Sprecherzahl + has_raw -> Neu-Korrektur (die Diarisierung
 *  ist ein Prep-Schritt von `correct run`); !has_raw -> nur Override. */

/** Der Platzhalter für „kein eigener Wert" in der Sprachauswahl.
 *
 *  **Nicht, weil Radix etwas erzwingt** — `@radix-ui/react-select@2.3.7` wirft nirgends (in der
 *  installierten Fassung nachgesehen: kein einziges `throw`). Sondern weil `""` dort schon
 *  BELEGT ist: `shouldShowPlaceholder(value)` behandelt es als „keine Auswahl" und zeigt den
 *  Platzhalter, der Trigger stünde also leer da statt „Folgt dem Projekt (…)" zu sagen. Und
 *  `onValueChange` liefert grundsätzlich einen String, `null` kann gar nicht zurückkommen.
 *  Die Übersetzung in beide Richtungen passiert deshalb an genau zwei Stellen (Anzeige und
 *  `onValueChange`). Ein doppelter Unterstrich, damit er nie mit einem echten Sprach-Kürzel
 *  kollidiert (`ch`/`de`/`en`/`fr`/`it`/`auto`, siehe `sprachen.py`). */
const ERBT = '__projekt'
export function DateiEinstellungenDialog({ project, base, file, offen, onOpenChange, onGespeichert }: {
  project: string
  base: string
  file: ProjectFile
  offen?: boolean
  onOpenChange?: (o: boolean) => void
  /** `neuTranskribieren` heisst nicht mehr „Sprache geändert“: auch der Mehrsprachig-Haken
   *  landet hier, weil er dieselbe Folge hat (der Decoder läuft anders, das alte Transkript
   *  ist hin). Ein Feld, das nur die halbe Ursache benennt, führt den nächsten Leser in die Irre.
   *  Aus demselben Grund heisst `neuKorrigieren` nicht mehr `tiefeGeaendert`: die Sprecherzahl
   *  loest denselben Zweig aus (die Diarisierung ist ein Prep-Schritt des `correct`-Laufs). */
  onGespeichert?: (a: { neuTranskribieren: boolean; neuKorrigieren: boolean }) => void
}) {
  const [data, setData] = useState<DateiEinstellungen | null>(null)
  // Der Datei-Override, NICHT der effektive Wert — `null` heisst „folgt dem Projekt" (#234),
  // genau wie bei `mehrWahl` darunter.
  const [sprachWahl, setSprachWahl] = useState<string | null>(null)
  const [korrektur, setKorrektur] = useState('')
  // Der Datei-Override, NICHT der effektive Wert: `null` heisst „folgt dem Projekt" (#166).
  const [mehrWahl, setMehrWahl] = useState<MehrWahl>(null)
  // Als STRING, nicht als Zahl: ein `<input type="number">` hat Zwischenzustaende, die keine
  // Zahl sind („" beim Leeren, "-" beim Tippen). Ueber `Number()` gefuehrt wuerde das Feld
  // beim Leeren auf 0 springen und liesse sich nicht mehr zuruecksetzen. Die Uebersetzung
  // passiert an genau einer Stelle (`sprecherWahl`) — dieselbe Trennung wie bei `ERBT`.
  const [sprecherText, setSprecherText] = useState('')
  const [laedt, setLaedt] = useState(false)
  const [speichert, setSpeichert] = useState(false)

  useEffect(() => {
    if (!offen) return
    let aktiv = true
    // Beim Öffnen zurücksetzen, nicht nur nachladen: sonst stünde nach „Abbrechen" + einem
    // fehlgeschlagenen GET das Formular des VORIGEN Aufrufs bedienbar da — mit `data` aus dem
    // alten Stand, aber ohne Bezug zur jetzt geöffneten Datei.
    setData(null)
    setLaedt(true)
    getFileEinstellungen(project, base)
      .then(d => {
        if (!aktiv) return
        // `|| null`, nicht bloss zuweisen: ein Alt-Eintrag `"sprache": ""` kommt als leerer
        // String an (`datei_ansicht` reicht ihn bewusst durch — es IST ein Eintrag, den es zu
        // entfernen gibt). Im Dialog machte er drei Dinge kaputt: Radix zeigt bei `value=""`
        // seinen Platzhalter, der Waehler stuende also LEER da; `"" ?? projekt` bleibt `""`
        // (`??` greift nur bei null/undefined), womit `neuTranskribieren` ohne jede Nutzeraktion
        // wahr waere; und ein Klick schickte `{sprache: ""}` in ein 400 von `pruef_fehler`.
        // Mit `null` zeigt er „Folgt dem Projekt (…)", der Speichern-Knopf ist scharf (es gibt
        // ja etwas aufzuraeumen) und raeumt den Eintrag beim Speichern weg.
        setData(d); setSprachWahl(d.sprache_eigen || null); setKorrektur(d.korrektur)
        setMehrWahl(d.mehrsprachig_eigen)
        // `?? ''` statt nur der null-Pruefung: fehlt das Feld in der Antwort, stuende sonst
        // der String "undefined" im Zustand — das Feld saehe leer aus, waere aber ungueltig,
        // der Knopf dauerhaft grau und Leeren unmoeglich (kein onChange raeumt es weg).
        setSprecherText(d.sprecher == null ? '' : String(d.sprecher))
      })
      .catch(e => { if (aktiv) toast.error(`Einstellungen laden fehlgeschlagen: ${(e as Error).message}`) })
      .finally(() => { if (aktiv) setLaedt(false) })
    return () => { aktiv = false }
  }, [offen, project, base])

  // Leer -> `null` („automatisch schaetzen lassen"). Alles andere muss eine ganze Zahl im
  // erlaubten Bereich sein, sonst gilt die Eingabe als ungueltig (`undefined`) und der
  // Speichern-Knopf bleibt grau — sie ungeprueft zu schicken hiesse, den Nutzer den 400er
  // des Servers lesen zu lassen, obwohl das Feld die Regel kennt.
  const sprecherMax = data?.sprecher_max ?? 20
  const sprecherWahl: number | null | undefined =
    sprecherText.trim() === '' ? null
    : /^\d+$/.test(sprecherText.trim())
      && +sprecherText >= 1 && +sprecherText <= sprecherMax ? +sprecherText
    : undefined
  // `=== false` statt `!…`: der Typ sagt „Pflichtfeld", aber der Typ ist der VERTRAG, nicht
  // die Garantie — Server und Bundle sind getrennt, ein aelterer Server liefert `undefined`.
  // Das muss „laeuft" heissen: der Rueckfall geht zum bisherigen Verhalten, nicht in eine
  // Sperre, die niemand aufheben kann.
  const diarAus = data?.diarisierung_aktiv === false
  const sprecherGeaendert = !!data && sprecherWahl !== undefined && sprecherWahl !== data.sprecher
  const tiefeGeaendert = !!data && korrektur !== data.korrektur
  // Beides zieht denselben Lauf nach sich: die Diarisierung ist ein Prep-Schritt von
  // `correct run`, eine neue Sprecherzahl wirkt also ueber genau denselben Weg wie eine
  // neue Tiefe. Ein zweiter Zweig waere ein zweiter Name fuer denselben Job.
  const neuKorrigieren = tiefeGeaendert || sprecherGeaendert
  // Was die Transkription TATSAECHLICH nehmen wuerde — „folgt dem Projekt" ist der Projektwert.
  const mehrEffektiv = !data ? false : mehrWahl === null ? data.mehrsprachig_projekt : mehrWahl
  const sprachEffektiv = !data ? '' : sprachWahl ?? data.sprache_projekt
  // Der Haken zaehlt wie ein Sprachwechsel: er schaltet multilingual + condition_on_previous_text
  // um, ein vorhandenes Transkript ist danach nach anderen Regeln entstanden. Verglichen wird
  // deshalb bei BEIDEN der EFFEKTIVE Wert: von „Deutsch" auf „folgt dem Projekt (Deutsch)"
  // umzustellen aendert den Override, aber nicht das Ergebnis — eine Neu-Transkription waere
  // dort reine Rechenzeit (bei der Sprache ein kompletter Whisper-Lauf, #234).
  const neuTranskribieren = !!data
    && (sprachEffektiv !== data.sprache || mehrEffektiv !== data.mehrsprachig)
  // ... gespeichert werden muss so ein Wechsel trotzdem, sonst faende der Nutzer den Rueckweg
  // vor und der Knopf bliebe grau.
  const overrideGeaendert = !!data
    && (mehrWahl !== data.mehrsprachig_eigen || sprachWahl !== data.sprache_eigen)
  // Der Projektwert AUSGESCHRIEBEN, nicht als Kuerzel: „Folgt dem Projekt (ch)" beantwortet die
  // Frage nicht, die jemand hier stellt. Faellt auf das Kuerzel zurueck, falls die Liste den
  // Wert nicht kennt (eine vor einer Validierung geschriebene Altlast, #139).
  const projektSprachLabel = !data ? ''
    : data.sprach_choices.find(c => c.id === data.sprache_projekt)?.label ?? data.sprache_projekt
  // Eine ungueltige Sprecherzahl sperrt den GANZEN Knopf, nicht nur ihren eigenen Zweig.
  // Sonst liesse sich ueber eine andere Aenderung (Sprache, Tiefe) speichern, und das
  // `sprecherWahl ?? null` im Rumpf loeschte dabei STILL die vorhandene Zahl — der Nutzer
  // wollte sie korrigieren und haette sie verloren.
  const geaendert = (neuTranskribieren || neuKorrigieren || overrideGeaendert)
    && sprecherWahl !== undefined
  // Neu-Transkription dominiert (sie deckt die Tiefe über die Autokorrektur-Kette ab).
  //
  // Geprüft wird hier NICHT `geaendert`: seit #166 zählt auch ein reiner Override-Wechsel als
  // Änderung (von „ja" auf „folgt dem Projekt (ja)"), und der ändert weder Transkript noch
  // Korrektur. Über `geaendert` liefe dieser Fall in den `correct`-Zweig — eine Neu-Korrektur
  // mit `force`, also quer über eine handbearbeitete Fassung, für eine Aufräumaktion.
  const trigger = file.has_raw && (neuTranskribieren || neuKorrigieren)
    ? (neuTranskribieren ? 'transcribe' : 'correct')
    : 'none'

  const knopf =
    trigger === 'transcribe' ? 'Speichern & neu transkribieren'
    : trigger === 'correct' ? 'Speichern & neu korrigieren'
    : 'Speichern'

  const hinweis =
    !file.has_raw ? 'Wird bei der nächsten Transkription verwendet.'
    : trigger === 'transcribe'
      // „Die Änderung“, nicht „Neue Sprache“: der Mehrsprachig-Haken loest denselben Zweig aus.
      ? `Die Änderung erfordert eine Neu-Transkription: Transkript, Korrektur und Export werden verworfen (Audio bleibt)${file.has_edit ? ', inkl. der handbearbeiteten Fassung' : ''}.`
    : trigger === 'correct'
      ? (file.has_edit ? 'Die handbearbeitete Fassung wird überschrieben.'
                       // „Die Korrektur“, nicht „mit der neuen Tiefe“: der Zweig traegt seit
                       // der Sprecherzahl zwei Ursachen, und die Zeile nannte nur eine.
                       : 'Die Korrektur wird neu erstellt.')
    : ''

  const speichernFn = async () => {
    if (!geaendert) return
    setSpeichert(true)
    try {
      // `sprache: null` / `mehrsprachig: null` sind hier AUSDRUECKLICH gemeint (Override
      // entfernen) und muessen im JSON landen — `undefined` wuerde von JSON.stringify
      // weggeworfen und hiesse „nicht anfassen". Genau dieser Unterschied ist der Rueckweg
      // (#166 fuer den Haken, #234 fuer die Sprache).
      await saveFileEinstellungen(project, base,
        { sprache: sprachWahl, korrektur, mehrsprachig: mehrWahl, sprecher: sprecherWahl ?? null })
      onGespeichert?.({ neuTranskribieren, neuKorrigieren })
      onOpenChange?.(false)
    } catch (e) {
      toast.error(`Speichern fehlgeschlagen: ${(e as Error).message}`)
    } finally {
      setSpeichert(false)
    }
  }

  return (
    <Dialog open={offen} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sprache, Korrektur &amp; Sprecher — „{base}“</DialogTitle>
        </DialogHeader>
        {laedt ? (
          <p className="text-sm text-muted-foreground">Laden …</p>
        ) : data && (
          <div className="grid gap-4">
            <div>
              <label id="lbl-fs-sprache" className="mb-1.5 block text-sm font-medium">Sprache</label>
              {/* `ERBT` ist ein Platzhalterwert, kein Sprach-Kuerzel: Radix laesst einen leeren
                  `value` nicht zu, und `null` kann ein Select nicht tragen. Er wird beim Lesen
                  und beim Schreiben wieder in `null` uebersetzt — im Zustand steht nie etwas
                  anderes als „ein Kuerzel oder null". */}
              <Select value={sprachWahl ?? ERBT}
                      onValueChange={v => setSprachWahl(v === ERBT ? null : v)}>
                <SelectTrigger className="w-full" aria-labelledby="lbl-fs-sprache"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ERBT}>Folgt dem Projekt ({projektSprachLabel})</SelectItem>
                  {data.sprach_choices.map(c => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.label}{c.hint && ` — ${c.hint}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label id="lbl-fs-tiefe" className="mb-1.5 block text-sm font-medium">Korrektur-Tiefe</label>
              <Select value={korrektur} onValueChange={setKorrektur}>
                <SelectTrigger className="w-full" aria-labelledby="lbl-fs-tiefe"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {data.tiefen.map(t => (
                    <SelectItem key={t.id} value={t.id}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <MehrsprachigWahl wert={mehrWahl} setzen={setMehrWahl}
              projektwert={data.mehrsprachig_projekt} id="mehr-datei" />
            <div>
              <label htmlFor="fs-sprecher" className="mb-1.5 block text-sm font-medium">
                Anzahl Sprecher
              </label>
              {/* Freies Feld statt eines Wählers: ein Select mit zwanzig Einträgen wäre eine
                  Liste, in der man sucht statt tippt.

                  **`type="text"`, NICHT `type="number"` — und das ist ein Datenverlust-Fix,
                  keine Geschmacksfrage.** Bei einem Zahlenfeld liefert der Browser für eine
                  ungültige Zwischeneingabe einen LEEREN `value` (`validity.badInput`), während
                  er dem Nutzer den getippten Text weiter anzeigt. Gemessen: „5" dann „e" ⇒
                  `{value: "", badInput: true}`. Dieser Dialog liest leer als „automatisch",
                  hätte den Speichern-Knopf also scharf gemacht und die vorhandene Sprecherzahl
                  STILL gelöscht — beim blossen Vertippen, mit „Speichern & neu korrigieren"
                  auf dem Knopf. Als Textfeld kommt „5e" durch, `sprecherWahl` erkennt es als
                  ungültig und sperrt. `inputMode` holt die Ziffern-Tastatur zurück; die
                  Spinner-Pfeile entfallen bewusst — sie sind der Preis dafür, dass die
                  Eingabe des Nutzers nicht hinter seinem Rücken verschwindet.

                  **`readOnly` + `aria-disabled` statt `disabled`** — der Unterschied zwischen
                  halb und ganz behoben (#266). Ein `disabled`-Feld ist NICHT fokussierbar: wer
                  den Dialog mit Tab durchgeht, springt daran vorbei, und `aria-describedby`
                  wird nie vorgelesen — ausgerechnet die Zeile, die #266 überhaupt ausmacht
                  („warum kann ich die Zahl nicht setzen?"). So bleibt das Feld erreichbar, die
                  Begründung hörbar, und Eingaben sind trotzdem gesperrt. Die Ausgrauung hängt
                  deshalb an `aria-disabled:`, nicht an `disabled:`. */}
              <input id="fs-sprecher" type="text" inputMode="numeric"
                value={sprecherText}
                onChange={e => setSprecherText(e.target.value)}
                readOnly={diarAus}
                aria-disabled={diarAus || undefined}
                aria-describedby="fs-sprecher-hilfe"
                aria-invalid={sprecherWahl === undefined || undefined}
                placeholder="automatisch"
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm
                           shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px]
                           focus-visible:ring-ring/50 aria-invalid:border-destructive
                           aria-disabled:cursor-not-allowed aria-disabled:opacity-50" />
              <p id="fs-sprecher-hilfe" className="mt-1.5 text-sm text-muted-foreground">
                {diarAus
                  // Die Zeile nennt die Variable beim Namen, statt „die Sprechertrennung
                  // funktioniert nicht" zu behaupten: der Server weiss nur, dass der
                  // Kill-Switch gesetzt ist — ob pyannote laufen WUERDE, sagt er nicht (#270).
                  // Ohne `=0`: `diarize_enabled` akzeptiert auch `false` und `no`, ein
                  // konkreter Wert waere also fuer zwei von drei Faellen falsch.
                  ? 'Die Sprechertrennung ist auf diesem Server abgeschaltet '
                    + '(Umgebungsvariable TRANSKRIBOR_DIARIZE) — die Zahl hätte hier '
                    + 'keine Wirkung.'
                  : sprecherWahl === undefined
                  ? `Bitte eine ganze Zahl von 1 bis ${sprecherMax} eintragen — oder leer lassen.`
                  : 'Leer lassen heisst automatisch erkennen. Wer weiss, wie viele Personen '
                    + 'gesprochen haben, trägt es hier ein — das trennt die Stimmen deutlich '
                    + 'zuverlässiger, vor allem bei Aufnahmen mit einem Kameramikrofon.'}
              </p>
            </div>
            {hinweis && <p className="text-sm text-muted-foreground">{hinweis}</p>}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange?.(false)} disabled={speichert}>Abbrechen</Button>
          <Button onClick={speichernFn} disabled={!data || speichert || !geaendert}>{knopf}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
