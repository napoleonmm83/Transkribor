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
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
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
  ytdlp_auto: '1',
  ytdlp: { version: '2026.8.12', geprueft: '2026-08-13', auto: true, env: false },
  providers: [
    { id: 'claude-cli', label: 'Claude Code Abo (kein Key)', needs_key: false, cli: true, base: '', default_model: 'opus', keys_url: '', hint: 'Nutzt das Abo.' },
    { id: 'codex-cli', label: 'ChatGPT-Abo (Codex CLI, kein Key)', needs_key: false, cli: true, base: '', default_model: '', keys_url: '', hint: 'Nutzt das ChatGPT-Abo.' },
    { id: 'anthropic', label: 'Anthropic (Claude)', needs_key: true, cli: false, base: 'https://api.anthropic.com/v1', default_model: 'claude-opus-5', keys_url: 'https://x', hint: '' },
  ],
}

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
    vi.mocked(api.saveSettings).mockResolvedValue({ ...BASIS, provider: 'anthropic', has_key: true })
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
    vi.mocked(api.saveSettings).mockResolvedValue({ ...BASIS, provider: 'anthropic', has_key: true, model: '' })
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
    expect(screen.getByText(/zuletzt geprüft am 2026-08-13/)).toBeInTheDocument()
  })

  it('sagt es, wenn yt-dlp gar nicht installiert ist', async () => {
    zeige({ ytdlp: { version: null, geprueft: '', auto: true, env: false } })
    expect(await screen.findByText(/Nicht installiert/)).toBeInTheDocument()
  })

  it('speichert den Haken als "0"/"1"', async () => {
    vi.mocked(api.saveSettings).mockResolvedValue({ ...BASIS, ytdlp_auto: '0' })
    zeige()
    const haken = await screen.findByRole('checkbox', { name: /aktuell halten/i })
    fireEvent.click(haken)
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({ ytdlp_auto: '0' }))
  })

  it('warnt, wenn die Umgebungsvariable den Haken überstimmt', async () => {
    // Ein Haken, der nichts tut, ist schlimmer als keiner. Der WIRKSAME Wert kommt aus
    // `ytdlp.auto`, der gespeicherte aus `ytdlp_auto` — nur die Differenz ist die Warnung.
    zeige({ ytdlp_auto: '1', ytdlp: { version: '2026.8.12', geprueft: '', auto: false, env: true } })
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
    vi.mocked(api.saveSettings).mockResolvedValue({ ...BASIS, ytdlp_auto: '0' })
    zeige()
    const haken = await screen.findByRole('checkbox', { name: /aktuell halten/i })
    // Erst NACH dem Laden scheitern lassen — ein `…Once` davor träfe den Aufbau der Seite,
    // und der Test prüfte dann nur noch „Lädt…“.
    vi.mocked(api.getSettings).mockRejectedValue(new Error('weg'))
    await act(async () => { fireEvent.click(haken) })
    expect(screen.queryByText(/wirkungslos/)).not.toBeInTheDocument()
  })

  it('meldet einen fehlgeschlagenen Update-Versuch, statt ihn zu verschlucken', async () => {
    vi.mocked(api.updateYtdlp).mockResolvedValue({ ok: false, version: '2026.7.4', geprueft: '2026-08-13', auto: true, env: false })
    zeige()
    fireEvent.click(await screen.findByRole('button', { name: /Jetzt aktualisieren/i }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/fehlgeschlagen/)))
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
