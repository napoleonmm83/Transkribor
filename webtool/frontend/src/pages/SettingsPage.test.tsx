import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { toast } from 'sonner'
import { SettingsPage } from './SettingsPage'
import * as api from '@/lib/api'
import type { Hardware, LoginState, Settings } from '@/lib/types'

vi.mock('@/lib/api')
// Ohne diesen Mock waere `expect(toast.error).not.toHaveBeenCalled()` keine Zusicherung,
// sondern ein Aufruf an eine echte Funktion, die immer "nicht aufgerufen" meldet.
// `info` gehört mit hinein, seit der yt-dlp-Knopf „läuft bereits" meldet (#174) — ein
// fehlender Schlüssel wirft hier `toast.info is not a function` statt still nichts zu tun.
// `warning` seit #194 (ungeschützt geschrieben), aus demselben Grund.
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

const BASIS: Settings = {
  provider: 'claude-cli', model: '', base_url: '', has_key: false, env_key: '',
  whisper_model: 'large-v3', whisper_lang: 'de',
  whisper_choices: [
    { id: 'turbo', label: 'Schnell und gut', hint: 'nahe large-Qualität' },
    { id: 'large-v3', label: 'Beste Qualität', hint: 'bester Dialekt' },
  ],
  ai_ready: true, ai_reason: '',
  kaputt: '',
  projekte_pfad: 'C:\\Users\\test\\AppData\\Roaming\\Transkribor\\projekte',
  parallel: '3', parallel_max: 16, parallel_default: '3', parallel_env: '',
  ytdlp_auto: '1',
  ytdlp: { version: '2026.8.12', unlesbar: false, geprueft: '2026-08-13', auto: true, env: false, laeuft: false, ergebnis: '', ungeschuetzt: false, unterbrochen: false, ejs_unlesbar: false },
  providers: [
    { id: 'claude-cli', label: 'Claude Code Abo (kein Key)', needs_key: false, cli: true, base: '', default_model: 'opus', keys_url: '', hint: 'Nutzt das Abo.' },
    { id: 'codex-cli', label: 'ChatGPT-Abo (Codex CLI, kein Key)', needs_key: false, cli: true, base: '', default_model: '', keys_url: '', hint: 'Nutzt das ChatGPT-Abo.' },
    { id: 'anthropic', label: 'Anthropic (Claude)', needs_key: true, cli: false, base: 'https://api.anthropic.com/v1', default_model: 'claude-opus-5', keys_url: 'https://x', hint: '' },
  ],
}

// Die PUT-Antwort ist `Settings` PLUS `ungeschuetzt` (#194) — ein Feld, das nur diesem einen
// Schreibvorgang gilt und deshalb nicht in `Settings` steht. Es ist Pflicht, nicht optional:
// müsste keine Attrappe es nennen, verschwände die Warnung still, wenn der Server aufhörte, es
// zu schicken. Der Normalfall steht hier einmal statt fünfmal.
const GESPEICHERT = { ...BASIS, ungeschuetzt: false }

const zeige = (s: Partial<Settings> = {}, hw: Hardware = { device: 'cuda', name: 'NVIDIA RTX 5080', torch_ok: true, asr: 'cuda' }) => {
  vi.mocked(api.getSettings).mockResolvedValue({ ...BASIS, ...s })
  vi.mocked(api.getHardware).mockResolvedValue(hw)
  return render(<MemoryRouter><SettingsPage /></MemoryRouter>)
}

describe('SettingsPage', () => {
  // Der Automock von '@/lib/api' liefert sonst `undefined` — eine Antwort, die die echte
  // API nie gibt. Seit die Seite von selbst laedt, traefe die JEDEN Test mit Anbieter.
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.listModels).mockResolvedValue([])
    // Vorgabe „kein Anmeldezustand“ — der Anmeldeblock bleibt damit aus allen Tests
    // heraus, die ihn nicht meinen. Ohne die Vorgabe liefert der Automock `undefined`,
    // und `.then` darauf reisst jeden Test um.
    vi.mocked(api.getAuth).mockResolvedValue({ unterstuetzt: false, angemeldet: false, detail: '' })
  })

  it('zeigt im Abo kein Key-Feld — aber sehr wohl die Modellwahl', async () => {
    // Das Abo bringt seine Anmeldung selbst mit; ein Key-Feld waere eine falsche
    // Aufforderung. Das Modell ist trotzdem waehlbar: `claude --model` nimmt Aliase,
    // und bei leerem Opus-Kontingent will man auf sonnet ausweichen koennen.
    vi.mocked(api.listModels).mockResolvedValue([{ id: 'opus', label: 'opus' }, { id: 'sonnet', label: 'sonnet' }])
    zeige({ model: 'opus' })
    expect(await screen.findByText(/Nutzt das Abo/)).toBeInTheDocument()
    expect(screen.queryByText('API-Key')).not.toBeInTheDocument()
    expect(await screen.findByText('Modell')).toBeInTheDocument()
  })

  it('nennt die beiseitegelegte Einstellungsdatei und laesst sie entfernen', async () => {
    // #192: der Server ersetzt eine unlesbare Einstellungsdatei nicht mehr still durch
    // Standardwerte, sondern legt sie als .kaputt beiseite — dort steht meist noch der
    // API-Key. Eine Rettung, die niemand erwaehnt, ist so gut wie keine; und der Hinweis
    // braucht ein Ende, sonst steht er fuer immer da.
    vi.mocked(api.verwerfeKaputt).mockResolvedValue(undefined)
    zeige({ kaputt: 'C:\\Users\\m\\AppData\\Roaming\\Transkribor\\settings.json.kaputt' })
    expect(await screen.findByText(/settings\.json\.kaputt/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Datei entfernen/ }))
    await waitFor(() => expect(api.verwerfeKaputt).toHaveBeenCalled())
    // Kein Nachladen: der Hinweis verschwindet aus dem lokalen Stand — ein zweiter Aufruf
    // waere ein weiterer Weg, der schiefgehen kann (dieselbe Regel wie beim ytdlp-Haken).
    await waitFor(() => expect(screen.queryByText(/settings\.json\.kaputt/)).toBeNull())
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('schickt den zweiten Klick eines Doppelklicks nicht hinterher', async () => {
    // Die Datei ist nach dem ersten DELETE weg, der zweite bekaeme 404 — der Nutzer saehe
    // fuer eine geglueckte Aktion einen Fehler-Toast. Der Knopf sperrt sich deshalb, solange
    // die Anfrage laeuft (CodeRabbit-CLI an PR #203).
    let loesen: () => void = () => {}
    vi.mocked(api.verwerfeKaputt).mockReturnValue(new Promise<void>(r => { loesen = r }))
    zeige({ kaputt: 'C:\\x\\settings.json.kaputt' })
    const knopf = await screen.findByRole('button', { name: /Datei entfernen/ })
    fireEvent.click(knopf)
    fireEvent.click(knopf)
    expect(api.verwerfeKaputt).toHaveBeenCalledTimes(1)
    await act(async () => { loesen() })
  })

  it('bietet im Abo die Modell-Aliase zur Auswahl an', async () => {
    // Aliase, nicht konkrete IDs: 'opus' zeigt immer auf die neueste Generation.
    vi.mocked(api.listModels).mockResolvedValue([{ id: 'opus', label: 'opus' }, { id: 'sonnet', label: 'sonnet' }])
    zeige({ model: 'opus' })
    await waitFor(() => expect(api.listModels).toHaveBeenCalled())
    expect(await screen.findByText('opus')).toBeInTheDocument()
  })

  it('zeigt auch beim Codex-Abo kein Key-Feld', async () => {
    // Zweites Abo, gleiche Regel — und der Beweis, dass die Entscheidung am `cli`-Merkmal
    // des Servers haengt und nicht an einer Namensliste im Frontend.
    zeige({ provider: 'codex-cli' })
    // Auf den Hinweistext prüfen, nicht auf das Label: das steht auch im Auswahlmenü.
    expect(await screen.findByText(/Nutzt das ChatGPT-Abo/)).toBeInTheDocument()
    expect(screen.queryByText('API-Key')).not.toBeInTheDocument()
    expect(await screen.findByText('Modell')).toBeInTheDocument()
  })

  it('zeigt einen gespeicherten Key nie im Klartext', async () => {
    // has_key=true ist alles, was das Frontend erfaehrt — der Key selbst kommt nie ueber die API.
    const { container } = zeige({ provider: 'anthropic', model: 'claude-opus-5', has_key: true })
    const feld = await screen.findByPlaceholderText(/gespeichert/)
    expect(feld).toHaveAttribute('type', 'password')
    expect((feld as HTMLInputElement).value).toBe('')
    expect(container.textContent).not.toMatch(/sk-/)
  })

  it('speichert einen neuen Key und leert danach das Feld', async () => {
    vi.mocked(api.saveSettings).mockResolvedValue({ ...GESPEICHERT, provider: 'anthropic', has_key: true })
    zeige({ provider: 'anthropic' })
    const feld = await screen.findByPlaceholderText('sk-…')
    await act(async () => { fireEvent.change(feld, { target: { value: 'sk-neu' } }) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Key speichern/ })) })
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({ api_key: 'sk-neu' }))
    expect((feld as HTMLInputElement).value).toBe('')
  })

  it('holt die Modellliste von selbst und bietet sie zur Auswahl an', async () => {
    vi.mocked(api.listModels).mockResolvedValue([{ id: 'claude-opus-5', label: 'Claude Opus 5' }])
    zeige({ provider: 'anthropic', has_key: true, model: 'claude-opus-5' })
    // Ohne Klick: der Knopf war da, aber niemand fand ihn — dann tippt man Modell-IDs ab.
    await waitFor(() => expect(api.listModels).toHaveBeenCalled())
    // Aus dem Textfeld ist eine Auswahl geworden.
    await waitFor(() => expect(screen.queryByPlaceholderText('Modellname')).not.toBeInTheDocument())
    expect(await screen.findByText('Claude Opus 5')).toBeInTheDocument()
  })

  it('fragt ohne hinterlegten Key gar nicht erst beim Anbieter an', async () => {
    // Anthropic braucht einen Key. Ohne ihn ist die Anfrage ein sicherer Fehlschlag —
    // den bei jedem Seitenaufbau zu bezahlen, waere sinnlos.
    zeige({ provider: 'anthropic', has_key: false })
    await screen.findByText('Modell')
    expect(api.listModels).not.toHaveBeenCalled()
    expect(screen.getByPlaceholderText('Modellname')).toBeInTheDocument()
  })

  it('behält im Modellfeld keinen überholten Wert, wenn sich das gespeicherte Modell ändert', async () => {
    // Aus dem Feld: von Claude (Alias „opus“) auf Codex gewechselt — im unkontrollierten
    // Textfeld stand weiter „opus“, und der nächste Klick schrieb es per onBlur als
    // Codex-Modell ZURÜCK. `codex exec -m opus` scheitert daran.
    // Hier über das Key-Speichern ausgelöst, weil das denselben Weg nimmt: `s` ändert sich,
    // während die Komponente montiert bleibt — genau die Lage, in der `defaultValue` klebt.
    vi.mocked(api.saveSettings).mockResolvedValue({ ...GESPEICHERT, provider: 'anthropic', has_key: true, model: '' })
    zeige({ provider: 'anthropic', has_key: true, model: 'opus' })
    const feld = await screen.findByPlaceholderText('Modellname')
    expect((feld as HTMLInputElement).value).toBe('opus')

    const keyFeld = screen.getByPlaceholderText(/gespeichert/)
    await act(async () => { fireEvent.change(keyFeld, { target: { value: 'sk-neu' } }) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Key speichern/ })) })

    const neu = await screen.findByPlaceholderText('Modellname')
    expect((neu as HTMLInputElement).value).toBe('')
    await act(async () => { fireEvent.blur(neu) })
    expect(api.saveSettings).not.toHaveBeenCalledWith(expect.objectContaining({ model: 'opus' }))
  })

  it('bleibt beim Textfeld, wenn der Anbieter keine Liste kennt', async () => {
    // Codex hat keinen Befehl, der Modelle auflistet — die leere Liste ist hier kein
    // Fehler, sondern die Wahrheit. Leer lassen heisst: Voreinstellung der CLI.
    vi.mocked(api.listModels).mockResolvedValue([])
    zeige({ provider: 'codex-cli' })
    await waitFor(() => expect(api.listModels).toHaveBeenCalled())
    expect(await screen.findByPlaceholderText('Modellname')).toBeInTheDocument()
  })

  it('bleibt beim Textfeld, wenn das automatische Laden scheitert — ohne Fehlblase', async () => {
    // Ein abgelaufener Key darf beim blossen Oeffnen der Seite nicht rot aufpoppen.
    // Verschluckt wird nichts: das Textfeld bleibt, und der Knopf meldet weiterhin laut.
    vi.mocked(api.listModels).mockRejectedValue(new Error('401 invalid key'))
    zeige({ provider: 'anthropic', has_key: true })
    await waitFor(() => expect(api.listModels).toHaveBeenCalled())
    expect(await screen.findByPlaceholderText('Modellname')).toBeInTheDocument()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('der Knopf meldet den Fehler laut', async () => {
    vi.mocked(api.listModels).mockRejectedValue(new Error('401 invalid key'))
    zeige({ provider: 'anthropic', has_key: true })
    // Auf das ENDE des automatischen Ladelaufs warten, nicht nur auf seinen Start: der Knopf
    // ist `disabled={laedt}`, ein Klick waehrenddessen verpufft. "Aufgerufen" tritt sofort ein,
    // "fertig" erst mit der Antwort — auf langsamer CI lag der Klick dazwischen und der Test
    // wartete danach 1 s auf einen Toast, den niemand mehr ausloeste.
    const knopf = await screen.findByTitle(/Modelle neu vom Anbieter laden/)
    await waitFor(() => expect(knopf).not.toBeDisabled())
    await act(async () => { fireEvent.click(knopf) })
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('401')))
  })

  it('zeigt beim Abo den Anmeldezustand statt nur „installiert“', async () => {
    // Der eigentliche Zweck: vorher meldete die App grün, sobald das Programm da war —
    // nicht angemeldet fiel erst mitten in der Korrektur auf.
    vi.mocked(api.getAuth).mockResolvedValue({
      unterstuetzt: true, angemeldet: true, detail: 'Angemeldet als a@b.c (max)' })
    zeige()
    expect(await screen.findByText('Angemeldet als a@b.c (max)')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Neu anmelden/ })).toBeInTheDocument()
  })

  it('bietet bei fehlender Anmeldung einen Anmelde-Knopf', async () => {
    vi.mocked(api.getAuth).mockResolvedValue({
      unterstuetzt: true, angemeldet: false, detail: 'Nicht angemeldet.' })
    zeige()
    expect(await screen.findByText('Nicht angemeldet.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Anmelden/ })).toBeInTheDocument()
  })

  it('zeigt die Anmelde-URL und nimmt den Code entgegen (Claude-Weg)', async () => {
    vi.mocked(api.getAuth).mockResolvedValue({
      unterstuetzt: true, angemeldet: false, detail: 'Nicht angemeldet.' })
    vi.mocked(api.startLogin).mockResolvedValue({
      laeuft: true, url: 'https://claude.com/cai/oauth/authorize?x=1', braucht_code: true })
    vi.mocked(api.submitLoginCode).mockResolvedValue({ laeuft: true, braucht_code: true })
    zeige()
    const knopf = await screen.findByRole('button', { name: /^Anmelden/ })
    await act(async () => { fireEvent.click(knopf) })
    expect(await screen.findByRole('link', { name: /claude\.com/ })).toHaveAttribute(
      'href', 'https://claude.com/cai/oauth/authorize?x=1')
    const feld = screen.getByPlaceholderText(/Code aus dem Browser/)
    await act(async () => { fireEvent.change(feld, { target: { value: 'abc123' } }) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Bestätigen' })) })
    await waitFor(() => expect(api.submitLoginCode).toHaveBeenCalledWith('abc123'))
  })

  it('meldet EINEN Anmeldevorgang genau einmal, auch wenn zwei Polls sich überholen (#247)', async () => {
    // Dieselbe Klasse wie beim yt-dlp-Poll, andere Schleife: nicht gemeldet worden, aber
    // dieselbe Ursache — die Meldung hängt am Zustand, nicht am Übergang. Wer nur die eine
    // Stelle repariert, lässt den Nachbarn stehen.
    // Zugesichert wird hier der TOAST. Der doppelte `neuPruefen()`-Aufruf im selben Block
    // wäre die zweite Folge, ist aber nicht mitgeprüft (`getAuth` läuft schon beim Mount, es
    // bräuchte eine Basislinie) — deshalb steht er nicht als Zusage da.
    vi.mocked(api.getAuth).mockResolvedValue({
      unterstuetzt: true, angemeldet: false, detail: 'Nicht angemeldet.' })
    vi.mocked(api.startLogin).mockResolvedValue({ laeuft: true, braucht_code: false })
    zeige()
    const knopf = await screen.findByRole('button', { name: /^Anmelden/ })

    const offen: Array<(z: LoginState) => void> = []
    vi.mocked(api.loginState).mockImplementation(() => new Promise(res => { offen.push(res) }))

    vi.useFakeTimers()
    try {
      await act(async () => { fireEvent.click(knopf) })
      await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
      await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
      expect(offen).toHaveLength(2)          // Positivkontrolle: das Rennen fand statt
      await act(async () => {
        offen.forEach(aufloesen => aufloesen({ laeuft: false, fertig: true, ok: true }))
      })
    } finally {
      vi.useRealTimers()
    }

    expect(toast.success).toHaveBeenCalledTimes(1)
  })

  it('zeigt beim Geräte-Flow den Code an und verlangt keine Eingabe (Codex-Weg)', async () => {
    // Codex dreht die Richtung um: der Code gehört auf die Webseite, nicht in unser Feld.
    vi.mocked(api.getAuth).mockResolvedValue({
      unterstuetzt: true, angemeldet: false, detail: 'Not logged in' })
    vi.mocked(api.startLogin).mockResolvedValue({
      laeuft: true, url: 'https://auth.openai.com/device', code: 'ABCD-1234', braucht_code: false })
    zeige({ provider: 'codex-cli' })
    const knopf = await screen.findByRole('button', { name: /^Anmelden/ })
    await act(async () => { fireEvent.click(knopf) })
    expect(await screen.findByText('ABCD-1234')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/Code aus dem Browser/)).not.toBeInTheDocument()
  })

  it('zeigt die Whisper-Qualitätsstufe und das aktive Gerät', async () => {
    zeige()
    expect(await screen.findByText(/Qualität der Transkription/i)).toBeInTheDocument()
    expect(await screen.findByText(/NVIDIA RTX 5080/)).toBeInTheDocument()
  })

  it('warnt, wenn kein KI-Anbieter nutzbar ist', async () => {
    zeige({ ai_ready: false, ai_reason: 'Claude Code ist auf diesem Rechner nicht installiert.' })
    expect(await screen.findByText(/nicht installiert/)).toBeInTheDocument()
  })

  it('zeigt die yt-dlp-Fassung und das Prüfdatum', async () => {
    zeige()
    expect(await screen.findByText(/2026\.8\.12/)).toBeInTheDocument()
    // Deutsches Datum, nicht das ISO des Servers — im Browser-Screenshot sah `2026-08-13`
    // in einer sonst durchgehend deutschen Seite wie eine Fehlermeldung aus.
    expect(screen.getByText(/zuletzt geprüft am 13\.08\.2026/)).toBeInTheDocument()
  })

  it('sagt es, wenn yt-dlp gar nicht installiert ist', async () => {
    zeige({ ytdlp: { version: null, unlesbar: false, geprueft: '', auto: true, env: false, laeuft: false, ergebnis: '', ungeschuetzt: false, unterbrochen: false, ejs_unlesbar: false } })
    expect(await screen.findByText(/Nicht installiert/)).toBeInTheDocument()
  })

  it('ein FREMDER Lauf verdraengt die Fassungszeile — auch ohne Fassung', async () => {
    // **Kein Regressionstest fuer #225**, und das gehoert in den Namen: die alte Bedingung
    // `s.ytdlp.laeuft && !ytLaeuft` war hier ebenfalls wahr (nie geklickt), der Test waere auf
    // master genauso gruen gewesen. Er sichert den Nachbarfall aus #174 (Reload mitten in einem
    // fremden Lauf) und dass es das Gate ueberhaupt gibt — nimmt man es ganz weg, wird er rot.
    // Den Fix selbst sichert der Test „sagt waehrend des EIGENEN Laufs …" weiter unten ab.
    zeige({ ytdlp: { version: null, unlesbar: false, geprueft: '', auto: true, env: false, laeuft: true, ergebnis: '', ungeschuetzt: false, unterbrochen: false, ejs_unlesbar: false } })
    expect(await screen.findByText(/Eine Aktualisierung läuft gerade/)).toBeInTheDocument()
    expect(screen.queryByText(/Nicht installiert/)).not.toBeInTheDocument()
  })

  it('sagt es, wenn eine Reparatur beim nächsten Start ansteht (#262)', async () => {
    /* Der DRITTE `version: null`-Zustand. Ohne die Zeile stand „Nicht installiert — der
       Import steht nicht zur Verfügung" über einer Installation, die beim nächsten Start
       von selbst weitermacht — die teuerste der drei Falschmeldungen, denn sie schickt den
       Nutzer zu einer Neuinstallation. Die README leitet ihn bei einem fehlgeschlagenen
       Import ausdrücklich auf diese Seite. Die Negativkontrolle steht zwei Tests weiter
       oben („sagt es, wenn yt-dlp gar nicht installiert ist" — gleicher Zustand, nur ohne
       `unterbrochen`); ohne sie wäre diese Zusicherung nicht von der Reihenfolge getrennt. */
    zeige({ ytdlp: { version: null, unlesbar: false, geprueft: '', auto: true, env: false, laeuft: false, ergebnis: '', ungeschuetzt: false, unterbrochen: true, ejs_unlesbar: false } })
    expect(await screen.findByText(/beim nächsten Start von selbst fort/)).toBeInTheDocument()
    expect(screen.queryByText(/Nicht installiert/)).not.toBeInTheDocument()
  })

  it('verweist bei ABGESCHALTETEM Automatismus auf den Knopf statt auf einen Start (#285)', async () => {
    /* CodeRabbit-CLI an PR #285, berechtigt: `beim_start()` haengt an `auto_an()` — mit
       ausgeschaltetem Hagen [HAKEN] läuft beim nächsten Start KEINE Reparatur, und die Zeile
       „setzt sie beim nächsten Start fort" waere ein Versprechen, das niemand einlöst
       (dieselbe Klasse wie der tote Schalter aus #266). Der KNOPF repariert in beiden
       Zustaenden (er laeuft bedingungslos), also zeigt die Zeile auf ihn. Beide Werte
       reisen in derselben Antwort — `ytdlp.auto` ist der WIRKSAME Schalter, eine setzende
       Umgebungsvariable steht darin mit. */
    zeige({ ytdlp: { version: null, unlesbar: false, geprueft: '', auto: false, env: false, laeuft: false, ergebnis: '', ungeschuetzt: false, unterbrochen: true, ejs_unlesbar: false } })
    expect(await screen.findByText(/klicke auf „Jetzt aktualisieren/)).toBeInTheDocument()
    expect(screen.queryByText(/beim nächsten Start von selbst fort/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Nicht installiert/)).not.toBeInTheDocument()
  })

  it('unterscheidet unlesbare Metadaten von "nicht installiert"', async () => {
    // Beide Zustände liefern `version: null`. Vor #189 stand hier "steht damit nicht zur
    // Verfügung" — das Gegenteil dessen, was der Nutzer tun kann: der Import läuft, nur die
    // Selbstaktualisierung ist ausgesetzt. Die Anzeige darf nicht lügen.
    zeige({ ytdlp: { version: null, unlesbar: true, geprueft: '', auto: true, env: false, laeuft: false, ergebnis: '', ungeschuetzt: false, unterbrochen: false, ejs_unlesbar: false } })
    expect(await screen.findByText(/Fassung nicht lesbar/)).toBeInTheDocument()
    expect(screen.queryByText(/Nicht installiert/)).not.toBeInTheDocument()
  })

  it('sagt es, wenn die Löserskripte nicht prüfbar sind — und schweigt sonst', async () => {
    // #198: sind die Metadaten von `yt-dlp-ejs` kaputt, fällt die Erkennung untauglicher
    // Löserskripte STILL aus (`_ejs_untauglich()` → „unbekannt ⇒ nicht flaggen"), und der
    // Server meldete daneben einen kerngesunden Stand — `version` da, `unlesbar: false`.
    // Was blieb, war ein sporadischer 403 beim Import mit einer Meldung, die in die falsche
    // Richtung zeigt. BEIDE Richtungen an einem Test: ein Hinweis, der immer steht, ist als
    // Daueralarm derselbe Schaden von der anderen Seite.
    // JEDE Ansicht bekommt ihr eigenes `unmount` — mit einem einzigen (aus dem ersten
    // `zeige()`) bleiben die späteren Renders stehen, und `queryByText(...).not` findet den
    // Hinweis der VORIGEN Ansicht. Genau daran ist die dritte Stufe zuerst umgefallen.
    const ohne = zeige()
    expect(await screen.findByText(/2026\.8\.12/)).toBeInTheDocument()
    expect(screen.queryByText(/lassen sich nicht prüfen/)).not.toBeInTheDocument()
    ohne.unmount()

    const kaputt = zeige({ ytdlp: { ...BASIS.ytdlp, ejs_unlesbar: true } })
    expect(await screen.findByText(/lassen sich nicht prüfen/)).toBeInTheDocument()
    // Die Fassungszeile bleibt, was sie ist: yt-dlp selbst ist ja in Ordnung.
    expect(screen.getByText(/2026\.8\.12/)).toBeInTheDocument()
    kaputt.unmount()

    // Und er schweigt WÄHREND eines Laufs — dieselbe Regel wie bei der Fassungszeile (#225),
    // aus derselben Quelle: `zustand()` liest die ejs-Metadaten bei jedem Poll, also auch
    // mitten in pips Schreibfenster. Der Hinweis rät zu einer Neueinrichtung, und genau
    // dieser Rat ist während einer laufenden Aktualisierung falsch.
    zeige({ ytdlp: { ...BASIS.ytdlp, ejs_unlesbar: true, laeuft: true } })
    expect(await screen.findByText(/Eine Aktualisierung läuft gerade/)).toBeInTheDocument()
    expect(screen.queryByText(/lassen sich nicht prüfen/)).not.toBeInTheDocument()
  })

  it('zeigt den Speichervorgang an — und zaehlt paralleles Speichern mit (#249)', async () => {
    /* Seit #239 zahlt auch der PUT `llm.available()` (Subprozess, Decke 30 s —
       `auth.STATUS_TIMEOUT`). Eine klemmende CLI hielt das Speichern bis zu 30 s auf, und
       das Formular sah aus wie eines, das nichts tut. Der Zustand haengt am KOPF, nicht am
       Ausloeser: die Seite speichert bei onBlur aus einem Dutzend Feldern, es gibt keinen
       einen Knopf dafuer.

       Mit verzögerter Antwort statt sofortiger Attrappe — sonst waere der Zustand zwischen
       Klick und Rückkehr nie sichtbar und der Test prüfte ihn nur an seinem Abklingen.
       Und mit ZWEI gleichzeitig offenen PUTs: ein Bool wuerde den ersten Rückkehrer als
       „fertig" melden, während der zweite noch läuft. */
    // `Settings & { ungeschuetzt }`: die Fabrik `GESPEICHERT` traegt den vierten Wert
    // bereits — derselbe Vertrag wie `api.saveSettings`, kein `any`.
    const offen: Array<(v: Settings & { ungeschuetzt: boolean }) => void> = []
    vi.mocked(api.saveSettings).mockImplementation(() =>
      new Promise<Settings & { ungeschuetzt: boolean }>(aufloesen => offen.push(aufloesen)))
    zeige()
    const haken = await screen.findByRole('checkbox')
    fireEvent.click(haken)                                  // erster PUT geht auf Reisen
    expect(await screen.findByRole('status')).toHaveTextContent('Speichert …')
    fireEvent.click(haken)                                  // zweiter, bevor der erste zurück ist
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('(2)'))
    offen[0]({ ...GESPEICHERT, ytdlp_auto: '0' })            // erster kehrt zurück …
    // … wieder EINER unterwegs: OHNE Zahl — der Zaehler steht im Text nur ab zweien,
    // sonst klänge „Speichert (1)" wie ein Fehlerzähler. Die Zahl verschwindet MIT dem
    // Parallelfall, nicht mit dem ersten Rückkehrer: genau das trennt den Zähler vom Bool.
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Speichert …'))
    expect(screen.getByRole('status')).not.toHaveTextContent('(')
    offen[1]({ ...GESPEICHERT, ytdlp_auto: '1' })            // … und erst der zweite räumt ab
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
  })

  it('speichert den Haken als "0"/"1"', async () => {
    vi.mocked(api.saveSettings).mockResolvedValue({ ...GESPEICHERT, ytdlp_auto: '0' })
    zeige()
    const haken = await screen.findByRole('checkbox', { name: /aktuell halten/i })
    fireEvent.click(haken)
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({ ytdlp_auto: '0' }))
  })

  it('sagt es, wenn ohne Schreibsperre gespeichert wurde — und schweigt sonst', async () => {
    // #194: die Sperre darf fail-open gehen, aber dann kann ein gleichzeitiger Schreiber die
    // Änderung überbügelt haben (#192) — bisher sah der Nutzer blanken Erfolg, weil die
    // Meldung nur in die Serverkonsole ging. BEIDE Richtungen an einem Test: eine Warnung,
    // die immer kommt, ist als Daueralarm derselbe Schaden von der anderen Seite.
    vi.mocked(api.saveSettings).mockResolvedValue({ ...GESPEICHERT, ytdlp_auto: '0' })
    zeige()
    fireEvent.click(await screen.findByRole('checkbox', { name: /aktuell halten/i }))
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalled())
    expect(toast.warning).not.toHaveBeenCalled()

    vi.mocked(api.saveSettings).mockResolvedValue({ ...GESPEICHERT, ytdlp_auto: '1', ungeschuetzt: true })
    fireEvent.click(screen.getByRole('checkbox', { name: /aktuell halten/i }))
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(
      expect.stringContaining('ohne Schreibsperre')))
  })

  it('warnt, wenn die Umgebungsvariable den Haken überstimmt', async () => {
    // Ein Haken, der nichts tut, ist schlimmer als keiner. Der WIRKSAME Wert kommt aus
    // `ytdlp.auto`, der gespeicherte aus `ytdlp_auto` — nur die Differenz ist die Warnung.
    zeige({ ytdlp_auto: '1', ytdlp: { version: '2026.8.12', unlesbar: false, geprueft: '', auto: false, env: true, laeuft: false, ergebnis: '', ungeschuetzt: false, unterbrochen: false, ejs_unlesbar: false } })
    expect(await screen.findByText(/wirkungslos/)).toBeInTheDocument()
  })

  it('warnt NICHT, solange keine Umgebungsvariable gesetzt ist', async () => {
    // Gegenrichtung: ohne sie bliebe unbemerkt, wenn die Warnung immer stünde.
    zeige()
    await screen.findByText(/2026\.8\.12/)
    expect(screen.queryByText(/wirkungslos/)).not.toBeInTheDocument()
  })

  it('das Umschalten blitzt keine falsche Override-Warnung auf', async () => {
    // Die Warnung hing zuerst an `ytdlp.auto !== (ytdlp_auto === '1')`. Die PUT-Antwort
    // trägt `ytdlp_auto`, aber KEINEN `ytdlp`-Block — zwischen Merge und Nachladen behauptete
    // der Vergleich also ein Override, das es gar nicht gibt; schlug das Nachladen fehl,
    // blieb die Falschaussage stehen. Seitdem sagt der Server es selbst (`ytdlp.env`).
    vi.mocked(api.saveSettings).mockResolvedValue({ ...GESPEICHERT, ytdlp_auto: '0' })
    zeige()
    const haken = await screen.findByRole('checkbox', { name: /aktuell halten/i })
    // Erst NACH dem Laden scheitern lassen — ein `…Once` davor träfe den Aufbau der Seite,
    // und der Test prüfte dann nur noch „Lädt…“.
    vi.mocked(api.getSettings).mockRejectedValue(new Error('weg'))
    await act(async () => { fireEvent.click(haken) })
    expect(screen.queryByText(/wirkungslos/)).not.toBeInTheDocument()
  })

  it('meldet einen fehlgeschlagenen Update-Versuch, statt ihn zu verschlucken', async () => {
    vi.mocked(api.updateYtdlp).mockResolvedValue({ gestartet: true, version: '2026.7.4', unlesbar: false, geprueft: '2026-08-13', auto: true, env: false, laeuft: false, ergebnis: 'fehler', ungeschuetzt: false, unterbrochen: false, ejs_unlesbar: false })
    zeige()
    fireEvent.click(await screen.findByRole('button', { name: /Jetzt aktualisieren/i }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/fehlgeschlagen/)))
  })

  it('nennt beim Fehlschlag die kaputten Metadaten statt nach dem Netz zu fragen', async () => {
    // Bei kaputter METADATA scheitert pip SELBST (gemessen: `pip list` gegen eine
    // praeparierte dist-info endet mit Exit 2 und UnicodeDecodeError). Wer gerade "Fassung
    // nicht lesbar" gelesen und darauf geklickt hat, bekaeme sonst "bist du online?" —
    // dieselbe Fehldiagnose, gegen die #189 gebaut ist, drei Zeilen weiter oben.
    vi.mocked(api.updateYtdlp).mockResolvedValue({ gestartet: true, version: null, unlesbar: true, geprueft: '', auto: true, env: false, laeuft: false, ergebnis: 'fehler', ungeschuetzt: false, unterbrochen: false, ejs_unlesbar: false })
    zeige()
    fireEvent.click(await screen.findByRole('button', { name: /Jetzt aktualisieren/i }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/Metadaten/)))
    expect(toast.error).not.toHaveBeenCalledWith(expect.stringMatching(/online/))
  })

  it('meldet einen ungeschützten pip-Lauf ZUSÄTZLICH zum Erfolg — und schweigt sonst', async () => {
    // #236: ob pip durchlief und ob es dabei allein war, sind zwei Fragen. Ungeschützt heisst
    // hier nicht „ein Einstellungswert kann überbügelt sein" (#194/#192), sondern „zwei
    // `pip install` können in dieselbe venv geschrieben haben" — der zweite Auslöser sitzt im
    // fetch-Subprozess. Der Erfolgs-Toast darf deshalb nicht ersetzt, sondern muss ergänzt
    // werden. Beide Richtungen, sonst wäre ein Daueralarm nicht zu sehen.
    // `as const` auf dem Ergebniswert: `ergebnis` ist seit #254 eine String-Union, und ein
    // Zwischen-`const` weitet das Literal sonst zu `string` (CodeRabbit-Bot).
    const fertig = { gestartet: true, version: '2026.8.12', unlesbar: false, geprueft: '',
                     auto: true, env: false, laeuft: false, ergebnis: 'ok' as const,
                     ungeschuetzt: false, unterbrochen: false, ejs_unlesbar: false }
    vi.mocked(api.updateYtdlp).mockResolvedValue(fertig)
    const { unmount } = zeige()
    fireEvent.click(await screen.findByRole('button', { name: /Jetzt aktualisieren/i }))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(toast.warning).not.toHaveBeenCalled()
    unmount()

    vi.mocked(api.updateYtdlp).mockResolvedValue({ ...fertig, ungeschuetzt: true })
    zeige()
    fireEvent.click(await screen.findByRole('button', { name: /Jetzt aktualisieren/i }))
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(
      expect.stringContaining('ohne Sperre')))
    // Der Erfolg geht dabei NICHT verloren — das war der Fehler des naheliegenden `return`.
    expect(toast.success).toHaveBeenCalledTimes(2)
  })

  it('meldet einen übersprungenen Lauf als Hinweis — nicht als Erfolg und nicht als Fehler', async () => {
    // #254 Weg 3, Reviewbefund am echten Pfad: der Lauf stellte unter der pip-Sperre fest,
    // dass ein anderer schneller war, und hat NICHTS getan. Vorher lief er in den
    // Erfolgszweig und zeigte „yt-dlp ist jetzt auf <alte Fassung>" — auch dann, wenn der
    // Fremdlauf offline gescheitert war (der Server merkt sich das Prüfdatum auch nach einem
    // Fehlschlag, „nicht mehr fällig" belegt also keinen Erfolg).
    //
    // Beide Gegenrichtungen gehören dazu: KEIN `toast.success` (die Lüge, gegen die der Fix
    // steht) und KEIN `toast.error` (es ist nichts schiefgegangen — das wäre dieselbe Lüge
    // spiegelverkehrt und schickte den Nutzer auf Fehlersuche).
    vi.mocked(api.updateYtdlp).mockResolvedValue({
      gestartet: true, version: '2025.9.5', unlesbar: false, geprueft: '', auto: true,
      env: false, laeuft: false, ergebnis: 'uebersprungen', ungeschuetzt: false,
      unterbrochen: false, ejs_unlesbar: false })
    const { unmount } = zeige()
    fireEvent.click(await screen.findByRole('button', { name: /Jetzt aktualisieren/i }))
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(
      expect.stringContaining('war schneller')))
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    unmount()

    // Und die Sperrwarnung bleibt AUS. Ohne diese zweite Ansicht deckt KEINE Mutation das
    // `return` im neuen Zweig — die Attrappe oben setzt `ungeschuetzt: false`, der
    // Warnblock steht dahinter, und ein entferntes `return` bliebe unsichtbar. Der Server
    // erzeugt diesen Fall heute nicht (er setzt `ungeschuetzt` beim Ueberspringen selbst
    // auf False); geprueft wird hier die Frontend-Haelfte derselben Zusage — eine Warnung
    // ueber ein pip, das nie lief, hat keinen Gegenstand. (CodeRabbit-Bot.)
    vi.mocked(api.updateYtdlp).mockResolvedValue({
      gestartet: true, version: '2025.9.5', unlesbar: false, geprueft: '', auto: true,
      env: false, laeuft: false, ergebnis: 'uebersprungen', ungeschuetzt: true,
      unterbrochen: false, ejs_unlesbar: false })
    zeige()
    fireEvent.click(await screen.findByRole('button', { name: /Jetzt aktualisieren/i }))
    await waitFor(() => expect(toast.info).toHaveBeenCalledTimes(2))
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('rät bei kaputten ejs-Paketdaten nicht nach dem Netz', async () => {
    // Der Zwilling zum Test darüber, durch die andere Tür: `unlesbar` gilt yt-dlp, bei
    // kaputten Paketdaten von `yt-dlp-ejs` ist es `false` — und dann stand hier „bist du
    // online?", also genau die Fehldiagnose, gegen die #189 gebaut ist. GEMESSEN, dass es
    // eine ist: `pip install -U --dry-run yt-dlp[default]` gegen eine präparierte
    // `yt_dlp_ejs-0.8.0.dist-info` endet mit Exit 2 und UnicodeDecodeError — pip enumeriert
    // vor dem Installieren und scheitert an derselben Datei. Es liegt also nicht am Netz.
    vi.mocked(api.updateYtdlp).mockResolvedValue({
      gestartet: true, version: '2026.8.12', unlesbar: false, geprueft: '', auto: true,
      env: false, laeuft: false, ergebnis: 'fehler', ungeschuetzt: false, unterbrochen: false, ejs_unlesbar: true,
    })
    zeige()
    fireEvent.click(await screen.findByRole('button', { name: /Jetzt aktualisieren/i }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining('Hilfsskripte')))
    expect(toast.error).not.toHaveBeenCalledWith(expect.stringMatching(/online/))
  })

  it('erklärt den Spinner, wenn ein FREMDER Lauf die Sperre hält', async () => {
    // Seit #243 kann `ytdlp.laeuft` von einem anderen Prozess kommen. `starte_hintergrund()`
    // sieht nur seinen eigenen Modulzustand und meldet `gestartet: true` — der eigene Lauf
    // blockiert dann bis zu 215 s an der pip-Sperre, und ohne diesen Hinweis sähe der Nutzer
    // einen Spinner und sonst nichts, obwohl die Zeile darüber gerade „klicke, um ihr
    // zuzusehen" versprochen hat.
    vi.mocked(api.updateYtdlp).mockResolvedValue({
      gestartet: true, version: '2026.8.12', unlesbar: false, geprueft: '', auto: true,
      env: false, laeuft: true, ergebnis: '', ungeschuetzt: false, unterbrochen: false, ejs_unlesbar: false,
    })
    const { unmount } = zeige({ ytdlp: { ...BASIS.ytdlp, laeuft: true } })
    fireEvent.click(await screen.findByRole('button', { name: /Jetzt aktualisieren/i }))
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(
      expect.stringContaining('Video-Import')))
    unmount()

    // Gegenprobe: lief vorher NICHTS, gibt es auch keinen Hinweis — sonst käme er bei jedem
    // Klick, und ein Hinweis, der immer steht, sagt nichts mehr.
    vi.clearAllMocks()
    vi.mocked(api.getAuth).mockResolvedValue({ unterstuetzt: false, angemeldet: false, detail: '' })
    vi.mocked(api.listModels).mockResolvedValue([])
    vi.mocked(api.updateYtdlp).mockResolvedValue({
      gestartet: true, version: '2026.8.12', unlesbar: false, geprueft: '', auto: true,
      env: false, laeuft: true, ergebnis: '', ungeschuetzt: false, unterbrochen: false, ejs_unlesbar: false,
    })
    zeige()
    fireEvent.click(await screen.findByRole('button', { name: /Jetzt aktualisieren/i }))
    await waitFor(() => expect(api.updateYtdlp).toHaveBeenCalled())
    expect(toast.info).not.toHaveBeenCalled()
  })

  it('wartet nicht auf pip, sondern fragt nach — der Toast kommt erst am Ende (#174)', async () => {
    // Vorher hing der Request am pip-Lauf (>=340 s im schlimmsten Fall). Jetzt antwortet er
    // sofort mit `laeuft: true`; der Ausgang kommt über den nächsten getSettings. Geprüft
    // wird BEIDES — dass sofort noch nichts gemeldet wird UND dass am Ende doch etwas kommt.
    // Nur die erste Hälfte wäre erfüllt, wenn der Toast ganz verschwände: genau der stille
    // Fehlschlag, gegen den `ergebnis` gebaut ist.
    vi.mocked(api.updateYtdlp).mockResolvedValue({
      gestartet: true, version: '2026.7.4', unlesbar: false, geprueft: '', auto: true,
      env: false, laeuft: true, ergebnis: '', ungeschuetzt: false, unterbrochen: false, ejs_unlesbar: false,
    })
    zeige()
    const knopf = await screen.findByRole('button', { name: /Jetzt aktualisieren/i })

    // `mockImplementation` statt einer `…Once`-Kette: die Seite fragt die Einstellungen
    // auch aus dem Anmelde-Effekt heraus ab, eine feste Reihenfolge wäre also nicht die
    // Reihenfolge der Nachfragen.
    let laeuftNoch = true
    vi.mocked(api.getSettings).mockImplementation(async () => ({
      ...BASIS,
      ytdlp: laeuftNoch
        ? { ...BASIS.ytdlp, laeuft: true, ergebnis: '' }
        : { ...BASIS.ytdlp, version: '2026.8.12', laeuft: false, ergebnis: 'ok' },
    }))

    vi.useFakeTimers()
    try {
      await act(async () => { fireEvent.click(knopf) })
      // Der POST ist durch, der Lauf steht noch: KEIN Toast, aber auch kein Hänger.
      expect(toast.success).not.toHaveBeenCalled()
      expect(toast.error).not.toHaveBeenCalled()

      // Auslöser und Uhr in GETRENNTEN act-Blöcken (sonst läuft der Timer, bevor der
      // Effekt ihn gesetzt hat) — dieselbe Regel wie beim Autosave-Test.
      await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
      expect(toast.success).not.toHaveBeenCalled()      // eine Runde: immer noch am Laufen

      laeuftNoch = false
      await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    } finally {
      vi.useRealTimers()      // ins `finally`: ein Wurf oben liesse sonst die Uhr aller
    }                         // folgenden Tests gefälscht zurück

    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/2026\.8\.12/))
  })

  it('sagt waehrend des EIGENEN Laufs nichts ueber die Fassung (#225)', async () => {
    // Die zweite Haelfte von #225: waehrend dieser Tab zusieht (`ytLaeuft`), traf die
    // Poll-Antwort mitten aus pips Umschreiben die Fassungszeile. Genau dann schaut der
    // Nutzer hin — er hat eben geklickt.
    vi.mocked(api.updateYtdlp).mockResolvedValue({
      gestartet: true, version: '2026.7.4', unlesbar: false, geprueft: '', auto: true,
      env: false, laeuft: true, ergebnis: '', ungeschuetzt: false, unterbrochen: false, ejs_unlesbar: false,
    })
    zeige()
    const knopf = await screen.findByRole('button', { name: /Jetzt aktualisieren/i })
    // Die Antwort AUS pips Luecke: gefunden hat der Server nichts, kaputt ist auch nichts.
    vi.mocked(api.getSettings).mockResolvedValue({
      ...BASIS,
      ytdlp: { ...BASIS.ytdlp, version: null, unlesbar: false, laeuft: true, ergebnis: '' },
    })

    vi.useFakeTimers()
    try {
      await act(async () => { fireEvent.click(knopf) })
      await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
      expect(screen.queryByText(/Nicht installiert/)).not.toBeInTheDocument()
      expect(screen.getByText(/steht fest, sobald der Lauf fertig ist/)).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('bricht die Nachfragerei ab, wenn die Seite verlassen wird', async () => {
    // Vorher war das eine freilaufende `while`-Schleife: sie pollte über die volle pip-Dauer
    // weiter, schrieb `setS` auf eine ausgehängte Komponente (React 18 warnt dazu nicht mehr)
    // und feuerte am Ende einen Toast für eine Seite, auf der niemand mehr ist.
    // Gefunden vom Reviewer-Subagenten an PR #223 (I3).
    vi.mocked(api.updateYtdlp).mockResolvedValue({
      gestartet: true, version: '2026.7.4', unlesbar: false, geprueft: '', auto: true,
      env: false, laeuft: true, ergebnis: '', ungeschuetzt: false, unterbrochen: false, ejs_unlesbar: false,
    })
    const r = zeige()
    const knopf = await screen.findByRole('button', { name: /Jetzt aktualisieren/i })
    vi.mocked(api.getSettings).mockResolvedValue({
      ...BASIS, ytdlp: { ...BASIS.ytdlp, laeuft: true, ergebnis: '' },
    })

    vi.useFakeTimers()
    try {
      await act(async () => { fireEvent.click(knopf) })
      await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
      const nachEinerRunde = vi.mocked(api.getSettings).mock.calls.length
      expect(nachEinerRunde).toBeGreaterThan(0)     // Positivkontrolle: es pollt überhaupt

      r.unmount()
      await act(async () => { await vi.advanceTimersByTimeAsync(6000) })   // vier Runden
      expect(vi.mocked(api.getSettings).mock.calls.length).toBe(nachEinerRunde)
    } finally {
      vi.useRealTimers()
    }
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('gibt die Nachfragerei nach einer Obergrenze auf, statt endlos zu pollen', async () => {
    // Bleibt `laeuft` serverseitig hängen — etwa am blockierenden `open()` aus #200, wo die
    // Obergrenze aus #191 nicht greift —, pollte der Browser sonst bis zum Tab-Schluss und
    // meldete nie etwas. Die Mutation „Obergrenze raus" liess ohne diesen Test alle 47
    // anderen grün: ein Wächter ohne roten Test ist Dekoration.
    vi.mocked(api.updateYtdlp).mockResolvedValue({
      gestartet: true, version: '2026.7.4', unlesbar: false, geprueft: '', auto: true,
      env: false, laeuft: true, ergebnis: '', ungeschuetzt: false, unterbrochen: false, ejs_unlesbar: false,
    })
    zeige()
    const knopf = await screen.findByRole('button', { name: /Jetzt aktualisieren/i })
    // Der Server wird NIE fertig.
    vi.mocked(api.getSettings).mockResolvedValue({
      ...BASIS, ytdlp: { ...BASIS.ytdlp, laeuft: true, ergebnis: '' },
    })

    vi.useFakeTimers()
    try {
      await act(async () => { fireEvent.click(knopf) })
      await act(async () => { await vi.advanceTimersByTimeAsync(13 * 60_000) })
    } finally {
      vi.useRealTimers()
    }
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/meldet sich nicht mehr/))
    // Und danach ist Ruhe: der Knopf ist wieder bedienbar statt für immer zu drehen.
    expect(await screen.findByRole('button', { name: /Jetzt aktualisieren/i })).toBeEnabled()
  })

  it('meldet EINEN Lauf genau einmal, auch wenn zwei Polls sich überholen (#247)', async () => {
    // Der Poll hängt seine Meldung an einen ZUSTAND („läuft nicht mehr"), nicht an den
    // Übergang dorthin. Braucht `getSettings()` länger als die 1,5 s des Intervalls, sind
    // zwei Runden gleichzeitig unterwegs und sehen beide denselben fertigen Lauf.
    // `setYtLaeuft(false)` schützt davor nicht — die zweite Runde liest ihren Wert aus der
    // eigenen Closure, und das Intervall wird erst beim nächsten Effektlauf abgeräumt.
    // Seit #236 sind das nicht zwei Toasts, sondern bis zu vier für EINEN Vorgang.
    vi.mocked(api.updateYtdlp).mockResolvedValue({
      gestartet: true, version: '2026.7.4', unlesbar: false, geprueft: '', auto: true,
      env: false, laeuft: true, ergebnis: '', ungeschuetzt: false, unterbrochen: false, ejs_unlesbar: false,
    })
    zeige()
    const knopf = await screen.findByRole('button', { name: /Jetzt aktualisieren/i })

    // Antworten offen halten statt sofort aufzulösen — genau so entsteht die Überholung.
    const offen: Array<(s: Settings) => void> = []
    vi.mocked(api.getSettings).mockImplementation(() => new Promise(res => { offen.push(res) }))

    vi.useFakeTimers()
    try {
      await act(async () => { fireEvent.click(knopf) })
      await act(async () => { await vi.advanceTimersByTimeAsync(1500) })   // Runde 1 startet
      await act(async () => { await vi.advanceTimersByTimeAsync(1500) })   // Runde 2 startet
      // Positivkontrolle: ohne sie prüfte der Test bei nur EINER Runde nichts — er wäre
      // grün, weil das Rennen nie stattgefunden hat.
      expect(offen).toHaveLength(2)
      const fertig = {
        ...BASIS,
        ytdlp: { ...BASIS.ytdlp, version: '2026.8.12', laeuft: false, ergebnis: 'ok' as const },
      }
      await act(async () => { offen.forEach(aufloesen => aufloesen(fertig)) })
    } finally {
      vi.useRealTimers()
    }

    expect(toast.success).toHaveBeenCalledTimes(1)
  })

  it('eine verspätete Antwort aus Lauf 1 gilt nicht als Ausgang von Lauf 2 (#247)', async () => {
    // Der Grund, warum der Merker eine KENNUNG trägt und nicht bloss ein Bool ist
    // (CodeRabbit-CLI, Major): `clearInterval` hält künftige Runden auf, eine Runde IN ihrem
    // `await` läuft weiter. Trifft ihre Antwort nach dem `neuerLauf()` des nächsten Laufs ein,
    // würde ein Bool sie als dessen Ausgang durchwinken — mit den Zahlen des vorigen.
    vi.mocked(api.updateYtdlp).mockResolvedValue({
      gestartet: true, version: '2026.7.4', unlesbar: false, geprueft: '', auto: true,
      env: false, laeuft: true, ergebnis: '', ungeschuetzt: false, unterbrochen: false, ejs_unlesbar: false,
    })
    zeige()
    const knopf = await screen.findByRole('button', { name: /Jetzt aktualisieren/i })
    const offen: Array<(s: Settings) => void> = []
    vi.mocked(api.getSettings).mockImplementation(() => new Promise(res => { offen.push(res) }))
    const fertig = (v: string): Settings => ({
      ...BASIS, ytdlp: { ...BASIS.ytdlp, version: v, laeuft: false, ergebnis: 'ok' },
    })

    vi.useFakeTimers()
    try {
      await act(async () => { fireEvent.click(knopf) })                   // Lauf 1
      await act(async () => { await vi.advanceTimersByTimeAsync(1500) })  // Runde A
      await act(async () => { await vi.advanceTimersByTimeAsync(1500) })  // Runde B
      expect(offen).toHaveLength(2)
      // Runde A beendet Lauf 1 — Runde B bleibt unterwegs.
      await act(async () => { offen[0](fertig('2026.8.12')) })
      expect(toast.success).toHaveBeenCalledTimes(1)

      // Lauf 2 beginnt, WÄHREND Runde A… äh, Runde B noch hängt.
      await act(async () => { fireEvent.click(knopf) })
      // Und jetzt kommt die alte Antwort. Sie gehört Lauf 1 und darf nichts mehr melden.
      await act(async () => { offen[1](fertig('URALT')) })
    } finally {
      vi.useRealTimers()
    }

    expect(toast.success).toHaveBeenCalledTimes(1)
    expect(toast.success).not.toHaveBeenCalledWith(expect.stringMatching(/URALT/))
  })

  it('eine verspätete Antwort aus einem NIE gemeldeten Lauf 1 meldet nichts (#247)', async () => {
    // Der Test darüber übt nur den einen Wächter („derselbe Lauf schon gemeldet"). Dieser übt
    // den anderen („die Antwort gehört einem fremden Lauf") — und der greift nur, wenn Lauf 1
    // NIE durch `melde` gegangen ist. Erreichbar über den `catch`-Zweig von `ytJetzt`: der
    // meldet bewusst ausserhalb des Merkers (zwei verschiedene Tatsachen) und schaltet
    // `ytLaeuft` ab, während eine Poll-Runde noch unterwegs ist.
    // Ohne diesen Test wäre `fuer !== lauf.current` eine Zeile, die keine Mutation rot macht.
    // Die Ablehnung muss VERZÖGERT kommen: lehnt `updateYtdlp` sofort ab, liegen
    // `setYtLaeuft(true)` und `(false)` im selben Batch, der Effekt sieht das `true` nie und
    // es startet gar kein Poll. (Erst gemessen, dann so gebaut.)
    let lauf1Ablehnen: (e: Error) => void = () => {}
    vi.mocked(api.updateYtdlp).mockImplementationOnce(
      () => new Promise((_res, rej) => { lauf1Ablehnen = rej }))
    zeige()
    const knopf = await screen.findByRole('button', { name: /Jetzt aktualisieren/i })
    const offen: Array<(s: Settings) => void> = []
    vi.mocked(api.getSettings).mockImplementation(() => new Promise(res => { offen.push(res) }))

    vi.useFakeTimers()
    try {
      await act(async () => { fireEvent.click(knopf) })                   // Lauf 1 beginnt
      await act(async () => { await vi.advanceTimersByTimeAsync(1500) })  // Runde A hängt
      expect(offen).toHaveLength(1)
      // Jetzt scheitert das Anstossen — `ytLaeuft` geht aus, OHNE dass `melde` je lief.
      await act(async () => { lauf1Ablehnen(new Error('Anstossen ging schief')) })
      expect(toast.success).not.toHaveBeenCalled()                        // Lauf 1 nie gemeldet

      // Lauf 2 — der Knopf ist wieder frei, weil der Fehlschlag `ytLaeuft` abgeschaltet hat.
      vi.mocked(api.updateYtdlp).mockResolvedValue({
        gestartet: true, version: '2026.7.4', unlesbar: false, geprueft: '', auto: true,
        env: false, laeuft: true, ergebnis: '', ungeschuetzt: false, unterbrochen: false, ejs_unlesbar: false,
      })
      await act(async () => { fireEvent.click(knopf) })
      // Runde A aus Lauf 1 trifft jetzt ein.
      await act(async () => {
        offen[0]({ ...BASIS, ytdlp: { ...BASIS.ytdlp, version: 'AUS-LAUF-1', laeuft: false, ergebnis: 'ok' } })
      })
    } finally {
      vi.useRealTimers()
    }

    expect(toast.success).not.toHaveBeenCalled()
  })

  it('eine überholte Poll-Antwort lässt die Zeile „läuft gerade" nicht dauerhaft stehen (#247)', async () => {
    // Der Merker deckt die MELDUNG, nicht `setS`. Trifft eine ältere Runde (`laeuft: true`)
    // NACH der jüngeren (`laeuft: false`) ein, schreibt sie den überholten Zustand zurück —
    // und weil `ytLaeuft` da schon aus ist, ist das Intervall abgeräumt und niemand holt das
    // je wieder ein. Die Seite behauptet dann bis zum Neuladen, es laufe eine Aktualisierung:
    // genau die Lüge, gegen die #225 gebaut wurde, nur aus der anderen Richtung.
    vi.mocked(api.updateYtdlp).mockResolvedValue({
      gestartet: true, version: '2026.7.4', unlesbar: false, geprueft: '', auto: true,
      env: false, laeuft: true, ergebnis: '', ungeschuetzt: false, unterbrochen: false, ejs_unlesbar: false,
    })
    zeige()
    const knopf = await screen.findByRole('button', { name: /Jetzt aktualisieren/i })
    const offen: Array<(s: Settings) => void> = []
    vi.mocked(api.getSettings).mockImplementation(() => new Promise(res => { offen.push(res) }))

    vi.useFakeTimers()
    try {
      await act(async () => { fireEvent.click(knopf) })
      await act(async () => { await vi.advanceTimersByTimeAsync(1500) })   // Runde A (alt)
      await act(async () => { await vi.advanceTimersByTimeAsync(1500) })   // Runde B (neu)
      expect(offen).toHaveLength(2)
      // Die JÜNGERE zuerst: der Lauf ist fertig.
      await act(async () => {
        offen[1]({ ...BASIS, ytdlp: { ...BASIS.ytdlp, version: '2026.8.12', laeuft: false, ergebnis: 'ok' } })
      })
      // Und jetzt die ÄLTERE, die den Lauf noch als laufend gesehen hat.
      await act(async () => {
        offen[0]({ ...BASIS, ytdlp: { ...BASIS.ytdlp, version: null, laeuft: true, ergebnis: '' } })
      })
    } finally {
      vi.useRealTimers()
    }

    expect(screen.queryByText(/Eine Aktualisierung läuft gerade/i)).not.toBeInTheDocument()
  })

  it('meldet einen ZWEITEN Lauf wieder — der Merker gilt je Lauf, nicht je Sitzung (#247)', async () => {
    // Die Gegenrichtung, und sie ist die gefährlichere: ein Merker ohne Rücksetzen macht aus
    // „zu viele Meldungen" ein „gar keine", und zwar still. Ohne diesen Test wäre der Fix
    // gegen einen Lärmfehler ein Ausfall der Rückmeldung überhaupt.
    vi.mocked(api.updateYtdlp).mockResolvedValue({
      gestartet: true, version: '2026.8.12', unlesbar: false, geprueft: '', auto: true,
      env: false, laeuft: false, ergebnis: 'ok', ungeschuetzt: false, unterbrochen: false, ejs_unlesbar: false,
    })
    zeige()
    const knopf = await screen.findByRole('button', { name: /Jetzt aktualisieren/i })
    await act(async () => { fireEvent.click(knopf) })
    await act(async () => { fireEvent.click(knopf) })
    expect(toast.success).toHaveBeenCalledTimes(2)
  })

  it('sagt an, wenn beim Laden schon eine Aktualisierung läuft', async () => {
    // Wer die Seite mitten in pip neu lädt, sähe sonst einen gewöhnlichen Knopf und
    // erführe nie, dass gerade etwas läuft — das Feld `laeuft` läge auf der Leitung und
    // würde nirgends benutzt. Der Knopf bleibt dabei BEDIENBAR: ein Klick hängt sich per
    // `gestartet: false` an den laufenden Lauf. (Reviewbefund M8 an PR #223.)
    zeige({ ytdlp: { ...BASIS.ytdlp, laeuft: true, ergebnis: '' } })
    expect(await screen.findByText(/Eine Aktualisierung läuft gerade/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Jetzt aktualisieren/i })).toBeEnabled()
  })

  it('holt die Zeile eines FREMDEN Laufs nach, statt sie einzufrieren (#252)', async () => {
    // Bis #252 war die Zeile eine MOMENTAUFNAHME: `s` wird nur beim Laden, nach `speichern()`
    // und im `ytLaeuft`-Poll aufgefrischt. Wer die Seite waehrend eines fremden Laufs offen
    // hatte — seit #253 der Regelfall, weil die Kalenderpruefung beim Serverstart laeuft —
    // sah „Eine Aktualisierung laeuft gerade" und danach fuer immer dasselbe.
    // „Ehrlich anzeigen" (Weg 2 aus #252) funktioniert nur, wenn die Zeile auch endet.
    // Die Uhr wird VOR dem Rendern gefälscht: der Effekt legt sein `setInterval` beim
    // Aufsetzen an, nicht auf Klick. Nachträglich installierte Fake-Timer sehen das schon
    // laufende Intervall nicht — der erste Anlauf dieses Tests blieb genau daran hängen und
    // meldete „0 Nachfragen", was wie ein fehlender Poll aussah statt wie eine falsche Uhr.
    vi.useFakeTimers()
    try {
      zeige({ ytdlp: { ...BASIS.ytdlp, laeuft: true, ergebnis: '' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })   // Laden auflösen
      expect(screen.getByText(/Eine Aktualisierung läuft gerade/i)).toBeInTheDocument()

      vi.mocked(api.getSettings).mockResolvedValue({
        ...BASIS, ytdlp: { ...BASIS.ytdlp, laeuft: false, ergebnis: 'ok', version: '2026.8.17' },
      })
      await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
      expect(screen.getByText('2026.8.17')).toBeInTheDocument()
      expect(screen.queryByText(/Eine Aktualisierung läuft gerade/i)).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('der Nachhol-Poll fasst `ytLaeuft` NICHT an (#252 Weg 2)', async () => {
    // Die Zusicherung dieses Tests ist eine ENTSCHEIDUNG, die im Code steht (SettingsPage:551):
    // ein fremder Lauf wird bewusst NICHT uebernommen, denn `ytLaeuft` besitzt die
    // 480-Runden-Obergrenze samt ihrem `runden`-Zaehler im Effektrumpf. Haengt der Poll
    // zusaetzlich an `s.ytdlp.laeuft`, setzt jede Runde die Abhaengigkeiten neu, der Effekt
    // setzt auf, `runden` faellt auf 0 — und die Obergrenze ist wirkungslos, waehrend der
    // vorhandene Test dafuer GRUEN bleibt (er prueft den Toast, nicht das Aufhoeren).
    //
    // Sichtbar wird `ytLaeuft` am Knopf: gesetzt, dreht er und ist gesperrt.
    vi.useFakeTimers()
    try {
      zeige({ ytdlp: { ...BASIS.ytdlp, laeuft: true, ergebnis: '' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(screen.getByText(/Eine Aktualisierung läuft gerade/i)).toBeInTheDocument()
      await act(async () => { await vi.advanceTimersByTimeAsync(9000) })   // drei Runden
      expect(screen.getByRole('button', { name: /Jetzt aktualisieren/i })).toBeEnabled()
    } finally {
      vi.useRealTimers()
    }
    // Und kein Toast: Weg 2 heisst ANZEIGEN statt MELDEN. Ein Toast braeuchte einen zweiten
    // Besitzer der `useEinmalJeLauf`-Kennung — genau die Klasse, an der #247 zweimal kippte.
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    expect(toast.info).not.toHaveBeenCalled()
  })

  it('gibt auch der Nachhol-Poll nach einer Obergrenze auf (#252)', async () => {
    // Dieselbe Begruendung wie beim Lauf-Poll (#191/#223): bleibt `laeuft` serverseitig
    // haengen, pollte der Tab sonst bis zum Schluss. Eigener Zaehler, weil es ein eigener
    // Effekt ist — die Obergrenze des anderen deckt ihn nicht.
    vi.useFakeTimers()
    try {
      zeige({ ytdlp: { ...BASIS.ytdlp, laeuft: true, ergebnis: '' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(screen.getByText(/Eine Aktualisierung läuft gerade/i)).toBeInTheDocument()
      await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
      const nachEinerRunde = vi.mocked(api.getSettings).mock.calls.length
      await act(async () => { await vi.advanceTimersByTimeAsync(20 * 60_000) })
      const spaeter = vi.mocked(api.getSettings).mock.calls.length
      expect(spaeter).toBeGreaterThan(nachEinerRunde)      // Positivkontrolle: es pollte
      await act(async () => { await vi.advanceTimersByTimeAsync(20 * 60_000) })
      expect(vi.mocked(api.getSettings).mock.calls.length).toBe(spaeter)
    } finally {
      vi.useRealTimers()
    }
  })

  it('der Nachhol-Poll verwirft überholte Antworten (#252)', async () => {
    // Derselbe Riegel wie im Lauf-Poll (CodeRabbit-Bot an PR #248), hier sogar nötiger:
    // dieser Poll läuft UNAUFGEFORDERT bis zu zwölf Minuten, während jemand auf der Seite
    // tippt. Eine überholte Runde schriebe `s` auf den Stand von VOR einem `speichern()`
    // zurück — die Anzeige widerriefe, was der Nutzer gerade gespeichert hat.
    // **Zwei Anlaeufe waren Dekoration — beide blieben unter der Mutation gruen.** Warum,
    // gehoert hierhin, weil es beim naechsten Test wieder zuschlaegt:
    //
    // 1. `mockImplementationOnce` wurde von `autzLaden` (SettingsPage:272) verbraucht, nicht
    //    von der Poll-Runde. Die Positivkontrolle `spaet.toHaveLength(1)` merkte es nicht:
    //    sie prueft, dass IRGENDETWAS haengt, nicht dass die RUNDE haengt.
    // 2. Danach zeigte die Zusicherung auf das Modell-Eingabefeld — und das blieb auch OHNE
    //    Riegel auf dem neuen Wert stehen (gemessen: `[["feld-modell","sonnet"]]` in beiden
    //    Faellen). Ein unkontrolliertes Feld mit `key`-Neuaufbau ist kein verlaesslicher
    //    Spiegel des States.
    //
    // Geprueft wird deshalb, was der Nutzer WIRKLICH sieht und was direkt aus `s` gerendert
    // wird: die Zeile. Runde 2 meldet „fertig", die ueberholte Runde 1 danach „laeuft noch" —
    // ohne Riegel steht die Zeile „laeuft gerade" wieder da, obwohl der Lauf vorbei ist.
    const warten: Array<(w: Settings) => void> = []
    vi.useFakeTimers()
    try {
      zeige({ ytdlp: { ...BASIS.ytdlp, laeuft: true, ergebnis: '' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      // JEDE Abfrage haengt, aufgeloest wird von Hand — so gehoert jede Zusage eindeutig
      // ihrer Runde.
      vi.mocked(api.getSettings).mockImplementation(
        () => new Promise<Settings>(res => warten.push(res)))
      const vorher = warten.length

      await act(async () => { await vi.advanceTimersByTimeAsync(3000) })   // Runde 1
      await act(async () => { await vi.advanceTimersByTimeAsync(3000) })   // Runde 2
      // Genau zwei neue, beide vom Poll: `autzLaden` feuert nur bei einem Anbieterwechsel,
      // und der findet hier nicht statt. DAS ist die belastbare Positivkontrolle.
      expect(warten.length - vorher).toBe(2)

      await act(async () => {                       // Runde 2 zuerst: der Lauf ist fertig
        warten[vorher + 1]({ ...BASIS, ytdlp: { ...BASIS.ytdlp, laeuft: false, ergebnis: 'ok' } })
      })
      expect(screen.queryByText(/läuft gerade/i)).not.toBeInTheDocument()

      await act(async () => {                       // und jetzt die ueberholte Runde 1
        warten[vorher]({ ...BASIS, ytdlp: { ...BASIS.ytdlp, laeuft: true, ergebnis: '' } })
      })
      expect(screen.queryByText(/läuft gerade/i)).not.toBeInTheDocument()
      expect(screen.getByText('2026.8.12')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('der Nachhol-Poll ueberschreibt einen frisch gespeicherten Wert NICHT (#252)', async () => {
    // Der Fall, den `angewandt` NICHT deckt (CodeRabbit-CLI an PR #255, Major): dieser
    // Riegel ordnet nur Poll-Runden untereinander. Der Konkurrent ist hier `speichern()` —
    // eine Runde, die VOR dem PUT losflog, traegt Vor-Speicher-Daten und setzte den gerade
    // gespeicherten Wert zurueck. Erreichbar, weil dieser Poll UNAUFGEFORDERT bis zu zwoelf
    // Minuten laeuft, waehrend jemand auf der Seite tippt.
    const warten: Array<(w: Settings) => void> = []
    vi.useFakeTimers()
    try {
      zeige({ ytdlp: { ...BASIS.ytdlp, laeuft: true, ergebnis: '' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      vi.mocked(api.getSettings).mockImplementation(
        () => new Promise<Settings>(res => warten.push(res)))
      const vorher = warten.length

      await act(async () => { await vi.advanceTimersByTimeAsync(3000) })   // Runde 1 fliegt los
      expect(warten.length - vorher).toBe(1)          // Positivkontrolle: sie haengt wirklich

      // Waehrend sie unterwegs ist, speichert der Nutzer ein neues Whisper-Modell.
      vi.mocked(api.saveSettings).mockResolvedValue({
        ...GESPEICHERT, whisper_model: 'turbo',
        ytdlp: { ...BASIS.ytdlp, laeuft: true, ergebnis: '' },
      })
      await act(async () => {
        fireEvent.click(screen.getByRole('combobox', { name: /Qualität|Whisper/i }))
      })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      await act(async () => { fireEvent.click(screen.getByRole('option', { name: /Schnell/i })) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(vi.mocked(api.saveSettings)).toHaveBeenCalled()   // Positivkontrolle

      // Und JETZT trifft die alte Runde ein — mit dem Stand von vor dem Speichern.
      await act(async () => {
        warten[vorher]({ ...BASIS, whisper_model: 'large-v3',
                         ytdlp: { ...BASIS.ytdlp, laeuft: true, ergebnis: '' } })
      })
      expect(screen.getByRole('combobox', { name: /Qualität|Whisper/i }))
        .toHaveTextContent(/Schnell/i)                 // NICHT zurueck auf „Beste Qualität"
    } finally {
      vi.useRealTimers()
    }
  })

  it('sagt es, wenn der Nachhol-Poll aufgibt, statt die Zeile einzufrieren (#252)', async () => {
    // Ohne diesen Merker wäre nach zwölf Minuten wieder #252s Symptom da — die Zeile stünde
    // für immer. Ein Fehler-Toast wie beim Lauf-Poll wäre hier falsch: niemand hat etwas
    // angestossen, es ist kein Fehlschlag, nur eine aufgegebene Beobachtung.
    vi.useFakeTimers()
    try {
      zeige({ ytdlp: { ...BASIS.ytdlp, laeuft: true, ergebnis: '' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(screen.getByText(/läuft gerade/i)).toBeInTheDocument()   // Positivkontrolle
      await act(async () => { await vi.advanceTimersByTimeAsync(13 * 60_000) })
      expect(screen.getByText(/fragt nicht mehr von selbst nach/i)).toBeInTheDocument()
      expect(screen.queryByText(/läuft gerade/i)).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('nennt den Ordner der eigenen Dateien — auch ohne Electron (#218)', async () => {
    // Das Hauptversprechen der App ist „deine Aufnahmen bleiben bei dir". Die Kehrseite —
    // und du allein sicherst sie — war unadressiert: der Pfad stand genau einmal im
    // Einrichtungsfenster und danach nirgends. Er kommt vom SERVER, gilt also auch im
    // Browser, wo es keinen Knopf gibt.
    zeige()
    expect(await screen.findByText(BASIS.projekte_pfad)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Ordner öffnen/i })).not.toBeInTheDocument()
  })

  it('zeigt „Ordner öffnen" nur in der App und ruft die Brücke OHNE Pfad (#218)', async () => {
    // `window.transkribor` ist die Weiche App/Browser, nicht die Plattform. Und der Aufruf
    // ohne Argument ist die eigentliche Zusicherung: nähme der Kanal einen Pfad entgegen,
    // könnte alles, was in diesem Fenster läuft, ein beliebiges Verzeichnis öffnen lassen.
    const projekteOeffnen = vi.fn(async () => {})
    ;(window as unknown as { transkribor: unknown }).transkribor = { projekteOeffnen }
    try {
      zeige()
      const knopf = await screen.findByRole('button', { name: /Ordner öffnen/i })
      await act(async () => { fireEvent.click(knopf) })
      expect(projekteOeffnen).toHaveBeenCalledWith()
      expect(projekteOeffnen.mock.calls[0]).toHaveLength(0)
    } finally {
      delete (window as unknown as { transkribor?: unknown }).transkribor
    }
  })

  it('meldet einen Fehlschlag beim Öffnen, statt still nichts zu tun (#218)', async () => {
    // `shell.openPath` gibt im Fehlerfall die Meldung des Systems zurück; der Hauptprozess
    // wirft sie. Ohne Toast sähe der Nutzer einen Knopf, der nichts tut — die schlechteste
    // Sorte Fehlschlag.
    ;(window as unknown as { transkribor: unknown }).transkribor = {
      projekteOeffnen: vi.fn(async () => { throw new Error('Pfad gibt es nicht') }),
    }
    try {
      zeige()
      const knopf = await screen.findByRole('button', { name: /Ordner öffnen/i })
      await act(async () => { fireEvent.click(knopf) })
      expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/Pfad gibt es nicht/))
    } finally {
      delete (window as unknown as { transkribor?: unknown }).transkribor
    }
  })

  it('warnt bei large-v3 auf der CPU', async () => {
    zeige({ whisper_model: 'large-v3' }, { device: 'cpu', name: 'CPU', torch_ok: true, asr: 'cpu' })
    expect(await screen.findByText(/auf der CPU sehr lange/i)).toBeInTheDocument()
  })

  it('nennt auf Apple Silicon den fehlenden whisper-cpp statt CUDA', async () => {
    // Der Hinweis hing frueher an `device`. Auf einem Mac steht dort "mps" (das gilt der
    // Sprechertrennung), waehrend die Transkription auf der CPU rechnet — der Hinweis waere
    // also genau dort still gewesen, wo er am noetigsten ist.
    // Seit whisper.cpp ist `asr: 'cpu'` auf einem Mac kein Naturgesetz mehr, sondern eine
    // fehlende Installation. Der Hinweis muss deshalb den Befehl nennen, nicht bedauern.
    zeige({ whisper_model: 'large-v3' },
          { device: 'mps', name: 'Apple Silicon (Metal)', torch_ok: true, asr: 'cpu',
            asr_engine: 'faster-whisper' })
    expect(await screen.findByText(/auf der CPU sehr lange/i)).toBeInTheDocument()
    expect(screen.getByText(/brew install whisper-cpp/i)).toBeInTheDocument()
    expect(screen.queryByText(/NVIDIA-Grafikkarte/i)).not.toBeInTheDocument()
  })

  it('schweigt, wenn whisper.cpp auf der Apple-GPU rechnet', async () => {
    // Der Gegenfall zum Test darueber: laeuft Metal, gibt es nichts zu warnen. Ohne diesen
    // Test bliebe unbemerkt, dass die CPU-Warnung nur an `asr === 'cpu'` haengt.
    zeige({ whisper_model: 'large-v3' },
          { device: 'mps', name: 'Apple Silicon (Metal)', torch_ok: true, asr: 'metal',
            asr_engine: 'whisper.cpp' })
    expect(await screen.findByText(/Apple Silicon \(Metal\)/)).toBeInTheDocument()
    expect(screen.queryByText(/auf der CPU sehr lange/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/brew install whisper-cpp/i)).not.toBeInTheDocument()
  })

  it('nennt bei fehlendem PyTorch die Umgebung statt CUDA', async () => {
    // "Rechnet auf: PyTorch nicht installiert" plus CUDA-Hinweis war die falsche Fährte.
    zeige({}, { device: 'cpu', name: 'PyTorch nicht installiert', torch_ok: false, asr: 'cpu' })
    expect(await screen.findByText(/Umgebung ist unvollständig/)).toBeInTheDocument()
    expect(screen.queryByText(/NVIDIA-Grafikkarte/)).not.toBeInTheDocument()
  })

  it('zeigt keine CPU-Warnung, wenn eine GPU rechnet', async () => {
    zeige({ whisper_model: 'large-v3' })
    await screen.findByText(/NVIDIA RTX 5080/)
    expect(screen.queryByText(/auf der CPU sehr lange/i)).not.toBeInTheDocument()
  })
})

describe('Wegweiser Version und Updates', () => {
  // Die Mock-Vorgaben gehoeren HIERHIN, nicht in den Nachbarblock: allein laufend
  // (`vitest -t "Wegweiser"`) liefert der Automock von '@/lib/api' `undefined`, und
  // `.then` darauf reisst den Lauf um — gemessen, TypeError plus roter Test. Ein Test,
  // der nur in Gesellschaft gruen ist, sichert nichts (CodeRabbit-CLI, Major).
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.listModels).mockResolvedValue([])
    vi.mocked(api.getAuth).mockResolvedValue({ unterstuetzt: false, angemeldet: false, detail: '' })
  })

  it('verweist auf die eigene Seite, statt die Bedienung hier zu fuehren', async () => {
    // Die Update-Bedienung ist nach /version umgezogen; hier bleibt der Weg dorthin, sonst
    // findet sie niemand. Die Tests dazu stehen in VersionPage.test.tsx.
    zeige()
    const link = await screen.findByRole('link', { name: /Version und Updates/ })
    expect(link).toHaveAttribute('href', '/version')
    expect(screen.queryByRole('button', { name: /Nach Updates suchen/ })).toBeNull()
  })
})

describe('Tempo der Korrektur', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.listModels).mockResolvedValue([])
    vi.mocked(api.getAuth).mockResolvedValue({ unterstuetzt: false, angemeldet: false, detail: '' })
  })

  it('baut die Auswahl aus parallel_max und markiert parallel_default', async () => {
    // Beide Zahlen kommen vom SERVER. Der Test faehrt deshalb absichtlich NICHT mit 16/3:
    // mit den Produktivwerten waere er auch gruen, wenn die Komponente sie verdrahtet haette
    // — genau die zweite Quelle, gegen die settings.PARALLEL_MAX die eine sein soll.
    zeige({ parallel: '2', parallel_max: 4, parallel_default: '2' })
    await screen.findByText('Tempo der Korrektur')
    fireEvent.click(screen.getByRole('combobox', { name: /Gleichzeitige Anfragen/ }))
    const optionen = await screen.findAllByRole('option')
    expect(optionen.map(o => o.textContent)).toEqual(['1', '2 — Standard', '3', '4'])
  })

  it('sagt an, dass die Umgebungsvariable den Regler ueberstimmt — und sperrt ihn', async () => {
    // Ohne diese Auskunft ist der Regler ein toter Schalter mit Bestaetigungston: der Nutzer
    // stellt um, sieht seinen Wert, und der Lauf nimmt weiter den `.env`-Wert.
    zeige({ parallel: '3', parallel_env: '12' })
    await screen.findByText('Tempo der Korrektur')
    const hinweis = await screen.findByText(/wirkungslos/)
    expect(hinweis).toHaveTextContent('TRANSKRIBOR_PARALLEL')
    expect(hinweis).toHaveTextContent('12')                    // der WIRKSAME Wert wird genannt
    expect(screen.getByRole('combobox', { name: /Gleichzeitige Anfragen/ })).toBeDisabled()
  })

  it('ohne Override kein Hinweis und kein gesperrtes Feld', async () => {
    // Die Gegenprobe. Ein Hinweis, der immer dasteht, ist als Daueralarm derselbe Schaden
    // von der anderen Seite — und ein dauerhaft gesperrtes Feld waere der tote Schalter,
    // nur andersherum.
    zeige({ parallel: '5', parallel_env: '' })
    await screen.findByText('Tempo der Korrektur')
    expect(screen.queryByText(/wirkungslos/)).toBeNull()
    expect(screen.getByRole('combobox', { name: /Gleichzeitige Anfragen/ })).not.toBeDisabled()
  })
})
