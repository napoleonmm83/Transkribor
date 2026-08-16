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

/** Sprache + Korrektur-Tiefe EINER bereits liegenden Datei. Spiegelt
 *  `ProjektEinstellungenDialog`, ergänzt den kontext-abhängigen Hinweis und den dynamischen
 *  Knopf-Text. Der Dialog schreibt NUR den Override (`saveFileEinstellungen`); welche
 *  Neuberechnung nötig ist, entscheidet der Aufrufer via `onGespeichert` — denn die Job-Hooks
 *  (Adoption, Editor-Reload) hängen in `DateiMenue`.
 *
 *  Verzweigung (Spec #135): Sprache-Änderung + has_raw -> Neu-Transkription (dominiert, zieht
 *  die Korrektur nach); nur Tiefe + has_raw -> Neu-Korrektur; !has_raw -> nur Override. */

/** Der Platzhalter für „kein eigener Wert" in der Sprachauswahl. Radix' `Select` verlangt einen
 *  nicht-leeren `value` und kennt kein `null`; die Übersetzung in beide Richtungen passiert an
 *  genau zwei Stellen (Anzeige und `onValueChange`). Ein doppelter Unterstrich, damit er nie mit
 *  einem echten Sprach-Kürzel kollidiert (`ch`/`de`/`en`/`fr`/`it`/`auto`, siehe `sprachen.py`). */
const ERBT = '__projekt'
export function DateiEinstellungenDialog({ project, base, file, offen, onOpenChange, onGespeichert }: {
  project: string
  base: string
  file: ProjectFile
  offen?: boolean
  onOpenChange?: (o: boolean) => void
  /** `neuTranskribieren` heisst nicht mehr „Sprache geändert“: auch der Mehrsprachig-Haken
   *  landet hier, weil er dieselbe Folge hat (der Decoder läuft anders, das alte Transkript
   *  ist hin). Ein Feld, das nur die halbe Ursache benennt, führt den nächsten Leser in die Irre. */
  onGespeichert?: (a: { neuTranskribieren: boolean; tiefeGeaendert: boolean }) => void
}) {
  const [data, setData] = useState<DateiEinstellungen | null>(null)
  // Der Datei-Override, NICHT der effektive Wert — `null` heisst „folgt dem Projekt" (#234),
  // genau wie bei `mehrWahl` darunter.
  const [sprachWahl, setSprachWahl] = useState<string | null>(null)
  const [korrektur, setKorrektur] = useState('')
  // Der Datei-Override, NICHT der effektive Wert: `null` heisst „folgt dem Projekt" (#166).
  const [mehrWahl, setMehrWahl] = useState<MehrWahl>(null)
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
        setData(d); setSprachWahl(d.sprache_eigen); setKorrektur(d.korrektur)
        setMehrWahl(d.mehrsprachig_eigen)
      })
      .catch(e => { if (aktiv) toast.error(`Einstellungen laden fehlgeschlagen: ${(e as Error).message}`) })
      .finally(() => { if (aktiv) setLaedt(false) })
    return () => { aktiv = false }
  }, [offen, project, base])

  const tiefeGeaendert = !!data && korrektur !== data.korrektur
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
  const geaendert = neuTranskribieren || tiefeGeaendert || overrideGeaendert
  // Neu-Transkription dominiert (sie deckt die Tiefe über die Autokorrektur-Kette ab).
  //
  // Geprüft wird hier NICHT `geaendert`: seit #166 zählt auch ein reiner Override-Wechsel als
  // Änderung (von „ja" auf „folgt dem Projekt (ja)"), und der ändert weder Transkript noch
  // Korrektur. Über `geaendert` liefe dieser Fall in den `correct`-Zweig — eine Neu-Korrektur
  // mit `force`, also quer über eine handbearbeitete Fassung, für eine Aufräumaktion.
  const trigger = file.has_raw && (neuTranskribieren || tiefeGeaendert)
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
                       : 'Die Korrektur wird mit der neuen Tiefe neu erstellt.')
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
        { sprache: sprachWahl, korrektur, mehrsprachig: mehrWahl })
      onGespeichert?.({ neuTranskribieren, tiefeGeaendert })
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
          <DialogTitle>Sprache &amp; Korrektur-Tiefe — „{base}“</DialogTitle>
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
