import { useEffect, useRef, useState } from 'react'
import { Check, Loader2, TriangleAlert, Upload } from 'lucide-react'
import { uploadAudio } from '@/lib/api'
import { sprecherWahl } from '@/lib/sprecher'
import { cn } from '@/lib/utils'
import { MaterialVorschau, type VorschauZeile } from '@/components/MaterialVorschau'
import type { StartJob } from '@/lib/types'

const AUDIO_RE = /\.(mp3|wav|m4a|aac|flac|ogg|opus|wma|mp4)$/i
type Status = 'uploading' | 'done' | 'exists' | 'error'
type Item = { name: string; status: Status; msg?: string }

/** Eine gewaehlte Datei samt ihrer Sprecherzahl.
 *
 *  Die Datei wohnt IN der Zeile — es gibt keine zwei parallelen Listen (Files hier, Texte
 *  dort), die auseinanderlaufen koennten. Genau dort landete sonst die 5 des Teamgespraechs
 *  beim 2er-Interview, und zwar still.
 */
type UploadZeile = VorschauZeile & { datei: File }

export function UploadDropzone({ project, onDone, sprache = '', mehrsprachig,
                                 sprecherMax = 20 }: {
  project: string
  onDone?: (job?: StartJob) => void
  /** Obergrenze aus `sprecher_max` (Server). Der Rueckfall deckt einen aelteren Server —
   *  dieselbe Richtung wie bei `diarisierung_aktiv`: die Oberflaeche darf nicht in eine
   *  Sperre laufen, die niemand aufheben kann. */
  sprecherMax?: number
  // Die Sprachauswahl steht EINMAL im Bereich „Material hinzufügen" (ProjectWorkspace) und
  // gilt fuer Upload UND URL-Import — hier kommen nur noch die Werte an, die der Upload
  // mitschickt. sprache='' wirkt wie „nicht gesetzt": die API-Funktionen ignorieren einen
  // leeren String (if sprache).
  sprache?: string
  /** undefined = kein Datei-Override (der Projektwert gilt); den Fall entscheidet der Aufrufer. */
  mehrsprachig?: boolean
}) {
  const [items, setItems] = useState<Item[]>([])
  const [over, setOver] = useState(false)
  const [auswahl, setAuswahl] = useState<UploadZeile[]>([])
  const [laeuft, setLaeuft] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  // Laufnummer, damit ein abgebrochener Lauf die Oberflaeche nicht mehr anfasst.
  //
  // Das ist die Antwort auf „was erlaubt der Abbrechen-Fix NEU?": ein Klick auf Abbrechen
  // raeumt die Vorschau, die laufenden Anfragen laufen aber weiter — und ihr Ende setzte
  // danach `setAuswahl(gescheitert)`, womit die verworfene Auswahl WIEDERKAM (gemessen: nach
  // Abbrechen 0 Zeilen, nach dem Fehlschlag wieder 1). Dasselbe Muster wie `fassung` in
  // `useDoc`: wer nicht mehr der aktuelle Lauf ist, schreibt nicht mehr.
  const laufNr = useRef(0)

  // Die Auswahl gehoert dem Projekt, in dem sie getroffen wurde. React Router baut die Seite
  // beim Wechsel des Routenparameters NICHT neu auf — ohne diesen Reset landeten die fuer
  // Projekt A gewaehlten Dateien samt eingetippter Sprecherzahl in Projekt B, still und mit
  // Erfolgsmeldung. Dasselbe Muster, wegen dem `ProjectWorkspace` `sprache` zuruecksetzt
  // (frontend/CLAUDE.md); hier wiegt es schwerer, weil ganze Dateien mitwandern.
  // `laufNr.current++` gehoert HIERHER, nicht nur ins Abbrechen: sonst leert der Wechsel zwar
  // die Auswahl, der laufende Upload aus Projekt A schreibt sein Ergebnis danach aber in die
  // Vorschau von Projekt B — und ein erneuter Start laedt As Dateien nach B. Gemessen (0
  // Zeilen nach dem Wechsel, wieder 1 nach dem Fehlschlag). Das ist derselbe BLOCKER, den der
  // Plan-Review schon einmal fand, zurueck durch die Tuer der eigenen Reparatur.
  useEffect(() => { laufNr.current++; setAuswahl([]); setItems([]) }, [project])

  const patch = (name: string, p: Partial<Item>) =>
    setItems(prev => prev.map(it => it.name === name ? { ...it, ...p } : it))

  /** Auswahl (Klick oder Drop) — ERGAENZT die Vorschau, ersetzt sie nicht.
   *
   *  Wer eine vergessene Aufnahme nachlegt, darf die schon getippten Zahlen nicht verlieren;
   *  Dubletten werden am Dateinamen erkannt und uebersprungen (der Server kollidiert bei
   *  gleichem Basisnamen ohnehin mit 409).
   */
  const waehlen = (files: File[]) => {
    // Waehrend eines Laufs keine neue Auswahl annehmen — symmetrisch zu `UrlFetch`, wo
    // Textfeld und Knopf ohnehin gesperrt sind. Sonst landeten neue Zeilen in der Vorschau,
    // der Nutzer traegt eine Zahl ein, und `setAuswahl(gescheitert)` am Ende des laufenden
    // Uploads wirft sie ersatzlos weg (kein funktionales Update — es ersetzt den Zustand).
    // Genau die Datenverlust-Klasse, gegen die die „nur Gescheiterte bleiben"-Regel gebaut
    // ist, durch eine Tuer, die sie nicht bedacht hatte.
    if (laeuft) return
    const audio = files.filter(f => AUDIO_RE.test(f.name))
    if (!audio.length) return
    setAuswahl(alt => {
      // `bekannt` waechst WAEHREND des Filterns mit — sonst deckt der Schutz nur gegen
      // fruehere Zeilen, nicht gegen Dubletten in DERSELBEN Auswahl. Zwei gleichnamige
      // Dateien aus verschiedenen Ordnern (Mehrfachauswahl) ergaeben sonst zwei Zeilen mit
      // demselben Schluessel: React-`key`-Kollision, `onAendern` traefe beide gleichzeitig,
      // und beim Start kollidierte die zweite serverseitig mit 409 — eine der beiden
      // Aufnahmen waere faktisch verloren. Gemessen, bevor es gefixt wurde.
      const bekannt = new Set(alt.map(z => z.schluessel))
      const neu: UploadZeile[] = []
      for (const f of audio) {
        if (bekannt.has(f.name)) continue
        bekannt.add(f.name)
        neu.push({ schluessel: f.name, anzeige: f.name, sprecherText: '', datei: f })
      }
      return [...alt, ...neu]
    })
  }

  const abbrechen = () => { laufNr.current++; setLaeuft(false); setAuswahl([]) }

  const upload = async (zeilen: UploadZeile[]) => {
    const audio = zeilen.map(z => z.datei)
    if (!audio.length) return
    const meiner = ++laufNr.current
    setLaeuft(true)
    setItems(audio.map(f => ({ name: f.name, status: 'uploading' as Status })))
    // Jeder Upload stoesst serverseitig die Transkription an; der Job ist fuer alle derselbe
    // (Dedupe je Projekt+Art), also reicht die zuletzt gemeldete Job-ID zum Adoptieren.
    let job: StartJob | undefined
    // ponytail: sequentiell statt Pool — lokale Uploads sind quasi instant; Pool nachruesten bei Bedarf
    const gescheitert: UploadZeile[] = []
    for (const z of zeilen) {
      try {
        // `?? undefined`, NICHT `?? null`: leer heisst „Feld weglassen" (automatisch). Ein
        // mitgeschicktes 0 wiese der Server mit 400 zurueck, ein null waere eine Zahl.
        const wahl = sprecherWahl(z.sprecherText, sprecherMax) ?? undefined
        const r = await uploadAudio(project, z.datei, sprache, mehrsprachig, wahl)
        if (r.job_id) job = { job_id: r.job_id, started: !!r.started }
        patch(z.datei.name, { status: 'done' })
      }
      catch (e) {
        const msg = (e as Error).message
        const schon_da = /existiert bereits/.test(msg)
        patch(z.datei.name, { status: schon_da ? 'exists' : 'error', msg })
        // „existiert bereits" ist KEIN Fehlschlag zum Wiederholen — die Aufnahme ist da, ein
        // zweiter Versuch endet wieder mit 409. Alles andere schon (Netz weg, Server neu).
        if (!schon_da) gescheitert.push(z)
      }
    }
    // Erst NACH der Schleife: eine Datei, die scheitert, nimmt die anderen nicht mit.
    //
    // Und stehen bleiben nur die GESCHEITERTEN — das ist die Antwort auf „was erlaubt der
    // Umbau NEU?". Vorher konnte hier keine getippte Arbeit verlorengehen, weil es keine gab;
    // seit der Vorschau steht in jeder Zeile eine von Hand eingetragene Sprecherzahl. Ein
    // bedingungsloses `setAuswahl([])` warf sie bei einem Serverfehler alle weg, und der
    // Nutzer haette Dateien UND Zahlen neu eintragen muessen. Die erfolgreichen verschwinden
    // trotzdem, sonst liefe der naechste Klick in lauter 409er. `UrlFetch` haelt es an
    // derselben Stelle genauso (`if (res.started)`).
    // `onDone` laeuft IMMER — auch nach einem Abbruch koennen Dateien beim Server angekommen
    // sein, und der Workspace muss seine Liste nachziehen. Nur die Oberflaeche dieses
    // Bauteils fasst ein ueberholter Lauf nicht mehr an.
    if (meiner === laufNr.current) {
      setLaeuft(false)
      setAuswahl(gescheitert)
    }
    onDone?.(job)
  }

  return (
    <div>
      <div
        role="button" tabIndex={0} aria-label="Audio hochladen"
        onClick={() => { if (!laeuft) inputRef.current?.click() }}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click() } }}
        onDragOver={e => { e.preventDefault(); if (!laeuft) setOver(true) }}
        onDragLeave={() => setOver(false)}
        onDrop={e => { e.preventDefault(); setOver(false); waehlen(Array.from(e.dataTransfer.files)) }}
        // blatt = dieselbe Flaeche wie die Dateiliste darunter; nur die Kante ist gestrichelt,
        // weil das die Konvention fuer "hier ablegen" ist. Vorher: eigener 4px-Radius und
        // kein Kartenuntergrund — zwei Kaesten uebereinander, die sichtbar nicht zusammengehoerten.
        // Fokusring explizit: die Flaeche ist ein div mit tabIndex, bekaeme also nur den
        // Standardring des Browsers. Jedes andere Bedienelement hier traegt denselben
        // ring-2 — ohne ihn faellt ausgerechnet die groesste Klickflaeche aus der Reihe.
        className={cn('blatt blatt-klickbar flex cursor-pointer items-center justify-center gap-2 border-dashed p-6 text-sm text-muted-foreground',
          'outline-none focus-visible:ring-2 focus-visible:ring-ring',
          over && 'border-primary bg-accent text-accent-foreground')}
      >
        <div className="text-center">
          <div className="flex items-center justify-center gap-2"><Upload className="size-4" /> Audio hierher ziehen oder klicken</div>
          <div className="mt-1 text-xs">Du kannst pro Aufnahme die Anzahl Sprecher angeben; danach starten Transkription und Korrektur automatisch.</div>
        </div>
      </div>
      <input ref={inputRef} data-testid="upload-input" type="file" hidden multiple
        accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.wma,.mp4"
        onChange={e => { waehlen(Array.from(e.target.files ?? [])); e.target.value = '' }} />
      {auswahl.length > 0 && (
        <div className="mt-3">
          <MaterialVorschau
            titel={`${auswahl.length} ${auswahl.length === 1 ? 'Aufnahme' : 'Aufnahmen'} gewählt`}
            zeilen={auswahl} sprecherMax={sprecherMax} laeuft={laeuft}
            startText="Hinzufügen & starten"
            onAendern={(k, t) => setAuswahl(alt => alt.map(z =>
              z.schluessel === k ? { ...z, sprecherText: t } : z))}
            onStart={() => upload(auswahl)}
            onAbbrechen={abbrechen} />
        </div>
      )}
      {items.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs">
          {items.map(it => (
            <li key={it.name} className="flex items-center justify-between gap-2">
              <span className="min-w-0 flex-1 truncate">{it.name}</span>
              {/* Letztes Glyph-als-Symbol im Projekt: '✓' erbte die Textfarbe nicht und hiess
                  fuer einen Screenreader nichts. Gleiche Bildsprache wie FileStatusPill. */}
              <span className={cn('inline-flex shrink-0 items-center gap-1.5',
                it.status === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
                {it.status === 'uploading' && <><Loader2 className="size-3 animate-spin" aria-hidden="true" /> lädt…</>}
                {it.status === 'done' && <><Check className="size-3" aria-hidden="true" /> geladen</>}
                {it.status === 'exists' && 'existiert bereits'}
                {/* || statt ??: ein Error mit leerer message ist nicht null, liesse den Text
                    aber verschwinden — dann staende nur das Warndreieck ohne Grund da. */}
                {it.status === 'error' && <><TriangleAlert className="size-3" aria-hidden="true" /> {it.msg || 'Fehler'}</>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
