import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { FolderOpen, KeyRound, Loader2, LogIn, RefreshCw } from 'lucide-react'
import {
  cancelLogin, getAuth, getHardware, getSettings, listModels, loginState,
  saveSettings, startLogin, submitLoginCode, testSettings, updateYtdlp, verwerfeKaputt,
} from '@/lib/api'
import { useUpdate } from '@/hooks/useUpdate'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { AuthStatus, Hardware, LoginState, ModelInfo, ProviderInfo, Settings, YtdlpStand } from '@/lib/types'

const RELEASES = 'https://github.com/napoleonmm83/Transkribor/releases'

/** ISO-Datum vom Server als deutsches Datum. Von Hand umgedreht statt per
 *  `toLocaleDateString`: dessen Ausgabe hängt an der ICU-Fassung der Laufzeit, wäre also im
 *  Test eine andere als im Browser. Im Screenshot fiel auf, dass `2026-08-13` in einer sonst
 *  durchgehend deutschen Seite wie eine Fehlermeldung aussieht. */
function tag(iso: string) {
  return iso.split('-').reverse().join('.')
}

/** Bytes als MB mit einer Nachkommastelle, deutsches Dezimalkomma. */
function mb(bytes: number, stellen = 0) {
  return (bytes / 1048576).toFixed(stellen).replace('.', ',')
}

/** Der Grund kommt als Code aus Electron — der Satz gehoert hierher, wo Umlaute erlaubt sind. */
const GRUENDE: Record<string, string> = {
  entwicklung: 'Entwicklungsmodus — Updates gibt es nur in der installierten App.',
  'kein-appimage': 'Nur die AppImage kann sich selbst aktualisieren.',
}

/**
 * Abschnitt als Blatt. Vorher trennten nur `border-t`-Striche — die Seite las sich als eine
 * lange Rolle, in der Whisper-Qualitaet, KI-Anbieter und Update-Stand gleich wichtig aussahen.
 */
function Abschnitt({ titel, children }: { titel: string; children: React.ReactNode }) {
  return (
    <section className="blatt mb-6 p-5">
      <h2 className="rubrik mb-4">{titel}</h2>
      {children}
    </section>
  )
}

/**
 * Der „Ordner öffnen"-Griff der Electron-Brücke, oder `null` im Browser (#218).
 *
 * `window.transkribor` ist die Weiche App/Browser, nicht die Plattform: dieselbe Oberfläche
 * läuft unter `webtool.ps1` und Vite, dort fehlt die Brücke, und jede Electron-Funktion muss
 * dort ein No-Op sein statt zu werfen. Der Pfad daneben steht in BEIDEN Fällen — er ist die
 * eigentliche Auskunft, der Knopf nur die Bequemlichkeit.
 */
function projekteOeffnenBruecke(): (() => Promise<string>) | null {
  // `Promise<string>`, nicht `void`: der Hauptprozess gibt den Pfad zurueck, den er WIRKLICH
  // geoeffnet hat. Niemand liest ihn heute — aber ihn als `void` zu tippen waere eine zweite
  // Unwahrheit im selben PR, in dem eine erste gerade behoben wird.
  const w = window as unknown as { transkribor?: { projekteOeffnen?: () => Promise<string> } }
  return w.transkribor?.projekteOeffnen ?? null
}

/**
 * Eine Meldung je LAUF, nicht je Bedingung (#247).
 *
 * Beide Poll-Schleifen dieser Seite hängen ihre Meldung an einen Zustand („läuft nicht mehr")
 * statt an den Übergang dorthin. Braucht die Abfrage länger als das Intervall von 1,5 s
 * (langsame Platte, ein pip, das gerade `site-packages` umschreibt), sind zwei Runden
 * gleichzeitig unterwegs, sehen beide denselben fertigen Lauf und melden ihn beide.
 * `setYtLaeuft(false)` schützt davor nicht: das ist ein State-Update, die zweite Runde liest
 * ihren Wert aus der eigenen Closure, und abgeräumt wird das Intervall erst beim nächsten
 * Effektlauf.
 *
 * **Warum ein Merker statt eines In-Flight-Riegels** (der erste Vorschlag im Issue): der
 * Riegel deckt nur die überholenden Polls. Bei yt-dlp gibt es aber ZWEI Aufrufer — den Poll
 * und den Direktstart in `ytJetzt` —, und zwischen denen hilft er nicht. Ausserdem fasst er
 * die Obergrenze an: der Zähler dort zählt ausdrücklich Nachfragen und nicht Wanduhrzeit
 * (weil `vi.useFakeTimers()` `Date.now()` nicht mitfälscht), und ein Riegel, der Runden
 * überspringt, entkoppelt Ticks von Nachfragen und verschiebt die Frist still.
 *
 * **`neuerLauf()` ist Pflicht, nicht Kür.** Ohne das Zurücksetzen meldete der Merker den
 * ersten Lauf und danach nie wieder etwas — aus „zu viele Meldungen" würde „gar keine", und
 * zwar still. Dafür gibt es einen eigenen Test.
 *
 * **Und deshalb reicht ein blosser Bool nicht** (CodeRabbit-CLI, Major): `clearInterval` hält
 * künftige Runden auf, aber eine Runde, die schon in ihrem `await` steht, läuft weiter. Ihre
 * Antwort kann also NACH dem `neuerLauf()` des nächsten Laufs eintreffen — und würde dann als
 * dessen Ausgang gemeldet, mit den Zahlen des vorigen. Ein Bool kann „gemeldet" und „gehört zu
 * einem anderen Lauf" nicht unterscheiden, eine Kennung schon: `melde` nimmt die Kennung
 * entgegen, unter der ihr Aufrufer gestartet ist, und verwirft alles Ältere.
 */
function useEinmalJeLauf() {
  const lauf = useRef(0)
  const gemeldet = useRef(0)
  /** Beginnt einen Lauf und liefert seine Kennung — die gehört in die Closure des Aufrufers. */
  const neuerLauf = useCallback(() => ++lauf.current, [])
  /** Die Kennung des laufenden Vorgangs, für Zuhörer, die ihn nicht selbst gestartet haben
   *  (der Poll-Effekt). Beim Aufsatz des Effekts gelesen, nicht bei jedem Tick — sonst hätte
   *  eine verspätete Runde wieder die Kennung des NÄCHSTEN Laufs und der Riegel wäre umsonst. */
  const kennung = useCallback(() => lauf.current, [])
  const melde = useCallback((fuer: number, fn: () => void) => {
    if (fuer !== lauf.current || gemeldet.current === fuer) return
    gemeldet.current = fuer
    fn()
  }, [])
  return { neuerLauf, kennung, melde }
}

/** Anmeldung an einer Abo-CLI. Zwei Wege, eine Oberflaeche:
 *  - Claude gibt eine URL aus und WARTET auf einen Code aus dem Browser (`braucht_code`).
 *  - Codex zeigt URL und Code an, der Nutzer tippt sie dort ein, die CLI merkt es selbst.
 *  Deshalb haengt das Eingabefeld an `braucht_code` und nicht am Anbieternamen. */
function AnmeldungAbo({ status, neuPruefen }: { status: AuthStatus; neuPruefen: () => void }) {
  const [lauf, setLauf] = useState<LoginState | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  // Dieselbe Klasse wie beim yt-dlp-Poll (#247): zwei überholende Runden meldeten hier doppelt
  // UND riefen `neuPruefen()` zweimal. Nicht gemeldet worden, aber dieselbe Ursache — wer nur
  // die eine Stelle repariert, lässt den Nachbarn stehen.
  const { neuerLauf, kennung, melde } = useEinmalJeLauf()

  // Nur solange etwas laeuft gepollt — ein Dauerintervall auf einer Einstellungsseite,
  // auf der meistens nichts passiert, ist reine Last.
  useEffect(() => {
    if (!lauf?.laeuft) return
    // Kennung beim AUFSATZ festhalten, nicht je Tick — sonst traegt eine verspaetete Runde
    // die Kennung des naechsten Anmeldeversuchs und meldet dessen Ausgang mit alten Zahlen.
    const meine = kennung()
    const t = setInterval(async () => {
      const z = await loginState().catch(() => null)
      if (!z) return
      setLauf(z)
      if (!z.laeuft) melde(meine, () => {
        neuPruefen()
        if (z.ok) toast.success('Angemeldet')
        else toast.error(z.fehler || 'Anmeldung fehlgeschlagen')
      })
    }, 1500)
    return () => clearInterval(t)
  }, [lauf?.laeuft, neuPruefen, melde, kennung])

  const starten = async () => {
    setBusy(true); setCode('')
    neuerLauf()   // sonst bliebe der zweite Anmeldeversuch einer Sitzung stumm
    try { setLauf(await startLogin()) }
    catch (e) { toast.error(`Anmeldung: ${(e as Error).message}`) }
    finally { setBusy(false) }
  }
  const senden = async () => {
    setBusy(true)
    try { setLauf(await submitLoginCode(code)); setCode('') }
    catch (e) { toast.error(`Code: ${(e as Error).message}`) }
    finally { setBusy(false) }
  }
  const abbrechen = async () => { setLauf(await cancelLogin().catch(() => null)); neuPruefen() }

  if (!status.unterstuetzt) return null

  return (
    <div>
      <span className="mb-1.5 block text-sm font-medium">Anmeldung</span>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className={`text-sm ${status.angemeldet ? 'text-muted-foreground' : 'text-amber-600 dark:text-amber-500'}`}>
          {status.detail}
        </span>
        {!lauf?.laeuft && (
          <Button variant="outline" size="sm" onClick={starten} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <LogIn className="size-4" />}
            {status.angemeldet ? 'Neu anmelden' : 'Anmelden'}
          </Button>
        )}
      </div>

      {lauf?.laeuft && (
        <div className="mt-3 space-y-3 rounded-lg border p-4 text-sm">
          {lauf.url
            ? <p>
                Im Browser öffnen:{' '}
                <a className="underline underline-offset-2 break-all hover:text-foreground"
                   href={lauf.url} target="_blank" rel="noreferrer">{lauf.url}</a>
              </p>
            : <p className="text-muted-foreground flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" /> Anmeldeseite wird vorbereitet …
              </p>}

          {/* Codex zeigt den Einmalcode an — der gehoert auf die Webseite, nicht hierher. */}
          {lauf.code && (
            <p>Code auf der Seite eingeben: <code className="rounded bg-muted px-1.5 py-0.5 font-mono">{lauf.code}</code></p>
          )}

          {/* Claude wartet umgekehrt auf den Code, den der Browser ausgibt. */}
          {lauf.braucht_code && (
            <div className="flex gap-2">
              <Input value={code} onChange={e => setCode(e.target.value)} autoComplete="off"
                placeholder="Code aus dem Browser hier einfügen"
                onKeyDown={e => { if (e.key === 'Enter' && code.trim()) senden() }} />
              <Button onClick={senden} disabled={!code.trim() || busy}>Bestätigen</Button>
            </div>
          )}

          <Button variant="ghost" size="sm" onClick={abbrechen}>Abbrechen</Button>
        </div>
      )}
    </div>
  )
}

/** Der Ausgang eines yt-dlp-Laufs als Toast. Ausserhalb der Komponente, weil zwei Wege
 *  hierher führen — der Poll-Effekt und der Sofort-fertig-Fall im Klick — und eine Kopie
 *  beim nächsten Mal an einer der beiden Stellen falsch wäre.
 *
 *  Ohne Fassung KEINE Fassung nennen: pip meldet Erfolg, die Metadaten bleiben aber
 *  unlesbar — der Toast sagte dann „yt-dlp ist jetzt auf null" (#189). Und der Fehlerzweig
 *  darf nicht raten: bei kaputter METADATA scheitert **pip selbst** (gemessen: `pip list`
 *  gegen eine präparierte dist-info endet mit Exit 2 und UnicodeDecodeError). „Bist du
 *  online?" wäre dort dieselbe Fehldiagnose, gegen die #189 gebaut ist — `unlesbar`
 *  entscheidet das, nicht eine Vermutung. */
function ytMelden(stand: YtdlpStand) {
  if (stand.ergebnis === 'ok') {
    toast.success(stand.version ? `yt-dlp ist jetzt auf ${stand.version}` : 'yt-dlp wurde aktualisiert')
  } else {
    toast.error(stand.unlesbar
      ? 'Die Metadaten von yt-dlp sind beschädigt — pip kann sie nicht lesen. Hilft nur neu installieren.'
      // Derselbe Grund, andere Distribution — und ohne diesen Zweig lief der Nutzer in genau
      // die Fehldiagnose, gegen die #189 gebaut ist: `unlesbar` gilt yt-dlp, bei kaputten
      // ejs-Paketdaten ist es `false`, und dann stand hier „bist du online?“. **Gemessen**,
      // nicht vermutet: `pip install -U --dry-run yt-dlp[default]` gegen eine präparierte
      // `yt_dlp_ejs-0.8.0.dist-info` endet mit Exit 2 und UnicodeDecodeError — pip
      // enumeriert vor dem Installieren, es scheitert also an derselben Datei.
      : stand.ejs_unlesbar
      ? 'Die Paketdaten der YouTube-Hilfsskripte sind beschädigt — daran scheitert auch die Aktualisierung selbst. Hilft nur neu installieren.'
      : 'Aktualisierung fehlgeschlagen — bist du online?')
  }
  // Zusätzlich, nicht statt dessen (#236): ob pip durchlief und ob es dabei allein war, sind
  // zwei Fragen. Der Schaden ist hier ein anderer als bei #194 — nicht ein überbügelter
  // Einstellungswert, sondern zwei `pip install` in dieselbe venv, und der zweite Auslöser
  // sitzt in einem anderen Prozess (der Video-Import aktualisiert selbst). Auch bei einem
  // Fehlschlag, denn das Zerlegen der Installation hängt nicht am eigenen Exitcode.
  if (stand.ungeschuetzt) {
    toast.warning('Die Aktualisierung lief ohne Sperre — lief zeitgleich ein Video-Import, '
      + 'kann die Installation unvollständig sein. Im Zweifel noch einmal aktualisieren.')
  }
}

export function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null)
  const [modelle, setModelle] = useState<ModelInfo[]>([])
  // Nur das NEU Eingetippte; die gespeicherten Geheimnisse kommen nie zum Frontend zurueck.
  const [key, setKey] = useState('')
  const [laedt, setLaedt] = useState(false)
  const [testet, setTestet] = useState(false)
  const [ytLaeuft, setYtLaeuft] = useState(false)
  // Der Nachhol-Poll (#252) hat seine Obergrenze erreicht. Ohne diesen Merker fröre die Zeile
  // „läuft gerade" danach WIEDER ein — also #252s Symptom, nur um zwölf Minuten verschoben.
  // Der Poll oben zeigt an derselben Stelle einen Fehler-Toast; hier wäre der falsch (niemand
  // hat etwas angestossen, es ist kein Fehlschlag), also sagt es die Zeile selbst.
  const [ytAufgegeben, setYtAufgegeben] = useState(false)
  // Drei Wege enden in einer Meldung über denselben Lauf: der Poll, der Direktstart in
  // `ytJetzt` und die Obergrenze. Seit #236 erzeugt jeder Durchlauf bis zu ZWEI Toasts
  // (Erfolg und die Warnung „ohne Sperre") — doppelt gemeldet wären das vier für einen
  // Vorgang, und die Warnung sähe wichtiger aus, als sie ist. Siehe `useEinmalJeLauf`.
  const { neuerLauf: ytNeuerLauf, kennung: ytKennung, melde: ytMeldeEinmal } = useEinmalJeLauf()
  const [kaputtLaeuft, setKaputtLaeuft] = useState(false)
  const [hw, setHw] = useState<Hardware | null>(null)
  const { zustand: upd, pruefen, laden, installieren, protokollOeffnen } = useUpdate()

  useEffect(() => { getSettings().then(setS).catch(e => toast.error(String(e))) }, [])
  useEffect(() => { getHardware().then(setHw).catch(() => setHw(null)) }, [])

  // Anmeldezustand hängt am Anbieter. Nach einer Anmeldung auch die Einstellungen neu holen:
  // `ai_ready` kippt dadurch, und der Warnbalken oben soll sofort verschwinden.
  const [autz, setAutz] = useState<AuthStatus | null>(null)
  const autzLaden = useCallback(() => {
    getAuth().then(setAutz).catch(() => setAutz(null))
    getSettings().then(setS).catch(() => {})
  }, [])
  useEffect(() => { if (s?.provider) autzLaden() }, [s?.provider, autzLaden])

  const prov: ProviderInfo | undefined = s?.providers.find(p => p.id === s.provider)
  // Frueher `s.provider === 'claude-cli'`: das war die Frage "ist es DAS Abo". Seit es zwei
  // Abo-CLIs gibt, lautet die Frage "kommt der Anbieter ohne Key aus" — und die beantwortet
  // der Server, nicht eine Namensliste im Frontend.
  const istCli = !!prov?.cli

  // Anbieterwechsel und Key-Eingabe koennen sich ueberholen: wer schnell von A nach B
  // schaltet, bekaeme sonst A's Liste in B's Auswahl — und speichert beim naechsten Klick
  // einen Modellnamen, den B nicht kennt. Nur die juengste Anfrage darf schreiben.
  const lauf = useRef(0)

  // `leise` fuer den automatischen Weg: eine rote Blase beim Seitenaufbau, weil irgendwo
  // ein Key fehlt, ist Laerm ueber einen Zustand, den der Nutzer gerade erst herstellt.
  // Verschluckt wird nichts — das Textfeld bleibt als Rueckfall stehen, und der Knopf
  // daneben meldet weiterhin laut, weil ihn nur drueckt, wer eine Antwort erwartet.
  const modelleLaden = useCallback(async (leise = false) => {
    const meiner = ++lauf.current
    setLaedt(true)
    try {
      const m = await listModels()
      if (meiner === lauf.current) setModelle(m)
    } catch (e) {
      if (meiner !== lauf.current) return
      setModelle([])
      if (!leise) toast.error(`Modelle: ${(e as Error).message}`)
    } finally {
      if (meiner === lauf.current) setLaedt(false)
    }
  }, [])

  // Die Liste haengt am Anbieter UND am Key — beides steht hier erst nach dem Speichern fest.
  // Automatisch, weil der Knopf allein nicht reichte: wer ihn nicht findet, sieht ein leeres
  // Textfeld und muss die Modell-ID abtippen. Gefragt wird nur, wenn es ueberhaupt gehen kann
  // (das Abo hat keine Liste, ohne Key antwortet niemand) — sonst kostet jeder Seitenaufbau
  // einen Fehlschlag beim Anbieter.
  // Abhaengig von den EINZELWERTEN, nicht von `s`: das ist nach jedem Speichern ein neues
  // Objekt, und ein Wechsel der Whisper-Stufe holte sonst die Modellliste mit.
  // `basis` steht in der Liste, obwohl der Rumpf es nicht liest — bei "custom" entscheidet
  // es serverseitig, WEN `listModels()` fragt.
  const { provider, has_key: hatKey, base_url: basis } = s ?? {}
  useEffect(() => {
    if (!provider) { setModelle([]); return }
    if (prov?.needs_key && !hatKey) { setModelle([]); return }
    modelleLaden(true)
  }, [provider, hatKey, basis, prov?.needs_key, modelleLaden])

  // `ungeschuetzt` wird ABGETRENNT, nicht mitgemischt (#194): es gilt diesem einen Schreiben,
  // nicht dem Zustand — im State bliebe die Warnung stehen, bis die Seite neu laedt. Und sie
  // kommt NACH `danach?.()`, damit sie nicht unter dessen Erfolgsmeldung („Key gespeichert")
  // liegt: gespeichert wurde ja wirklich, die Einschraenkung ist die neue Nachricht.
  const speichern = async (patch: Record<string, string>, danach?: () => void) => {
    try {
      // Ersetzen, nicht zusammenführen — seit #239 liefert der PUT denselben vollständigen
      // Rumpf wie der GET. Vorher stand hier ein `{...cur, ...neu}`, das die fünf fehlenden
      // Felder aus dem vorigen Stand retten musste; genau dieser Merge hat die Falschaussage
      // im Typ verdeckt. Eine Merge-Form, die nichts merged, sieht nur nach Sorgfalt aus.
      const { ungeschuetzt, ...neu } = await saveSettings(patch)
      setS(neu)
      danach?.()
      if (ungeschuetzt) toast.warning(
        'Gespeichert — aber ohne Schreibsperre. Hat in derselben Sekunde etwas anderes '
        + 'geschrieben, kann die Änderung überschrieben worden sein. Bitte kurz nachsehen.')
    } catch (e) { toast.error(`Speichern fehlgeschlagen: ${(e as Error).message}`) }
  }

  // Der Hinweis auf die gerettete Datei haengt an ihrer EXISTENZ, nicht an einem Ereignis —
  // geschrieben hat sie oft ein Subprozess, den nie jemand gesehen hat. Ohne diesen Knopf
  // stuende er darum fuer immer da: der Pfad liegt im Benutzerprofil, und wer die App
  // benutzt, um nicht mit Dateien zu hantieren, raeumt ihn dort nicht selbst weg.
  // `kaputtWeg` sperrt seinen Knopf, solange die Anfrage laeuft: der zweite Klick eines
  // Doppelklicks traefe eine Datei, die es nicht mehr gibt — der Server antwortet dann
  // richtigerweise mit 404, und der Nutzer saehe fuer eine geglueckte Aktion einen Fehler.
  const kaputtWeg = async () => {
    setKaputtLaeuft(true)
    try {
      await verwerfeKaputt()
      setS(cur => cur && { ...cur, kaputt: '' })
    } catch (e) { toast.error(`Entfernen fehlgeschlagen: ${(e as Error).message}`) }
    finally { setKaputtLaeuft(false) }
  }

  const anbieterWechseln = (id: string) => {
    const p = s?.providers.find(x => x.id === id)
    setModelle([])
    // Modell mitzurücksetzen ist Absicht: ein Modellname des alten Anbieters ist beim neuen ungültig.
    speichern({ provider: id, model: p?.default_model ?? '', base_url: '' })
  }

  const testen = async () => {
    setTestet(true)
    const r = await testSettings().catch(e => ({ ok: false, detail: String(e) }))
    setTestet(false)
    r.ok ? toast.success(r.detail || 'Verbindung steht') : toast.error(r.detail || 'Fehlgeschlagen')
  }

  // Poll, solange ein yt-dlp-Lauf verfolgt wird (#174) — dieselbe Form wie beim
  // Anmeldevorgang oben: Effekt + `setInterval` + Cleanup.
  useEffect(() => {
    if (!ytLaeuft) return
    // Obergrenze, weil die Schleife sonst unbegrenzt wäre: bleibt `laeuft` serverseitig
    // hängen (etwa an dem blockierenden `open()` aus #200, wo die Obergrenze aus #191 nicht
    // greift), pollte der Browser bis zum Tab-Schluss und meldete nie etwas.
    //
    // Gezählt werden NACHFRAGEN, nicht Wanduhrzeit. Zwei Gründe: begrenzen wollen wir das,
    // was Last erzeugt (ein im Hintergrund gedrosselter Tab soll nicht früher aufgeben),
    // und `Date.now()` wäre nicht prüfbar — `vi.useFakeTimers()` fälscht in dieser Fassung
    // die Uhr NICHT mit, die Obergrenze feuerte im Test also nie und blieb ungetestet.
    // 480 × 1,5 s ≈ 12 Min, also gut das Doppelte des gemessenen Worst Case von ~340 s.
    let runden = 0
    // Die höchste Rundennummer, deren Antwort schon angewandt wurde. Überholte Antworten
    // werden verworfen (CodeRabbit-Bot an PR #248): der Merker deckt die MELDUNG, nicht
    // `setS`. Trifft eine ältere Runde (`laeuft: true`) NACH der jüngeren (`laeuft: false`)
    // ein, schriebe sie den überholten Zustand zurück — und weil `ytLaeuft` dann schon aus
    // ist, ist das Intervall abgeräumt und niemand holt das je wieder ein. Die Seite behauptet
    // bis zum Neuladen, es laufe eine Aktualisierung: die Lüge aus #225, aus der Gegenrichtung.
    // Gemessen, nicht vermutet — der Test dazu war rot, bevor diese drei Zeilen standen.
    // `runden` reicht als Kennung: er zählt ohnehin je Tick hoch.
    // Der Anmelde-Poll braucht das NICHT: dort setzt eine überholte Antwort `lauf.laeuft`
    // zurück auf true, womit der Effekt neu aufsetzt und sich selbst einholt.
    let angewandt = 0
    const meine = ytKennung()      // siehe `kennung` in useEinmalJeLauf
    const t = setInterval(async () => {
      if (++runden > 480) {
        setYtLaeuft(false)
        ytMeldeEinmal(meine, () => toast.error(
          'Die Aktualisierung meldet sich nicht mehr — bitte im Serverprotokoll nachsehen.'))
        return
      }
      const meineRunde = runden
      const neu = await getSettings().catch(() => null)
      if (!neu) return                  // ein Aussetzer beendet den Lauf nicht
      if (meineRunde < angewandt) return // überholt — siehe `angewandt` oben
      angewandt = meineRunde
      // Ersetzen, nicht zusammenführen — `GET /api/settings` liefert das vollständige
      // `Settings`, ein `{...cur, ...neu}` wäre buchstäblich dasselbe wie `neu`.
      // (Hier stand bis #239 der Hinweis, `speichern()` weiter oben MÜSSE mischen, weil der
      // PUT nur ein Teilobjekt liefere. Das ist behoben: beide Endpunkte bauen ihren Rumpf
      // jetzt aus `app._settings_body`, und beide Stellen ersetzen.)
      setS(neu)
      if (!neu.ytdlp.laeuft) { setYtLaeuft(false); ytMeldeEinmal(meine, () => ytMelden(neu.ytdlp)) }
    }, 1500)
    return () => clearInterval(t)
  }, [ytLaeuft, ytMeldeEinmal, ytKennung])

  // #252: ein FREMDER Lauf — seit #253 der Regelfall, weil die Kalenderprüfung beim
  // Serverstart läuft — wird ANGEZEIGT, nicht übernommen. Dieser Effekt frischt allein `s`
  // auf, damit die Zeile „Eine Aktualisierung läuft gerade" auch wieder ENDET.
  //
  // Ohne ihn war sie eine Momentaufnahme: `s` wird sonst nur beim Laden, nach `speichern()`
  // und im Lauf-Poll oben gesetzt. Wer die Seite während eines fremden Laufs offen hatte, sah
  // die Zeile und danach für immer dieselbe — „ehrlich anzeigen" hätte nicht funktioniert.
  //
  // **Er fasst `ytLaeuft` bewusst NICHT an**, und das ist die eigentliche Zusicherung.
  // `ytLaeuft` besitzt die 480-Runden-Obergrenze des Polls oben samt ihrem `runden`-Zähler im
  // Effektrumpf; hinge JENER Effekt zusätzlich an `s.ytdlp.laeuft`, setzte er bei jeder Runde
  // neu auf, `runden` fiele auf 0, und die Obergrenze wäre wirkungslos — während ihr Test
  // grün bliebe, denn der prüft den Toast, nicht das Aufhören. Die Entscheidung steht seit
  // PR #223 an der Fassungszeile weiter unten; dieser Effekt hält sie ein, statt sie zu kippen.
  //
  // **Kein Toast** (Weg 2 aus #252, Entscheidung Marcus 2026-08-17): ein Toast für einen
  // fremden Lauf bräuchte einen zweiten Besitzer der `useEinmalJeLauf`-Kennung — zieht der
  // Effekt bei jedem Aufsatz `neuerLauf()`, entwertet er die des Knopfs; zieht nur der Knopf,
  // teilt sich der Fremdlauf `gemeldet` mit dem letzten eigenen. #247 ist an genau dieser
  // Klasse zweimal gekippt. Wer den Ausgang wissen will, klickt — die Zeile lädt dazu ein.
  //
  // **3 s statt 1,5 s:** hier wartet niemand auf eine Meldung, und jede Runde kostet den
  // Server einen `llm.available()`-Subprozess (#250, noch ungemessen).
  useEffect(() => {
    if (!s?.ytdlp.laeuft || ytLaeuft) return
    // Eigene Obergrenze, eigener Zähler: es ist ein eigener Effekt, die des Polls oben deckt
    // ihn nicht. Gezählt werden NACHFRAGEN, nicht Wanduhrzeit — derselbe Grund wie dort
    // (ein gedrosselter Hintergrund-Tab soll nicht früher aufgeben). 240 x 3 s = 12 Min.
    // Eine neue Beobachtung fängt ohne Vorgeschichte an. `setYtAufgegeben` ist stabil und
    // gehört deshalb NICHT in die Abhängigkeiten — läge `ytAufgegeben` dort, setzte der Effekt
    // bei jeder Änderung neu auf und `runden` fiele auf 0: exakt der Mechanismus, wegen dessen
    // der Poll oben nicht an `s.ytdlp.laeuft` hängen darf. Ist der Wert schon `false`, verwirft
    // React das Update (`Object.is`), es kostet also nichts.
    setYtAufgegeben(false)
    let runden = 0
    // Überholte Antworten verwerfen — derselbe Riegel wie im Poll oben (CodeRabbit-Bot an
    // PR #248), hier sogar nötiger: dieser Poll läuft **unaufgefordert** bis zu zwölf Minuten,
    // während jemand auf der Seite tippt. Eine überholte Runde schriebe `s` auf den Stand von
    // VOR einem `speichern()` zurück; das Modellfeld hängt an `key={provider|model}` und zeigte
    // dann wieder den ALTEN Namen — eine Anzeige, die widerruft, was gerade gespeichert wurde.
    let angewandt = 0
    const t = setInterval(async () => {
      if (++runden > 240) { clearInterval(t); setYtAufgegeben(true); return }
      const meineRunde = runden
      const neu = await getSettings().catch(() => null)
      if (!neu) return            // ein Aussetzer beendet die Beobachtung nicht
      if (meineRunde < angewandt) return
      angewandt = meineRunde
      setS(neu)
    }, 3000)
    return () => clearInterval(t)
  }, [s?.ytdlp.laeuft, ytLaeuft])

  // Der Knopf wartet seit #174 nicht mehr auf pip — er stösst an, und ein Effekt fragt nach.
  // Das Nachfragen ist NICHT optional: ohne es stünde ein Fehlschlag nur in der
  // Serverkonsole, und der Umbau hätte einen hängenden Browser gegen einen stillen Ausfall
  // getauscht — die teurere Sorte.
  //
  // **Effekt mit `setInterval` + Cleanup, KEINE freilaufende `while`-Schleife.** Die stand
  // hier zuerst und liess sich nicht abbrechen: wer die Seite während eines Laufs verliess,
  // pollte über die volle pip-Dauer weiter, rief `setS` auf einer ausgehängten Komponente
  // (React 18 warnt dazu nicht mehr — es ist still) und bekam am Ende einen Toast für eine
  // Seite, auf der niemand mehr ist. Dieselbe Form wie beim Anmeldevorgang oben; sie stand
  // in dieser Datei bereits 190 Zeilen weiter oben.
  const ytJetzt = async () => {
    setYtLaeuft(true)
    const meine = ytNeuerLauf()
    try {
      const r = await updateYtdlp()
      if (!r.gestartet) toast.info('Eine Aktualisierung läuft bereits — ich warte auf sie.')
      // Seit #243 kann `laeuft` von einem FREMDEN Prozess kommen (ein Video-Import frischt
      // selbst auf). `starte_hintergrund()` sieht nur `_lauf` und meldet deshalb brav
      // `gestartet: true` — der eigene Lauf blockiert dann bis zu 215 s an der pip-Sperre.
      // Ohne diese Zeile sähe der Nutzer einen Spinner und sonst nichts, obwohl die Zeile
      // über dem Knopf gerade noch „klicke, um ihr zuzusehen" versprochen hat.
      else if (s?.ytdlp.laeuft) toast.info('Ein Video-Import frischt den Downloader gerade selbst auf — ich warte, bis er fertig ist.')
      // Ein sehr schneller Lauf kann schon fertig sein, bevor der erste Poll greift.
      // Über denselben Merker wie der Poll (#247): braucht `updateYtdlp()` länger als 1,5 s
      // und ist der Lauf da schon fertig, meldet der Poll zuerst — und diese Zeile hier ein
      // zweites Mal. Ein In-Flight-Riegel um `getSettings()` hätte genau das nicht gedeckt.
      if (!r.laeuft) { setYtLaeuft(false); ytMeldeEinmal(meine, () => ytMelden(r)) }
    } catch (e) {
      // BEWUSST ausserhalb von `ytMeldeEinmal` (#247, Reviewbefund M3): „das Anstossen ist
      // fehlgeschlagen" und „der Lauf ist beendet" sind zwei verschiedene Tatsachen, nicht
      // dieselbe zweimal. Lehnt der POST ab, NACHDEM ein Poll den Ausgang gemeldet hat, sieht
      // der Nutzer also beides — und beides stimmt.
      toast.error(String(e))
      // KEIN `finally`: bei Erfolg übernimmt der Poll-Effekt und schaltet selbst ab —
      // ein `finally` hier würde ihn sofort wieder abwürgen.
      setYtLaeuft(false)
    }
  }

  const ordnerOeffnen = projekteOeffnenBruecke()

  if (!s) return <div className="p-6 sm:p-8 text-sm text-muted-foreground">Lädt…</div>

  return (
    // Volle Breite wie alle Seiten seit der AppShell. Die Formularreihen begrenzen sich
    // selbst (max-w an den Eingabefeldern) — eine Lesespalte um die ganze Seite wuerde
    // stattdessen wieder den Fensterrand leer lassen.
    <div className="p-6 sm:p-8">
      <PageHeader rubrik="Transkribor" titel="Einstellungen" zurueck="/" zurueckText="Übersicht" />
      <p className="mb-8 max-w-prose text-sm text-muted-foreground">
        Womit korrigiert Transkribor die Transkripte? Die Transkription selbst läuft immer lokal
        mit Whisper auf deiner GPU — nur die Korrektur und Sprecher-Zuordnung braucht ein Sprachmodell.
      </p>

      <Abschnitt titel="Transkription">
        {/* shadcn-Select ist ein <button>, kein <select> — htmlFor greift daran nicht.
            aria-labelledby ist hier die Bindung, die Screenreader tatsaechlich lesen. */}
        <label id="lbl-whisper" className="mb-1.5 block text-sm font-medium">Qualität der Transkription</label>
        <Select value={s.whisper_model} onValueChange={m => speichern({ whisper_model: m })}>
          <SelectTrigger className="w-full" aria-labelledby="lbl-whisper"><SelectValue /></SelectTrigger>
          <SelectContent>
            {s.whisper_choices.map(c => (
              <SelectItem key={c.id} value={c.id}>
                {c.label}{c.hint && ` — ${c.hint}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="mt-2 text-xs text-muted-foreground">
          {/* Ohne torch gibt es kein Rechenwerk, auf das man zeigen könnte — und ein
              CUDA-Hinweis wäre dann die falsche Fährte: es fehlt die ganze Umgebung. */}
          {!hw ? 'Gerät wird ermittelt …'
            : hw.torch_ok
              ? <>Rechnet auf: <span className="font-medium text-foreground">{hw.name}</span></>
              : <span className="text-amber-600 dark:text-amber-500">
                  Die Python-Umgebung ist unvollständig (PyTorch fehlt) — bitte Transkribor
                  neu starten und die Einrichtung durchlaufen lassen.
                </span>}
          {/* Auf `asr` prüfen, nicht auf `device`: seit faster-whisper gilt `device` nur noch
              für die Sprechertrennung. Auf einem Mac steht dort „mps“, während die
              Transkription auf der CPU läuft — dieser Hinweis wäre sonst genau dort still,
              wo er am nötigsten ist. */}
          {hw?.torch_ok && hw.asr === 'cpu' && (
            <span className="block text-amber-600 dark:text-amber-500">
              {s.whisper_model.startsWith('large')
                ? 'Ohne GPU braucht „Beste Qualität“ auf der CPU sehr lange — für längere Interviews besser „Schnell und gut“ wählen. '
                : ''}
              {hw.device === 'mps'
                ? 'Die Transkription könnte hier die Apple-GPU nutzen und wäre damit rund sechsmal schneller. Dafür fehlt whisper-cpp — einmalig „brew install whisper-cpp“ im Terminal, dann Transkribor neu starten.'
                : 'Wenn dieser Rechner eine NVIDIA-Grafikkarte hat, wurde PyTorch ohne CUDA installiert — dann die Umgebung neu einrichten.'}
            </span>
          )}
        </p>
      </Abschnitt>

      <Abschnitt titel="Video-Import">
        {/* Natives <input type="checkbox"> wie im MehrsprachigKasten — components/ui/ hat
            kein Checkbox-Bauteil, und eines dafür zu ziehen waere eine Abhaengigkeit fuer
            einen Haken. */}
        <label className="flex cursor-pointer items-start gap-2.5 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-primary"
            checked={s.ytdlp_auto === '1'}
            disabled={ytLaeuft}
            // Kein Nachladen: die PUT-Antwort trägt den `ytdlp`-Block seit dem Fix selbst.
            // Vorher stand hier ein zweiter Aufruf, dessen Fehlschlag die Anzeige stehen
            // liess — ein Weg weniger, der schiefgehen kann.
            onChange={e => speichern({ ytdlp_auto: e.target.checked ? '1' : '0' })}
          />
          <span>
            <span className="font-medium">Videodownloader aktuell halten</span>
            <span className="mt-1 block text-xs text-muted-foreground">
              {/* Bis #253 stand hier „prüft das beim Importieren selbst" — das stimmte für
                  BEIDE Wege und stimmt jetzt nur noch für den zweiten. Die Kalenderprüfung
                  läuft beim Start, damit niemand vor einem Import auf pip wartet. Ein Satz,
                  den der Umbau still falsch gemacht hätte; aufgefallen erst im Browser. */}
              YouTube und Instagram ändern ihre Seiten ständig — ohne Aktualisierung schlägt
              der Import irgendwann fehl. Transkribor prüft das beim Start im Hintergrund und
              versucht es ausserdem sofort, wenn ein Download nach einem veralteten
              Downloader aussieht.
            </span>
          </span>
        </label>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" onClick={ytJetzt} disabled={ytLaeuft}>
            {ytLaeuft ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            {ytLaeuft ? 'Aktualisiere …' : 'Jetzt aktualisieren'}
          </Button>
          <span className="text-xs text-muted-foreground">
            {/* Drei Zustände, nicht zwei: `version: null` heisst seit #185 auch "Metadaten
                nicht lesbar", und dafür war "Nicht installiert" das Gegenteil der Wahrheit —
                der Import lief. Die Unterscheidung kommt vom Server (`unlesbar`), nicht aus
                einer Ableitung hier. */}
            {/* Ein Lauf, der schon stand, als die Seite geladen wurde (Reload mitten in pip):
                der Knopf bleibt bedienbar — ein Klick hängt sich per `gestartet: false` an
                den laufenden —, aber schweigen darf die Seite darüber nicht. Übernommen wird
                der Lauf bewusst NICHT automatisch: das setzte `ytLaeuft` sofort wieder hoch
                und machte die Obergrenze der Warteschleife wirkungslos (der Test „gibt die
                Nachfragerei nach einer Obergrenze auf" hat genau das aufgedeckt). */}
            {/* **Waehrend eines Laufs wird die Fassung gar nicht erst bewertet (#225).** Der
                Poll fragt alle 1,5 s `GET /api/settings`, und das geht durch
                `_fassung_und_lesbarkeit()` → `metadata.version("yt-dlp")` — also **waehrend pip
                site-packages umschreibt**. Landet eine Runde in pips Deinstallations-/
                Installationsluecke, wirft das `PackageNotFoundError`, ergibt `(None, False)`,
                und hier stand dann „Nicht installiert — der Import steht nicht zur Verfuegung":
                dieselbe Luege, gegen die #189 gebaut wurde, ausgerechnet mitten in einer
                Aktualisierung, die gerade dabei ist, es zu installieren — und in dem Moment,
                in dem der Nutzer ausdruecklich hinschaut, weil er eben geklickt hat.
                Fuer den **Knopf-Lauf** gab es das Fenster vorher nicht: `getSettings()` lief
                genau EINMAL, nach pip.
                `ytLaeuft` steht vorn, weil es dominiert und weil es die bis zu 1,5 s zwischen
                Klick und erstem Poll deckt — dort ist `s` noch der Stand von vorher.
                **Der fetch-Subprozess zählt seit #243 mit.** `laeuft` kam aus `_lauf`, und das
                ist Modulzustand je PROZESS: aktualisierte der Import (`fetch.py` →
                `automatisch()`, auch die Selbstheilung nach einem Fehlversuch), meldete der
                Server `laeuft: false` und dieselbe Lüge war wieder erreichbar — auf einem Weg,
                den die README sogar empfiehlt. `zustand()` fragt dafür die pip-Sperre mit. */}
            {ytLaeuft
              ? 'Die Fassung steht fest, sobald der Lauf fertig ist.'
              : s.ytdlp.laeuft
              ? ytAufgegeben
                ? 'Eine Aktualisierung läuft ungewöhnlich lange — Transkribor fragt nicht '
                  + 'mehr von selbst nach. Klicke, um wieder zuzusehen.'
                : 'Eine Aktualisierung läuft gerade — klicke, um ihr zuzusehen.'
              : s.ytdlp.version
              ? <>Fassung <span className="font-medium text-foreground">{s.ytdlp.version}</span>
                {s.ytdlp.geprueft && ` · zuletzt geprüft am ${tag(s.ytdlp.geprueft)}`}</>
              : s.ytdlp.unlesbar
                ? 'Fassung nicht lesbar — die automatische Aktualisierung ist ausgesetzt.'
                : 'Nicht installiert — der Import von Video-URLs steht damit nicht zur Verfügung.'}
          </span>
        </div>

        {/* #198: sind die Metadaten von `yt-dlp-ejs` kaputt, fällt die Erkennung untauglicher
            Löserskripte STILL aus — `_ejs_untauglich()` sagt dann „unbekannt ⇒ nicht flaggen"
            (richtig: ein Flag, den pip nicht löschen kann, wäre ein tägliches pip ohne Ende),
            und der Server meldete daneben einen kerngesunden Stand. Was übrig bleibt, ist ein
            sporadischer 403 beim Import, dessen Meldung in die falsche Richtung zeigt.
            Nur die AUSKUNFT, nicht die Entscheidung — deshalb ein Hinweis und kein Fehler.

            **Während eines Laufs schweigt der Hinweis — dieselbe Regel wie bei der
            Fassungszeile (#225), und aus derselben Quelle:** `zustand()` liest die
            ejs-Metadaten bei JEDEM Poll, also auch, während pip `site-packages` umschreibt.
            Eine halb geschriebene `METADATA` trifft dort die Ausnahme-Stufe und ergibt
            `ejs_unlesbar: true`. Der Hinweis rät zu einer Neueinrichtung — mitten in einer
            laufenden Aktualisierung ist genau das der falsche Rat.
            Gate auf BEIDE Läufe, nicht nur `ytLaeuft`: seit #243 kann auch ein fremder
            Prozess pippen, und dessen Fenster ist dasselbe. (CodeRabbit-Bot an PR #246;
            der Vorschlag nannte nur `ytLaeuft` — die zweite Hälfte gehört dazu.) */}
        {!ytLaeuft && !s.ytdlp.laeuft && s.ytdlp.ejs_unlesbar && (
          <p className="mt-3 text-xs text-amber-600 dark:text-amber-500">
            Die Hilfsskripte für YouTube lassen sich nicht prüfen — ihre Paketdaten sind
            beschädigt. Importieren geht weiter, Transkribor merkt nur nicht mehr von selbst,
            wenn die Skripte nicht mehr passen. „Jetzt aktualisieren“ hilft hier nicht (die
            Installation stolpert über dieselbe Datei) — nötig ist eine Neueinrichtung.
          </p>
        )}

        {/* Ein Haken, der nichts tut, ist schlimmer als keiner: die Umgebungsvariable
            gewinnt gegen die Einstellung, und ohne diesen Satz sähe man nur den Haken.
            Der Server sagt `env` — ein Vergleich `ytdlp.auto !== (ytdlp_auto === '1')` stand
            hier zuerst und behauptete zwischen PUT-Antwort und Nachladen ein Override, das
            es nicht gab (die PUT-Antwort trägt `ytdlp_auto`, aber keinen `ytdlp`-Block). */}
        {s.ytdlp.env && (
          <p className="mt-3 text-xs text-amber-600 dark:text-amber-500">
            Diese Einstellung ist gerade wirkungslos: <code>TRANSKRIBOR_YTDLP_UPDATE</code> in
            der Umgebung überstimmt sie und schaltet die automatische Aktualisierung
            {s.ytdlp.auto ? ' ein' : ' aus'}.
          </p>
        )}
      </Abschnitt>

      {s.kaputt && (
        <div className="mb-6 rounded-lg border border-amber-500/50 bg-amber-500/10 p-4 text-sm">
          <span className="font-medium">Deine gespeicherten Einstellungen waren beschädigt.</span>{' '}
          Transkribor arbeitet seitdem mit den Standardwerten — ein hinterlegter API-Key ist
          damit nicht mehr eingetragen. Die alte Datei wurde nicht gelöscht: sie liegt unter{' '}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono break-all">{s.kaputt}</code>{' '}
          und lässt sich mit einem Texteditor öffnen — der Key steht dort meist noch lesbar drin.
          <div className="mt-3">
            <Button variant="outline" size="sm" onClick={kaputtWeg} disabled={kaputtLaeuft}>
              Erledigt — Datei entfernen
            </Button>
          </div>
        </div>
      )}

      {!s.ai_ready && (
        <div className="mb-6 rounded-lg border border-amber-500/50 bg-amber-500/10 p-4 text-sm">
          <span className="font-medium">Korrektur ist nicht eingerichtet.</span>{' '}
          {s.ai_reason} Die Transkription funktioniert trotzdem — nur die Korrektur und
          Sprecher-Zuordnung brauchen ein Sprachmodell.
        </div>
      )}

      <Abschnitt titel="Korrektur">
        <label id="lbl-anbieter" className="mb-1.5 block text-sm font-medium">Anbieter</label>
        <Select value={s.provider} onValueChange={anbieterWechseln}>
          <SelectTrigger className="w-full" aria-labelledby="lbl-anbieter"><SelectValue /></SelectTrigger>
          <SelectContent>
            {s.providers.map(p => <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>)}
          </SelectContent>
        </Select>
        {prov?.hint && <p className="mt-1.5 text-xs text-muted-foreground">{prov.hint}</p>}

        {prov && (
          <div className="mt-6 space-y-6">
            {/* Abo-CLIs bringen ihre eigene Anmeldung mit — bis hierher sagte die App nur,
                ob das Programm INSTALLIERT ist, und meldete grün, während niemand
                angemeldet war. Die Korrektur scheiterte dann erst mitten im Lauf. */}
            {/* `key` am Anbieter: sonst behält der Block beim Umstellen seinen laufenden
                Vorgang im State und zeigt die URL des ALTEN Anbieters unter der neuen
                Überschrift. Der Server filtert zusätzlich — beides ist nötig, weil der
                State hier lokal ist und nicht auf einen Serverwechsel wartet. */}
            {istCli && autz && (
              <AnmeldungAbo key={s.provider} status={autz} neuPruefen={autzLaden} />
            )}

            {prov.id === 'custom' && (
              <div>
                <label htmlFor="feld-basis-url" className="mb-1.5 block text-sm font-medium">Basis-URL</label>
                <Input id="feld-basis-url" defaultValue={s.base_url} placeholder="http://localhost:11434/v1"
                  onBlur={e => e.target.value !== s.base_url && speichern({ base_url: e.target.value })} />
              </div>
            )}

            {/* Abo-CLIs bringen ihre eigene Anmeldung mit (`claude`/`codex login`) — ein
                Key-Feld waere dort nicht nur nutzlos, sondern eine falsche Aufforderung. */}
            {!istCli && (
            <div>
              <label htmlFor="feld-key" className="mb-1.5 block text-sm font-medium">API-Key</label>
              <div className="flex gap-2">
                <Input id="feld-key" type="password" value={key} onChange={e => setKey(e.target.value)}
                  placeholder={s.has_key ? '•••••••• (gespeichert)' : 'sk-…'} autoComplete="off" />
                <Button variant="outline" disabled={!key}
                  onClick={() => speichern({ api_key: key }, () => { setKey(''); toast.success('Key gespeichert') })}>
                  <KeyRound className="size-4" /> Key speichern
                </Button>
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                Wird nur lokal in deinem Benutzerprofil gespeichert und nie wieder angezeigt.
                {prov.keys_url && <> <a className="underline underline-offset-2 hover:text-foreground" href={prov.keys_url} target="_blank" rel="noreferrer">Key erstellen</a></>}
                {s.env_key && <> · Umgebungsvariable {s.env_key} ist gesetzt.</>}
              </p>
            </div>
            )}

            <div>
              <label id="lbl-modell" htmlFor="feld-modell" className="mb-1.5 block text-sm font-medium">Modell</label>
              <div className="flex gap-2">
                {modelle.length > 0 ? (
                  <Select value={s.model} onValueChange={m => speichern({ model: m })}>
                    <SelectTrigger className="w-full" aria-labelledby="lbl-modell"><SelectValue placeholder="Modell wählen" /></SelectTrigger>
                    <SelectContent>
                      {modelle.map(m => <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                ) : (
                  /* `key` erzwingt einen Neuaufbau, wenn Anbieter oder Modell wechseln.
                     Ohne ihn behält das unkontrollierte Feld seinen `defaultValue`: beim
                     Wechsel von Claude zu Codex stand dort weiter „opus“, und der nächste
                     Klick schrieb es über `onBlur` als Codex-Modell ZURÜCK — ein
                     Claude-Alias, an dem `codex exec -m opus` scheitert. Während des
                     Tippens ändert sich `s.model` nicht (gespeichert wird erst bei
                     onBlur), der Schlüssel ist also stabil, solange das Feld den Fokus hat. */
                  <Input id="feld-modell" key={`${s.provider}|${s.model}`}
                    defaultValue={s.model} placeholder="Modellname"
                    onBlur={e => e.target.value !== s.model && speichern({ model: e.target.value })} />
                )}
                {/* Pfeilfunktion, nicht `onClick={modelleLaden}`: sonst landet das
                    MouseEvent im `leise`-Parameter und ist wahr — der Knopf schwiege
                    bei genau dem Fehler, dessentwegen man ihn drueckt. */}
                <Button variant="outline" onClick={() => modelleLaden()} disabled={laedt} title="Modelle neu vom Anbieter laden">
                  {laedt ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                  <span className="sr-only">Modelle neu vom Anbieter laden</span>
                </Button>
              </div>
            </div>
          </div>
        )}

        <div className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-2 border-t pt-5">
          <Button onClick={testen} disabled={testet}>
            {testet && <Loader2 className="size-4 animate-spin" />} Verbindung testen
          </Button>
          <span className="text-xs text-muted-foreground">
            Änderungen greifen sofort — auch für schon laufende Korrekturen ab dem nächsten Block.
          </span>
        </div>
      </Abschnitt>

      {/* Nichts einzustellen — der Abschnitt bleibt, weil er die CC-BY-Namensnennung fuer die
          mitgelieferten Gewichte traegt (siehe LICENSE-MODELLE.md). */}
      <Abschnitt titel="Sprecher-Erkennung">
        <p className="text-sm">
          Transkribor trennt die Sprecher akustisch und braucht dafür weder Konto noch Token.
        </p>
        <p className="mt-1.5 text-xs text-muted-foreground">
          Modell:&nbsp;
          <a className="underline underline-offset-2 hover:text-foreground" href="https://huggingface.co/pyannote/speaker-diarization-community-1" target="_blank" rel="noreferrer">
            pyannote speaker-diarization-community-1</a>, mitgeliefert unter&nbsp;
          <a className="underline underline-offset-2 hover:text-foreground" href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a>.
        </p>
      </Abschnitt>

      {/* #218: Das Versprechen der App ist „deine Aufnahmen bleiben bei dir". Die Kehrseite —
          *und du allein bist dafür verantwortlich* — stand nirgends: der Pfad war genau einmal
          zu sehen, im Einrichtungsfenster, und danach nie wieder. „Benutzerordner" heisst für
          einen nicht-technischen Menschen *Dokumente*, nicht `%APPDATA%\Transkribor`.
          Der Pfad steht deshalb AUCH im Browser (er beantwortet die Frage ohne Klick); der
          Knopf gibt es nur in der App, wo eine Shell dahinterliegt. */}
      <Abschnitt titel="Deine Dateien">
        {/* „legt Transkribor ab" statt „liegen": ausserhalb der App wird der Ordner erst beim
            ersten Projekt angelegt (`electron/backend.js` tut es beim Start, `webtool.ps1`
            nicht) — „hier liegen deine Dateien" wäre dort vor dem ersten Projekt falsch. */}
        <p className="max-w-prose text-sm">
          Aufnahmen und Transkripte legt Transkribor in diesem Ordner ab. Gelöscht wird dort
          nichts von allein — und weil nichts davon in einer Cloud liegt, gibt es auch keine
          Sicherung ausser deiner eigenen: kopiere den Ordner auf eine externe Platte, dann hast
          du alles. Auf einen neuen Rechner nimmst du deine Arbeit mit, indem du ihn dorthin
          kopierst.
        </p>
        <p className="mt-2 break-all rounded bg-muted px-2 py-1.5 font-mono text-xs text-muted-foreground">
          {s.projekte_pfad}
        </p>
        {ordnerOeffnen && (
          <Button className="mt-3" variant="outline" onClick={async () => {
            // Der Handler nimmt bewusst KEINEN Pfad entgegen — er kennt ihn selbst. Ein
            // Parameter machte aus der schmalen Brücke ein „öffne beliebiges Verzeichnis"
            // für alles, was in diesem Fenster läuft, und dort läuft Transkripttext, der aus
            // einem URL-Import stammen kann.
            try { await ordnerOeffnen() }
            catch (e) { toast.error(`Ordner öffnen fehlgeschlagen: ${(e as Error).message}`) }
          }}>
            <FolderOpen className="size-4" /> Ordner öffnen
          </Button>
        )}
      </Abschnitt>

      {upd && (
        <Abschnitt titel="Version und Updates">
          <p className="text-sm">
            <span className="font-medium">Transkribor {upd.version}</span>
            {upd.art === 'aktuell' && <span className="text-muted-foreground"> · aktuell</span>}
          </p>

          {(upd.art === 'unbekannt' || upd.art === 'aktuell' || upd.art === 'prueft' || upd.art === 'fehler') && (
            <Button className="mt-3" variant="outline" disabled={upd.art === 'prueft'} onClick={pruefen}>
              {upd.art === 'prueft'
                ? <><Loader2 className="size-4 animate-spin" /> Wird geprüft …</>
                : 'Nach Updates suchen'}
            </Button>
          )}

          {upd.art === 'verfuegbar' && (
            <div className="mt-3">
              <p className="text-sm">{upd.neue} verfügbar</p>
              <Button className="mt-2" onClick={laden}>
                Herunterladen{upd.groesse != null && ` (${mb(upd.groesse)} MB)`}
              </Button>
            </div>
          )}

          {upd.art === 'verfuegbar_manuell' && (
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

          {upd.art === 'laedt' && (
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

          {upd.art === 'bereit' && (
            <div className="mt-3">
              <p className="text-sm">{upd.neue} ist bereit.</p>
              <Button className="mt-2" onClick={installieren}>Neu starten und installieren</Button>
            </div>
          )}

          {upd.art === 'fehler' && (
            <p className="mt-3 text-sm text-muted-foreground">
              Prüfung fehlgeschlagen: {upd.text} — Einzelheiten stehen im{' '}
              <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={protokollOeffnen}>Protokoll</button>.
            </p>
          )}

          {upd.art === 'nicht_moeglich' && (
            <p className="mt-3 text-sm text-muted-foreground">
              {GRUENDE[upd.grund] ?? 'Updates sind auf diesem System nicht möglich.'}{' '}
              <a className="underline underline-offset-2 hover:text-foreground" href={RELEASES} target="_blank" rel="noreferrer">Versionen ansehen</a>
            </p>
          )}
        </Abschnitt>
      )}
    </div>
  )
}
