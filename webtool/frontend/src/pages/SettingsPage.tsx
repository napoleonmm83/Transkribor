import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { KeyRound, Loader2, LogIn, RefreshCw } from 'lucide-react'
import {
  cancelLogin, getAuth, getHardware, getSettings, listModels, loginState,
  saveSettings, startLogin, submitLoginCode, testSettings, updateYtdlp,
} from '@/lib/api'
import { useUpdate } from '@/hooks/useUpdate'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { AuthStatus, Hardware, LoginState, ModelInfo, ProviderInfo, Settings } from '@/lib/types'

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

/** Anmeldung an einer Abo-CLI. Zwei Wege, eine Oberflaeche:
 *  - Claude gibt eine URL aus und WARTET auf einen Code aus dem Browser (`braucht_code`).
 *  - Codex zeigt URL und Code an, der Nutzer tippt sie dort ein, die CLI merkt es selbst.
 *  Deshalb haengt das Eingabefeld an `braucht_code` und nicht am Anbieternamen. */
function AnmeldungAbo({ status, neuPruefen }: { status: AuthStatus; neuPruefen: () => void }) {
  const [lauf, setLauf] = useState<LoginState | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)

  // Nur solange etwas laeuft gepollt — ein Dauerintervall auf einer Einstellungsseite,
  // auf der meistens nichts passiert, ist reine Last.
  useEffect(() => {
    if (!lauf?.laeuft) return
    const t = setInterval(async () => {
      const z = await loginState().catch(() => null)
      if (!z) return
      setLauf(z)
      if (!z.laeuft) {
        neuPruefen()
        if (z.ok) toast.success('Angemeldet')
        else toast.error(z.fehler || 'Anmeldung fehlgeschlagen')
      }
    }, 1500)
    return () => clearInterval(t)
  }, [lauf?.laeuft, neuPruefen])

  const starten = async () => {
    setBusy(true); setCode('')
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

export function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null)
  const [modelle, setModelle] = useState<ModelInfo[]>([])
  // Nur das NEU Eingetippte; die gespeicherten Geheimnisse kommen nie zum Frontend zurueck.
  const [key, setKey] = useState('')
  const [laedt, setLaedt] = useState(false)
  const [testet, setTestet] = useState(false)
  const [ytLaeuft, setYtLaeuft] = useState(false)
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

  const speichern = async (patch: Record<string, string>, danach?: () => void) => {
    try {
      const neu = await saveSettings(patch)
      setS(cur => cur && { ...cur, ...neu })
      danach?.()
    } catch (e) { toast.error(`Speichern fehlgeschlagen: ${(e as Error).message}`) }
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

  // Der Knopf holt die Einstellungen danach neu: Fassung und Prüfdatum stehen dort, und ohne
  // das Nachladen bliebe die Anzeige auf dem Stand von vor dem Klick.
  const ytJetzt = async () => {
    setYtLaeuft(true)
    try {
      const r = await updateYtdlp()
      r.ok ? toast.success(`yt-dlp ist jetzt auf ${r.version}`)
        : toast.error('Aktualisierung fehlgeschlagen — bist du online?')
      await getSettings().then(setS)
    } catch (e) { toast.error(String(e)) } finally { setYtLaeuft(false) }
  }

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
              YouTube und Instagram ändern ihre Seiten ständig — ohne Aktualisierung schlägt
              der Import irgendwann fehl. Transkribor prüft das beim Importieren selbst und
              versucht es sofort, wenn ein Download nach einem veralteten Downloader aussieht.
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
            {s.ytdlp.version
              ? <>Fassung <span className="font-medium text-foreground">{s.ytdlp.version}</span>
                {s.ytdlp.geprueft && ` · zuletzt geprüft am ${tag(s.ytdlp.geprueft)}`}</>
              : s.ytdlp.unlesbar
                ? 'Fassung nicht lesbar — der Import von Video-URLs läuft weiter, nur die automatische Aktualisierung ist ausgesetzt.'
                : 'Nicht installiert — der Import von Video-URLs steht damit nicht zur Verfügung.'}
          </span>
        </div>

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
