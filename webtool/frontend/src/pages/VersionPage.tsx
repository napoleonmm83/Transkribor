import { useEffect, useState } from 'react'
import { ChevronRight, Loader2 } from 'lucide-react'
import { useUpdate } from '@/hooks/useUpdate'
import { PageHeader } from '@/components/PageHeader'
import { Abschnitt } from '@/components/Abschnitt'
import { Notizen } from '@/components/Notizen'
import { Button } from '@/components/ui/button'
import { holeReleases, type Release } from '@/lib/releases'
import type { UpdateZustand } from '@/lib/types'
import { tag } from '@/lib/utils'

const RELEASES = 'https://github.com/napoleonmm83/Transkribor/releases'

/**
 * Der Grund kommt als Code aus Electron — der Satz gehört hierher, wo Umlaute erlaubt sind.
 *
 * `Record<Grund, …>`, nicht `Record<string, …>`: sonst zwingt ein neuer Code in der Union den
 * Compiler zu nichts, der Rückfall unten schluckt die Lücke still, und es entsteht ein
 * Zustand ohne passenden Satz — also genau die Klasse, aus der #319 kam.
 */
type Grund = Extract<UpdateZustand, { art: 'nicht_moeglich' }>['grund']

const GRUENDE: Record<Grund, string> = {
  entwicklung: 'Entwicklungsmodus — Updates gibt es nur in der installierten App.',
  'kein-appimage': 'Nur die AppImage kann sich selbst aktualisieren.',
  // Beide Quellen für die Update-Adresse waren leer (`electron/updater.js`). Der Satz nennt
  // den Ausweg, weil dieses Exemplar sich nicht selbst helfen kann.
  'keine-quelle': 'Diese Fassung kennt keine Update-Quelle — bitte lade sie neu herunter.',
  // `erstellen` lief gar nicht erst (Verpackungsfehler). Ohne eigenen Grund sagte die Seite
  // hier „Updates gibt es in der installierten App" — in der installierten App (#319).
  'kein-updater': 'Die Update-Prüfung konnte nicht gestartet werden.',
}

/** Bytes als MB mit einer Nachkommastelle, deutsches Dezimalkomma. */
function mb(bytes: number, stellen = 0) {
  return (bytes / 1048576).toFixed(stellen).replace('.', ',')
}

/**
 * Version, Update und Verlauf — die drei Fragen zu „welchen Stand habe ich?" auf einer Seite.
 *
 * Lag bis dahin als Abschnitt in den Einstellungen, zwischen Whisper-Qualität und KI-Anbieter:
 * Einstellungen sind Dinge, die man EINSTELLT, ein Update ist keines. Der Verlauf kam dazu,
 * weil die Frage „was ist eigentlich neu?" bis dahin nur GitHub beantwortet hat — und dorthin
 * geht niemand, der die App benutzt, um nicht mit Dateien zu hantieren.
 */
export function VersionPage() {
  const { zustand: upd, pruefen, laden, installieren, protokollOeffnen, fehlerbericht } = useUpdate()
  // Ausserhalb von Electron gibt es keinen Update-Zustand — dann ist der zur Bauzeit
  // eingesetzte Wert die einzige (und richtige) Quelle, wie in der Fusszeile.
  const version = upd?.version ?? __APP_VERSION__
  const [verlauf, setVerlauf] = useState<Release[] | null>(null)
  const [fehler, setFehler] = useState('')

  useEffect(() => {
    const ab = new AbortController()
    holeReleases(ab.signal)
      .then(setVerlauf)
      // Der Wächter gilt dem StrictMode-Doppelmount: der Effekt läuft mount→unmount→mount
      // auf DERSELBEN Fiber, der erste `abort()` lässt den ersten Abruf ablehnen, und ohne
      // ihn stünde im Entwicklungsbetrieb kurz „lässt sich nicht laden (The user aborted a
      // request.)" auf einer Seite, die gleich darauf lädt. NICHT gegen „überschreibt eine
      // neue Instanz" — die hat ihren eigenen useState-Slot, dorthin kommt der alte Aufruf
      // gar nicht (Reviewbefund: die erste Begründung behauptete genau das).
      .catch((e: Error) => { if (!ab.signal.aborted) setFehler(e.message) })
    return () => ab.abort()
  }, [])

  return (
    <div className="p-6 sm:p-8">
      <PageHeader rubrik="Transkribor" titel="Version und Updates" zurueck="/" zurueckText="Übersicht" />

      <Abschnitt titel="Diese Fassung">
        <p className="ziffern text-3xl font-semibold">{version}</p>

        {!upd && (
          // Der Browser-Fall: dieselbe Oberfläche, aber hier gibt es nichts zu aktualisieren.
          <p className="mt-2 text-sm text-muted-foreground">
            Updates gibt es in der installierten App.{' '}
            <a className="underline underline-offset-2 hover:text-foreground" href={RELEASES}
              target="_blank" rel="noreferrer">Alle Fassungen ansehen</a>
          </p>
        )}

        {upd?.art === 'aktuell' && (
          <p className="mt-1 text-sm text-muted-foreground">Das ist die neueste Fassung.</p>
        )}

        {(upd?.art === 'unbekannt' || upd?.art === 'aktuell' || upd?.art === 'prueft' || upd?.art === 'fehler') && (
          <Button className="mt-3" variant="outline" disabled={upd.art === 'prueft'} onClick={pruefen}>
            {upd.art === 'prueft'
              ? <><Loader2 className="size-4 animate-spin" /> Wird geprüft …</>
              : 'Nach Updates suchen'}
          </Button>
        )}

        {upd?.art === 'verfuegbar' && (
          <div className="mt-3">
            <p className="text-sm">{upd.neue} verfügbar</p>
            <Button className="mt-2" onClick={laden}>
              Herunterladen{upd.groesse != null && ` (${mb(upd.groesse)} MB)`}
            </Button>
          </div>
        )}

        {upd?.art === 'verfuegbar_manuell' && (
          // Mac: Auto-Update ohne Notarisierung nicht moeglich, aber die Pruefung lief. Statt des
          // Auto-Download-Knopfs (der downloadUpdate riefe, das auf Mac scheitert) ein Knopf, der
          // ueber denselben `laden`-IPC geht — der Mac-Automat oeffnet darin die Release-Seite.
          <div className="mt-3">
            <p className="text-sm">
              Update {upd.neue} verfügbar{upd.groesse != null && ` (${mb(upd.groesse)} MB)`}.{' '}
              Auf macOS ist Auto-Update ohne Notarisierung nicht möglich.
            </p>
            <Button className="mt-2" onClick={laden}>Manuell herunterladen</Button>
          </div>
        )}

        {upd?.art === 'laedt' && (
          <div className="mt-3">
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted" role="progressbar"
              aria-valuenow={Math.round(upd.prozent)} aria-valuemin={0} aria-valuemax={100}
              aria-label="Update wird heruntergeladen">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${upd.prozent}%` }} />
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              <span className="ziffern">{Math.round(upd.prozent)} %</span> · {mb(upd.geladen)} von {mb(upd.gesamt)} MB · {mb(upd.tempo, 1)} MB/s
            </p>
          </div>
        )}

        {upd?.art === 'bereit' && (
          <div className="mt-3">
            <p className="text-sm">{upd.neue} ist bereit.</p>
            <Button className="mt-2" onClick={installieren}>Neu starten und installieren</Button>
          </div>
        )}

        {upd?.art === 'fehler' && (
          <p className="mt-3 text-sm text-muted-foreground">
            Prüfung fehlgeschlagen: {upd.text} — Einzelheiten stehen im{' '}
            <button type="button" className="underline underline-offset-2 hover:text-foreground"
              onClick={protokollOeffnen}>Protokoll</button>.
          </p>
        )}

        {upd?.art === 'nicht_moeglich' && (
          <p className="mt-3 text-sm text-muted-foreground">
            {GRUENDE[upd.grund]}{' '}
            {/* Der Weg, den der Satz nennt, muss auch begehbar sein: das Menü ist
                ausgeblendet, einen zweiten Zugang zum Protokoll gibt es nicht — ein „siehe
                Protokoll" ohne Knopf wäre derselbe Kreis wie der Satz, den dieser Zustand
                gerade abgelöst hat. `kein-updater` tritt nur in Electron auf, die Brücke ist
                dort also immer da. */}
            {upd.grund === 'kein-updater' && (
              <>
                Einzelheiten stehen im{' '}
                <button type="button" className="underline underline-offset-2 hover:text-foreground"
                  onClick={protokollOeffnen}>Protokoll</button>.{' '}
              </>
            )}
            <a className="underline underline-offset-2 hover:text-foreground" href={RELEASES}
              target="_blank" rel="noreferrer">Versionen ansehen</a>
          </p>
        )}
      </Abschnitt>

      {/* Nur in der App: der Bericht lebt vom Protokoll, und das gibt es im Browser nicht
          (`upd === null` heisst „keine Bruecke", dieselbe Weiche wie oben). */}
      {upd && (
        <Abschnitt titel="Etwas geht schief?">
          <p className="text-sm text-muted-foreground">
            Der Bericht öffnet eine vorbereitete E-Mail mit Fassung, Betriebssystem und den
            letzten Zeilen des Protokolls. <strong className="font-medium text-foreground">Du
            siehst alles im Mailprogramm, bevor du sendest</strong> — und kannst jede Zeile
            löschen. Das vollständige Protokoll wird daneben im Dateimanager gezeigt; hänge es
            an, wenn du magst.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="secondary" onClick={fehlerbericht}>Fehlerbericht schreiben</Button>
            <Button variant="ghost" onClick={protokollOeffnen}>Protokoll anzeigen</Button>
          </div>
        </Abschnitt>
      )}

      <Abschnitt titel="Versionsverlauf">
        {!verlauf && !fehler && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Lädt …
          </p>
        )}

        {fehler && (
          // Kein Netz, GitHub weg, Kontingent überschritten — für den Leser derselbe Fall:
          // hier steht heute nichts. Der Grund steht trotzdem dabei, sonst rät er.
          <p className="text-sm text-muted-foreground">
            Der Verlauf lässt sich gerade nicht laden ({fehler}).{' '}
            <a className="underline underline-offset-2 hover:text-foreground" href={RELEASES}
              target="_blank" rel="noreferrer">Auf GitHub ansehen</a>
          </p>
        )}

        {verlauf?.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Noch keine veröffentlichten Fassungen.{' '}
            <a className="underline underline-offset-2 hover:text-foreground" href={RELEASES}
              target="_blank" rel="noreferrer">Auf GitHub ansehen</a>
          </p>
        )}

        {verlauf?.map((r, i) => (
          // <details> statt eigenem Aufklapp-Zustand: die Notizen sind lang, und der Browser
          // kann das seit jeher — samt Tastaturbedienung. Die neueste steht offen, weil sie
          // fast immer die gesuchte ist.
          <details key={r.tag || i} open={i === 0} className="group border-b border-border/60 py-3 last:border-b-0">
            <summary className="flex cursor-pointer items-baseline gap-3 rounded-md
                                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {/* Eigenes Symbol, weil `display: flex` am <summary> den Marker des Browsers
                  unterdrückt (im Browser gemessen: `::marker` leer, kein Dreieck) — ohne das
                  sah eine zugeklappte Fassung nach einer toten Zeile aus. */}
              <ChevronRight aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 self-start text-muted-foreground transition-transform
                           group-open:rotate-90 motion-reduce:transition-none" />
              <h3 className="ziffern font-medium">{r.version}</h3>
              <span className="text-xs text-muted-foreground">{tag(r.datum)}</span>
              {r.version === version && (
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                  installiert
                </span>
              )}
            </summary>
            <div className="mt-3 pl-1">
              <Notizen text={r.notizen} />
              {!r.notizen.trim() && <p className="text-sm text-muted-foreground">Keine Beschreibung.</p>}
            </div>
          </details>
        ))}

        {verlauf && verlauf.length > 0 && (
          <p className="mt-4 text-sm text-muted-foreground">
            <a className="underline underline-offset-2 hover:text-foreground" href={RELEASES}
              target="_blank" rel="noreferrer">Ältere Fassungen auf GitHub</a>
          </p>
        )}
      </Abschnitt>
    </div>
  )
}
