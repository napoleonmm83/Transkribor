import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { toast } from 'sonner'
import { SettingsPage } from './SettingsPage'
import * as api from '@/lib/api'
import type { Hardware, Settings } from '@/lib/types'

vi.mock('@/lib/api')
// Ohne diesen Mock waere `expect(toast.error).not.toHaveBeenCalled()` keine Zusicherung,
// sondern ein Aufruf an eine echte Funktion, die immer "nicht aufgerufen" meldet.
// `info` gehört mit hinein, seit der yt-dlp-Knopf „läuft bereits" meldet (#174) — ein
// fehlender Schlüssel wirft hier `toast.info is not a function` statt still nichts zu tun.
// `warning` seit #194 (ungeschützt geschrieben), aus demselben Grund.
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))
// Default: kein Electron -> Abschnitt bleibt aus, wie es SettingsPage ausserhalb dieses
// Tests auch fuer alle SettingsPage-Tests erwartet, die zeigeMit gar nicht aufrufen.
vi.mock('@/hooks/useUpdate', () => ({
  useUpdate: vi.fn(() => ({ zustand: null, pruefen: vi.fn(), laden: vi.fn(), installieren: vi.fn() })),
}))

import { useUpdate } from '@/hooks/useUpdate'
import type { UpdateZustand } from '@/lib/types'

const BASIS: Settings = {
  provider: 'claude-cli', model: '', base_url: '', has_key: false, env_key: '',
  whisper_model: 'large-v3', whisper_lang: 'de',
  whisper_choices: [
    { id: 'turbo', label: 'Schnell und gut', hint: 'nahe large-Qualität' },
    { id: 'large-v3', label: 'Beste Qualität', hint: 'bester Dialekt' },
  ],
  ai_ready: true, ai_reason: '',
  kaputt: '',
  ytdlp_auto: '1',
  ytdlp: { version: '2026.8.12', unlesbar: false, geprueft: '2026-08-13', auto: true, env: false, laeuft: false, ergebnis: '' },
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
    zeige({ ytdlp: { version: null, unlesbar: false, geprueft: '', auto: true, env: false, laeuft: false, ergebnis: '' } })
    expect(await screen.findByText(/Nicht installiert/)).toBeInTheDocument()
  })

  it('unterscheidet unlesbare Metadaten von "nicht installiert"', async () => {
    // Beide Zustände liefern `version: null`. Vor #189 stand hier "steht damit nicht zur
    // Verfügung" — das Gegenteil dessen, was der Nutzer tun kann: der Import läuft, nur die
    // Selbstaktualisierung ist ausgesetzt. Die Anzeige darf nicht lügen.
    zeige({ ytdlp: { version: null, unlesbar: true, geprueft: '', auto: true, env: false, laeuft: false, ergebnis: '' } })
    expect(await screen.findByText(/Fassung nicht lesbar/)).toBeInTheDocument()
    expect(screen.queryByText(/Nicht installiert/)).not.toBeInTheDocument()
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
    zeige({ ytdlp_auto: '1', ytdlp: { version: '2026.8.12', unlesbar: false, geprueft: '', auto: false, env: true, laeuft: false, ergebnis: '' } })
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
    vi.mocked(api.updateYtdlp).mockResolvedValue({ gestartet: true, version: '2026.7.4', unlesbar: false, geprueft: '2026-08-13', auto: true, env: false, laeuft: false, ergebnis: 'fehler' })
    zeige()
    fireEvent.click(await screen.findByRole('button', { name: /Jetzt aktualisieren/i }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/fehlgeschlagen/)))
  })

  it('nennt beim Fehlschlag die kaputten Metadaten statt nach dem Netz zu fragen', async () => {
    // Bei kaputter METADATA scheitert pip SELBST (gemessen: `pip list` gegen eine
    // praeparierte dist-info endet mit Exit 2 und UnicodeDecodeError). Wer gerade "Fassung
    // nicht lesbar" gelesen und darauf geklickt hat, bekaeme sonst "bist du online?" —
    // dieselbe Fehldiagnose, gegen die #189 gebaut ist, drei Zeilen weiter oben.
    vi.mocked(api.updateYtdlp).mockResolvedValue({ gestartet: true, version: null, unlesbar: true, geprueft: '', auto: true, env: false, laeuft: false, ergebnis: 'fehler' })
    zeige()
    fireEvent.click(await screen.findByRole('button', { name: /Jetzt aktualisieren/i }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/Metadaten/)))
    expect(toast.error).not.toHaveBeenCalledWith(expect.stringMatching(/online/))
  })

  it('wartet nicht auf pip, sondern fragt nach — der Toast kommt erst am Ende (#174)', async () => {
    // Vorher hing der Request am pip-Lauf (>=340 s im schlimmsten Fall). Jetzt antwortet er
    // sofort mit `laeuft: true`; der Ausgang kommt über den nächsten getSettings. Geprüft
    // wird BEIDES — dass sofort noch nichts gemeldet wird UND dass am Ende doch etwas kommt.
    // Nur die erste Hälfte wäre erfüllt, wenn der Toast ganz verschwände: genau der stille
    // Fehlschlag, gegen den `ergebnis` gebaut ist.
    vi.mocked(api.updateYtdlp).mockResolvedValue({
      gestartet: true, version: '2026.7.4', unlesbar: false, geprueft: '', auto: true,
      env: false, laeuft: true, ergebnis: '',
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

  it('bricht die Nachfragerei ab, wenn die Seite verlassen wird', async () => {
    // Vorher war das eine freilaufende `while`-Schleife: sie pollte über die volle pip-Dauer
    // weiter, schrieb `setS` auf eine ausgehängte Komponente (React 18 warnt dazu nicht mehr)
    // und feuerte am Ende einen Toast für eine Seite, auf der niemand mehr ist.
    // Gefunden vom Reviewer-Subagenten an PR #223 (I3).
    vi.mocked(api.updateYtdlp).mockResolvedValue({
      gestartet: true, version: '2026.7.4', unlesbar: false, geprueft: '', auto: true,
      env: false, laeuft: true, ergebnis: '',
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
      env: false, laeuft: true, ergebnis: '',
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

  it('sagt an, wenn beim Laden schon eine Aktualisierung läuft', async () => {
    // Wer die Seite mitten in pip neu lädt, sähe sonst einen gewöhnlichen Knopf und
    // erführe nie, dass gerade etwas läuft — das Feld `laeuft` läge auf der Leitung und
    // würde nirgends benutzt. Der Knopf bleibt dabei BEDIENBAR: ein Klick hängt sich per
    // `gestartet: false` an den laufenden Lauf. (Reviewbefund M8 an PR #223.)
    zeige({ ytdlp: { ...BASIS.ytdlp, laeuft: true, ergebnis: '' } })
    expect(await screen.findByText(/Eine Aktualisierung läuft gerade/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Jetzt aktualisieren/i })).toBeEnabled()
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

function zeigeMit(zustand: UpdateZustand | null) {
  const spies = { pruefen: vi.fn(), laden: vi.fn(), installieren: vi.fn(), protokollOeffnen: vi.fn() }
  vi.mocked(useUpdate).mockReturnValue({ zustand, ...spies })
  // SettingsPage zeigt bis zum Laden von getSettings nur "Lädt…" und braucht wegen <Link> einen Router —
  // beides gibt der Brief nicht her, ohne das wuerde jeder Test hier auf "Lädt…" haengen bleiben.
  vi.mocked(api.getSettings).mockResolvedValue(BASIS)
  vi.mocked(api.getHardware).mockResolvedValue({ device: 'cuda', name: 'NVIDIA RTX 5080', torch_ok: true, asr: 'cuda' })
  return { ...render(<MemoryRouter><SettingsPage /></MemoryRouter>), spies }
}

describe('Abschnitt Version und Updates', () => {
  beforeEach(() => vi.clearAllMocks())

  it('ohne Electron erscheint der Abschnitt gar nicht', async () => {
    zeigeMit(null)
    await screen.findByText(/Qualität der Transkription/i)
    expect(screen.queryByText(/Version und Updates/)).toBeNull()
  })

  // `/aktuell/` allein reichte, solange das Wort nur einmal auf der Seite stand. Seit dem
  // Abschnitt "Video-Import" ("Videodownloader aktuell halten") trifft es zwei Stellen —
  // gesucht wird deshalb der tatsaechlich gerenderte Text " · aktuell" des Update-Blocks.
  it('zeigt die laufende Version', async () => {
    zeigeMit({ version: '0.2.1', art: 'aktuell' })
    expect(await screen.findByText(/0\.2\.1/)).toBeTruthy()
    expect(screen.getByText(/· aktuell/)).toBeTruthy()
  })

  it('vor der ersten Pruefung nur Version und Knopf, kein "aktuell"', async () => {
    zeigeMit({ version: '0.2.1', art: 'unbekannt' })
    expect(await screen.findByRole('button', { name: /Nach Updates suchen/ })).toBeTruthy()
    expect(screen.queryByText(/· aktuell/)).toBeNull()   // sonst behauptet die Seite Wissen, das sie nicht hat
  })

  it('bietet den Download mit Groesse an', async () => {
    zeigeMit({ version: '0.2.1', art: 'verfuegbar', neue: '0.3.0', groesse: 98566144 })
    expect(await screen.findByText(/0\.3\.0 verfügbar/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Herunterladen \(94 MB\)/ })).toBeTruthy()
  })

  it('bietet den Download ohne Groesse an, statt "0 MB" zu erfinden', async () => {
    zeigeMit({ version: '0.2.1', art: 'verfuegbar', neue: '0.3.0', groesse: null })
    const btn = await screen.findByRole('button', { name: 'Herunterladen' })
    expect(btn.textContent).not.toMatch(/MB/)
  })

  it('zeigt beim Laden Prozent, MB und Tempo', async () => {
    zeigeMit({ version: '0.2.1', art: 'laedt', prozent: 43.2, geladen: 41 * 1048576, gesamt: 94 * 1048576, tempo: 6.2 * 1048576 })
    expect(await screen.findByText(/43 %/)).toBeTruthy()
    expect(screen.getByText(/41 von 94 MB/)).toBeTruthy()
    expect(screen.getByText(/6,2 MB\/s/)).toBeTruthy()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '43')
  })

  it('bietet nach dem Laden den Neustart an', async () => {
    zeigeMit({ version: '0.2.1', art: 'bereit', neue: '0.3.0' })
    expect(await screen.findByRole('button', { name: /Neu starten und installieren/ })).toBeTruthy()
  })

  it('Mac (verfuegbar_manuell): Manuelldownload-Knopf statt Auto-Download', async () => {
    // Mac kann nicht auto-aktualisieren (Squirrel.Mac ohne Notarisierung), prueft aber manuell.
    // Der Zustand zeigt einen "Manuell herunterladen"-Knopf (geht ueber den laden-IPC, der auf Mac
    // die Release-Seite oeffnet), NICHT den "Herunterladen"-Auto-Knopf aus 'verfuegbar'.
    const { spies } = zeigeMit({ version: '0.16.0', art: 'verfuegbar_manuell', neue: '0.17.0', groesse: 149843177 })
    expect(await screen.findByText(/0\.17\.0/)).toBeTruthy()
    expect(screen.getByText(/Auto-Update.*nicht möglich/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Manuell herunterladen/ }))
    expect(spies.laden).toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /^Herunterladen/ })).toBeNull()   // kein Auto-Knopf
  })

  it('kennt auch die beiden anderen Gruende', async () => {
    zeigeMit({ version: '0.2.1', art: 'nicht_moeglich', grund: 'entwicklung' })
    expect(await screen.findByText(/Entwicklungsmodus/)).toBeTruthy()
    cleanup()
    zeigeMit({ version: '0.2.1', art: 'nicht_moeglich', grund: 'kein-appimage' })
    expect(await screen.findByText(/AppImage/)).toBeTruthy()
  })

  it('zeigt einen Fehler samt Weg zum Protokoll', async () => {
    zeigeMit({ version: '0.2.1', art: 'fehler', text: '404 releases.atom' })
    expect(await screen.findByText(/404 releases\.atom/)).toBeTruthy()
  })

  it('im Fehlerzustand: erneut pruefen bleibt moeglich, und es gibt einen Weg ins Protokoll', async () => {
    // War vorher eine Sackgasse: kein Knopf, kein Weg raus ausser Neustart.
    const { spies } = zeigeMit({ version: '0.2.1', art: 'fehler', text: '404 releases.atom' })
    await screen.findByText(/404 releases\.atom/)
    expect(screen.getByRole('button', { name: /Nach Updates suchen/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Protokoll/ }))
    expect(spies.protokollOeffnen).toHaveBeenCalled()
  })

  it('sperrt den Knopf waehrend der Pruefung', async () => {
    zeigeMit({ version: '0.2.1', art: 'prueft' })
    expect((await screen.findByRole('button', { name: /Wird geprüft/ })).hasAttribute('disabled')).toBe(true)
  })
})
