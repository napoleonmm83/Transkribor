import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Ablageflaeche } from '@/components/Ablageflaeche'
import { HoerBalken } from '@/components/HoerBalken'
import { MaterialZeile } from '@/components/MaterialZeile'
import { alleGueltig, ergaenzen, sprachText, sprecherText,
         type Aufnahme } from '@/lib/materialZeilen'
import { sprecherWahl } from '@/lib/sprecher'
import { fetchUrls, uploadAudio } from '@/lib/api'
import type { StartJob } from '@/lib/types'

const SCHRITTE = ['Material wählen', 'Einstellen', 'Prüfen & starten']

/** Der Dialog „Material hinzufügen": drei waagrechte Schritte (H1), Sprache und
 *  Sprecherzahl je Aufnahme (L2/S1), ein Hörbalken unten (P1).
 *
 *  Der Zustand liegt hier und nicht in den Zeilen — das ist die Bedingung, unter der ein
 *  Schrittwechsel nichts verliert (Spec 6.3).
 */
export function MaterialDialog({ project, offen, vorbelegteDateien, sprachChoices,
                                 projektSprache, sprecherMax, onSchliessen, onFertig }: {
  project: string
  offen: boolean
  vorbelegteDateien?: File[]
  sprachChoices: { id: string; label: string; hint?: string }[]
  projektSprache: string
  sprecherMax: number
  onSchliessen: () => void
  onFertig: (job?: StartJob, art?: 'transcribe' | 'fetch') => void
}) {
  const [schritt, setSchritt] = useState(1)
  const [zeilen, setZeilen] = useState<Aufnahme[]>([])
  const [urlText, setUrlText] = useState('')
  const [quelle, setQuelle] = useState<'datei' | 'link'>('datei')
  const [laeuft, setLaeuft] = useState(false)
  const [klingt, setKlingt] = useState<string | null>(null)
  const laufNr = useRef(0)

  // Der Projektwechsel verwirft ALLES — auch den Schritt und den Abspieler. React Router
  // baut dieses Element beim Parameterwechsel nicht neu auf; ohne Reset landeten Projekt As
  // Dateien samt getippter Zahl in Projekt B, still und mit Erfolgsmeldung.
  // `laufNr.current++` gehoert HIERHER und nicht nur ins Abbrechen: sonst schreibt der
  // laufende Upload aus Projekt A sein Ergebnis in den Dialog von Projekt B.
  useEffect(() => {
    laufNr.current++
    setSchritt(1); setZeilen([]); setUrlText(''); setKlingt(null); setLaeuft(false)
  }, [project])

  // Vorbelegte Dateien kommen aus dem Drop-Overlay der Arbeitsflaeche. `ergaenzen` statt
  // `setZeilen`: ein zweiter Wurf auf denselben offenen Dialog haengt an, statt die schon
  // getippten Zahlen zu loeschen.
  useEffect(() => {
    if (vorbelegteDateien?.length) setZeilen(alt => ergaenzen(alt, vorbelegteDateien.map(zeileAus)))
  }, [vorbelegteDateien])

  function zeileAus(d: File): Aufnahme {
    return { schluessel: d.name, anzeige: d.name, sprecherText: '',
             sprache: projektSprache, datei: d }
  }

  const setzeSprecher = (schluessel: string, text: string) =>
    setZeilen(alt => alt.map(z => z.schluessel === schluessel ? { ...z, sprecherText: text } : z))
  const setzeSprache = (schluessel: string, id: string) =>
    setZeilen(alt => alt.map(z => z.schluessel === schluessel ? { ...z, sprache: id } : z))

  const urlsUebernehmen = () => {
    const neu = urlText.split('\n').map(u => u.trim()).filter(Boolean)
      .map(u => ({ schluessel: u, anzeige: u, sprecherText: '', sprache: projektSprache }))
    if (!neu.length) return
    setZeilen(alt => ergaenzen(alt, neu))
    setSchritt(2)
  }

  const starten = async () => {
    const meiner = ++laufNr.current
    setLaeuft(true); setKlingt(null)          // Ton hoert auf, BEVOR Zeilen verschwinden
    if (quelle === 'link') {
      // Die volle Liste, auch wenn alle gleich sind: sie ist index-parallel zu `urls` und
      // muss ihre Plaetze halten. `sprache` bleibt an Position 3 der Signatur.
      //
      // Der Platz wird mit `null` gehalten, NICHT mit dem Projektwert. Der Plan schrieb hier
      // `z.sprache` — damit bekaeme JEDE importierte Datei einen eigenen Eintrag in
      // `projekt.json`, auch wenn sie nur den Standard wiederholt, und zoege bei einer
      // spaeteren Aenderung des Projekt-Standards nicht mehr mit (#166/#234). `null` heisst
      // „nicht gesetzt" und haelt den Index trotzdem — dieselbe Rolle wie `''` beim Upload,
      // nur dass eine Liste kein Feld weglassen kann.
      const res = await fetchUrls(project, zeilen.map(z => z.schluessel),
                                  zeilen.map(z => z.sprache === projektSprache ? null : z.sprache),
                                  undefined,
                                  zeilen.map(z => sprecherWahl(z.sprecherText, sprecherMax) ?? null))
      if (meiner === laufNr.current) { setLaeuft(false); if (res.started) setZeilen([]) }
      onFertig(res, 'fetch'); return
    }
    const gescheitert: Aufnahme[] = []
    let job: StartJob | undefined
    for (const z of zeilen) {
      try {
        // `?? undefined`, NICHT `?? null`: leer heisst „Formfeld weglassen" (automatisch).
        const wahl = sprecherWahl(z.sprecherText, sprecherMax) ?? undefined
        // Die Sprache geht nur mit, wenn sie vom Projektwert ABWEICHT. Ein mitgeschickter
        // Wert, der ohnehin dem Projekt entspricht, machte daraus einen echten Override —
        // und die Datei zoege bei einer spaeteren Aenderung des Projekt-Standards nicht mehr
        // mit (#234/#166).
        const spr = z.sprache === projektSprache ? '' : z.sprache
        const r = await uploadAudio(project, z.datei!, spr, undefined, wahl)
        if (r.job_id) job = { job_id: r.job_id, started: !!r.started }
      } catch (e) {
        // „existiert bereits" ist KEIN wiederholbarer Fehlschlag — ein zweiter Versuch
        // endete wieder mit 409. Alles Stehenlassen liefe beim naechsten Klick in lauter 409er,
        // bedingungsloses Leeren waere Datenverlust.
        const grund = (e as Error)?.message
        if (!/existiert bereits/.test(grund ?? '')) {
          gescheitert.push(z)
          // Einen Grund nennen, auch wenn der Fehler keinen traegt: eine Zeile, die einfach
          // stehenbleibt, sieht aus wie ein vergessener Klick.
          toast.error(`${z.anzeige}: ${grund || 'Hinzufügen fehlgeschlagen'}`)
        }
      }
    }
    if (meiner === laufNr.current) {
      setLaeuft(false); setZeilen(gescheitert)
      // Zurueck in die Liste, wenn etwas stehenblieb: die Zusammenfassung zeigt nur Zahlen,
      // und der Nutzer muss SEHEN, welche Aufnahme es nicht geschafft hat, bevor er den
      // zweiten Versuch startet.
      if (gescheitert.length) setSchritt(2)
    }
    onFertig(job, 'transcribe')      // laeuft IMMER — der Workspace muss seine Liste nachziehen
  }

  if (!offen) return null

  const gueltig = alleGueltig(zeilen, sprecherMax)
  const klingende = zeilen.find(z => z.schluessel === klingt)
  const labels = Object.fromEntries(sprachChoices.map(c => [c.id, c.label]))
  // Der Hinweis erscheint NUR, wenn der Projekt-Standard ueberhaupt gewinnen kann. `auto`
  // ist die einzige id ohne Whisper-Code (`sprachen.py`), und der Satz waere sonst eine
  // Zusage ohne Gegenstand. Sollte je eine zweite solche id dazukommen, faellt es hier auf.
  const standardGreift = projektSprache !== 'auto'
  const autoDabei = zeilen.some(z => z.sprache === 'auto')

  return (
    <Dialog open={offen} onOpenChange={o => { if (!o) onSchliessen() }}>
      {/* min(480px, 70vh) fuer die Liste: fuer ein gegebenes Fenster eine KONSTANTE, der
          Rahmen springt beim Schrittwechsel also nicht (der Grund fuer H1s feste Hoehe) —
          und ohne den Abschnitt-Fall aus #283, den ein fester Pixelwert dort erzeugt. */}
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader><DialogTitle>Material hinzufügen</DialogTitle></DialogHeader>

        <ol className="flex items-center gap-2 text-xs text-muted-foreground">
          {SCHRITTE.map((s, i) => (
            <li key={s} aria-current={schritt === i + 1 ? 'step' : undefined}
              className={schritt === i + 1 ? 'font-medium text-foreground' : undefined}>
              {i + 1}. {s}{i < SCHRITTE.length - 1 ? ' ›' : ''}
            </li>
          ))}
        </ol>

        <div className="min-h-[min(480px,70vh)]">
          {schritt === 1 && (
            <div className="space-y-3">
              <div role="tablist" className="flex gap-1">
                {([['datei', 'Dateien'], ['link', 'Links']] as const).map(([id, text]) => (
                  <button key={id} type="button" role="tab" aria-selected={quelle === id}
                    onClick={() => setQuelle(id)}
                    className={quelle === id
                      ? 'rounded-md bg-accent px-3 py-1.5 text-sm font-medium'
                      : 'rounded-md px-3 py-1.5 text-sm text-muted-foreground'}>
                    {text}
                  </button>
                ))}
              </div>
              {quelle === 'datei'
                ? <Ablageflaeche gesperrt={laeuft}
                    onDateien={ds => setZeilen(alt => ergaenzen(alt, ds.map(zeileAus)))} />
                : (
                  <div className="space-y-2">
                    <Textarea aria-label="Video-URLs" rows={3} value={urlText}
                      onChange={e => setUrlText(e.target.value)}
                      placeholder="YouTube- oder Instagram-Reel-Links, eine URL pro Zeile" />
                    <Button type="button" onClick={urlsUebernehmen}>Holen</Button>
                  </div>
                )}
              {zeilen.length > 0 && (
                <p className="text-sm text-muted-foreground">
                  {zeilen.length} {zeilen.length === 1 ? 'Aufnahme' : 'Aufnahmen'} gewählt
                </p>
              )}
            </div>
          )}

          {schritt === 2 && (
            <div className="space-y-2">
              {/* `relative` ist Pflicht, nicht Kosmetik (#209): ein overflow-Behaelter klemmt
                  absolut positionierte Nachfahren nur, wenn er selbst ihr Bezugsrahmen ist —
                  sonst haengt sich ein `sr-only` an den Viewport und macht das DOKUMENT
                  scrollbar. Der Quellbaum-Waechter hat genau diese Zeile rot gemacht. */}
              <ul className="relative max-h-[min(400px,60vh)] space-y-1.5 overflow-y-auto pr-1">
                {zeilen.map(z => (
                  <MaterialZeile key={z.schluessel} zeile={z} sprachChoices={sprachChoices}
                    sprecherMax={sprecherMax} hoerbar={!!z.datei} klingt={klingt === z.schluessel}
                    gesperrt={laeuft} onSprecher={setzeSprecher} onSprache={setzeSprache}
                    onHoeren={s => setKlingt(a => a === s ? null : s)} />
                ))}
              </ul>
              <HoerBalken datei={klingende?.datei ?? null} anzeige={klingende?.anzeige ?? ''}
                onSchliessen={() => setKlingt(null)} />
            </div>
          )}

          {schritt === 3 && (
            <div className="space-y-1.5 text-sm">
              <p>{zeilen.length} {zeilen.length === 1 ? 'Aufnahme' : 'Aufnahmen'}</p>
              <p className="text-muted-foreground">Sprecher: {sprecherText(zeilen, sprecherMax)}</p>
              <p className="text-muted-foreground">Sprache: {sprachText(zeilen, labels)}</p>
              <p className="text-muted-foreground">
                Danach läuft die Transkription, dann die Korrektur — automatisch.
              </p>
              {autoDabei && (
                <p className="text-muted-foreground">
                  „Automatisch“: Whisper erkennt die Sprache selbst.
                  {standardGreift && ` Wird Deutsch erkannt, gilt der Projekt-Standard „${labels[projektSprache] ?? projektSprache}“.`}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2">
          {/* Abbrechen ist waehrend des Laufs NICHT gesperrt — es ist der einzige Rueckweg,
              und `uploadAudio`/`fetchUrls` haben kein Zeitlimit (#299). */}
          <Button variant="ghost" onClick={onSchliessen}>Abbrechen</Button>
          {schritt > 1 && (
            <Button variant="outline" disabled={laeuft}
              onClick={() => setSchritt(s => s - 1)}>Zurück</Button>
          )}
          {schritt < 3 && (
            <Button disabled={!zeilen.length || !gueltig || laeuft}
              onClick={() => setSchritt(s => s + 1)}>Weiter</Button>
          )}
          {schritt === 3 && (
            <Button disabled={laeuft || !zeilen.length} onClick={starten}>
              {laeuft ? 'startet…' : 'Los geht’s'}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
