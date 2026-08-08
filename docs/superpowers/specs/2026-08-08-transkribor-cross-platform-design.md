# Transkribor Cross-Platform — Design (Spec 1: „Läuft überall")

Datum: 2026-08-08
Status: Entwurf zur Freigabe

## Ziel

Transkribor läuft auf Windows, macOS (Apple Silicon) und Linux. Die Abhängigkeiten
installieren sich so weit wie plattformüblich vertretbar selbst, der Nutzer wählt die
Whisper-Qualitätsstufe im Browser, und er sieht, auf welchem Gerät gerechnet wird.

Hintergrund: die App soll öffentlich (Open Source) verteilt werden. GPU bzw. Apple Silicon
gilt als Systemvoraussetzung; CPU bleibt ein dokumentierter, langsamer Notnagel.

## Nicht-Ziele

- **CPU-Performance-Optimierung.** Wer keine GPU hat, bekommt eine ehrliche Ansage, keinen
  Optimierungspfad.
- **Zweites ASR-Backend (`whisper.cpp`/Metal).** Erst nach der Messung unten entscheiden —
  siehe „Offene Messung".
- **AMD/ROCm, Windows-on-ARM, Intel-Macs.** Nicht unterstützt, in der README benannt.
- **Signatur, Notarisierung, öffentliches Release, CI-Matrix.** Das ist Spec 2.
- **Inhaltsfunktionen** (Volltextsuche, Zusammenfassungen, Synthese). Eigenes Brainstorming.

## Komponenten

Sieben Einheiten, jede für sich verständlich und prüfbar.

### 1. Geräteerkennung — neu: `webtool/device.py`

Heute steht die Erkennung zweimal da (`transcribe.py:96`, `webtool/diarize.py:26`) und kennt
nur `cuda`/`cpu`. Beide Stellen rufen künftig dieselbe Funktion:

```python
def pick() -> str:      # "cuda" | "mps" | "cpu"
def describe() -> dict  # {"device": ..., "name": "NVIDIA GeForce RTX 5080", "torch_ok": True}
```

Reihenfolge: `cuda` → `mps` (nur wenn `torch.backends.mps.is_available()`) → `cpu`.
Der torch-Import bleibt **innerhalb** der Funktionen (lazy), wie in `diarize.py` schon
etabliert — sonst zahlt jeder Import den torch-Start.

`transcribe.py:117` (`fp16=(device == "cuda")`) bleibt unverändert korrekt: MPS rechnet fp32.

Für `diarize.py` braucht es keinen eigenen Rückfall: die Diarisierung ist bereits best-effort
(scheitert sie, entsteht kein `.diar.json` und die Korrektur läuft wie vor Stufe 3 weiter).
Ein MPS-Fehlschlag dort kostet die Sprechertrennung, nicht den Lauf.

**MPS-Gotcha und wie wir damit umgehen.** Whisper nutzt Operationen, die MPS je nach
torch-Version nicht abdeckt. `PYTORCH_ENABLE_MPS_FALLBACK=1` setzen wir **nicht** automatisch:
das schiebt einzelne Ops still auf die CPU, die Anzeige sagt weiter „mps", und der Nutzer
wundert sich über die Laufzeit. Stattdessen: MPS versuchen; scheitert die **erste** Datei mit
einer Exception, das Modell einmalig auf CPU neu laden, den Wechsel laut ins Log schreiben und
den Lauf fortsetzen. Ein Fehlschlag kostet damit eine Datei Anlaufzeit, nicht den ganzen Lauf.

### 2. Whisper-Qualitätsstufen in den Einstellungen

`settings.py` bekommt zwei Felder in `DEFAULTS`:

```python
"whisper_model": "large-v3",   # bisheriges Verhalten bleibt der Default
"whisper_lang":  "de",
```

`job_env()` exportiert sie nach `WHISPER_MODEL` / `WHISPER_LANG` — **eine echte
Umgebungsvariable gewinnt**, genau wie beim vorhandenen `HF_TOKEN`. Damit ist die Verdrahtung
fertig: `jobs.py:124` mergt `job_env()` bereits in die Subprozess-Umgebung, und
`transcribe.py:142` liest `WHISPER_MODEL` schon heute. Kein neuer Pfad.

`SettingsBody` und `settings.public()` bekommen die Felder; `SettingsPage.tsx` ein Auswahlfeld.
Kuratierte Liste statt aller 14 Modellnamen — die `.en`-Varianten sind für deutschsprachige
Interviews sinnlos, `large-v1/v2` sind überholt:

| Wert | Anzeige | Hinweis |
|---|---|---|
| `tiny` | Sehr schnell | grobe Fehler, für Tests |
| `small` | Schnell | brauchbar bei klarem Hochdeutsch |
| `medium` | Ausgewogen | |
| `turbo` | Schnell und gut | nahe large-Qualität, deutlich schneller |
| `large-v3` | Beste Qualität (Standard) | langsamste, bester Dialekt |

Default bleibt `large-v3`: Schweizerdeutsch profitiert am stärksten davon, und eine
Verhaltensänderung für Bestandsnutzer wäre unnötig.

### 3. Hardware-Anzeige — `GET /api/hardware`

Liefert `device.describe()`, einmal pro Serverlauf ermittelt und im Prozess gecacht (der
torch-Import kostet Sekunden). Die Einstellungsseite zeigt das Ergebnis über der Modellwahl.

Der Import läuft direkt im Serverprozess — uvicorn startet aus derselben venv, in der auch
torch liegt. Fehlt torch (Einrichtung abgebrochen), meldet `describe()` `torch_ok: false`
statt zu werfen: die Einstellungsseite muss auch in einer halben Umgebung aufrufbar bleiben.

Warum überhaupt: „Warum dauert das so lange" wird die häufigste Frage öffentlicher Nutzer. Wer
sieht, dass `cpu` läuft, versteht die Antwort ohne Support.

### 4. Plattformabhängige Einrichtung — `electron/setup.js`

Kern ist eine **reine Funktion** `plan(platform)` → `{ torchIndex, pakete, hinweis }`, damit
die Entscheidung ohne laufendes Electron prüfbar ist.

| Plattform | Python / ffmpeg | Torch |
|---|---|---|
| `win32` | winget (wie bisher, automatisch) | `--index-url .../whl/cu128` |
| `darwin` | Befehl anzeigen (`brew install python ffmpeg`) | PyPI-Default — bringt MPS mit |
| `linux` | Befehl anzeigen (apt/dnf/pacman erkannt) | `--index-url .../whl/cu128` |

Auf Linux ziehen wir cu128 **ohne** vorherige NVIDIA-Erkennung: die Räder installieren auch
ohne Karte und fallen zur Laufzeit auf CPU zurück. Eine Erkennung vor der Installation wäre
eine zusätzliche Fehlerquelle für ein paar gesparte Gigabyte — und wer bewusst ohne GPU
arbeitet, ist ohnehin außerhalb der Systemvoraussetzung.

**Wir installieren auf macOS/Linux nichts selbst.** Beides bräuchte `sudo` bzw. einen
vorhandenen Homebrew, und eine GUI-App, die einen Passwort-Prompt für eine Systeminstallation
aufmacht — oder ungefragt einen Paketmanager nachzieht — ist zu viel Magie. Stattdessen zeigt
die Statusseite den exakten Befehl zum Kopieren. Auf Windows bleibt winget automatisch: er
läuft ohne Adminrechte und ist dort die etablierte Erwartung.

`venvVollstaendig()` und `paths.venvPython()` bleiben unverändert — beide sind schon
plattformneutral.

### 5. ffmpeg-Suche — `transcribe.py:ensure_ffmpeg()`

Der winget-Glob (Zeile 27–31) wandert hinter `sys.platform == "win32"`. Für macOS/Linux kommen
die üblichen Homebrew-Pfade dazu (`/opt/homebrew/bin`, `/usr/local/bin`).

Das ist kein Schönheitsfehler: **GUI-Apps erben auf macOS ein anderes PATH als die Shell** —
ffmpeg ist per `brew` installiert, in der Shell auffindbar, und die App findet es trotzdem
nicht. Ohne diesen Zweig scheitert jede Transkription auf einem korrekt eingerichteten Mac.

### 6. Build-Targets — `package.json`

- `mac`: `dmg`, `arm64` (Intel-Macs sind für GPU ohnehin außen vor)
- `linux`: `AppImage` (läuft ohne Paketmanager) und `deb`
- `win`: unverändert

Nur lokales Bauen. Veröffentlichung, Signatur und CI sind Spec 2.

### 7. „Kein KI-Anbieter eingerichtet" als sauberer Zustand

**Das eigentliche Erstnutzer-Problem.** `llm._cfg()` fällt bei unbekanntem Anbieter auf
`claude-cli` zurück, das `needs_key: False` trägt, und `TRANSKRIBOR_AUTOCORRECT` steht default
auf `1`. Ein frisch installierter Nutzer lädt also Audio hoch, die Transkription läuft — und
direkt danach startet automatisch ein Korrektur-Job, der fehlschlägt, weil es kein
`claude`-Binary gibt. Das ist der erste Eindruck der App.

Gelöst wird das **nicht** durch einen anderen Default (das bräuchte eine Migration für
Bestandsnutzer), sondern durch eine Verfügbarkeitsprüfung in `llm.py`:

```python
def available() -> tuple[bool, str]:
    """(nutzbar, Begründung) — prüft Fähigkeit, nicht Absicht."""
    # claude-cli  -> shutil.which("claude") is not None
    # API-Anbieter -> Key + Modell (+ base_url beim Custom-Endpoint) vorhanden
```

Daraus folgt:

- **Auto-Korrektur startet gar nicht**, wenn kein Anbieter nutzbar ist — statt einen Job zu
  starten, der scheitert. Eine Log-Zeile, kein Fehler.
- **Der Korrigieren-Knopf bleibt sichtbar, aber deaktiviert**, mit Verweis auf die
  Einstellungen. Eine verschwundene Funktion wirkt wie ein Bug, eine deaktivierte erklärt sich.
- **Die Transkription ist davon unberührt.** Der Kern der App funktioniert ohne jede KI — das
  ist auch die ehrliche Botschaft für die README.
- Bestandsnutzer mit installiertem `claude` merken nichts.

`GET /api/settings` liefert `ai_ready: bool` und `ai_reason: str` mit; das Frontend braucht
keine eigene Logik und kann den Grund direkt anzeigen („kein `claude` gefunden" ist eine andere
Handlungsanweisung als „kein API-Key hinterlegt").

## Datenfluss

```
Einstellungsseite → PUT /api/settings → settings.json (Nutzerprofil)
                                            ↓ settings.job_env()
                              jobs.start(env=…) → transcribe.py --model $WHISPER_MODEL
                                            ↓ device.pick()
                                     whisper.load_model(device)
```

Keine neue Verdrahtung: jedes Glied dieser Kette existiert bereits, es kommen nur zwei
Schlüssel und eine gemeinsame Geräteentscheidung dazu.

## Fehlerfälle

| Fall | Verhalten |
|---|---|
| MPS bricht bei der ersten Datei ab | einmalig Modell auf CPU neu laden, laut loggen, Lauf fortsetzen |
| torch ohne CUDA installiert (falscher Index gezogen) | `/api/hardware` meldet `cpu` trotz NVIDIA → Hinweis „Umgebung neu einrichten" |
| Python/ffmpeg fehlt auf macOS/Linux | Befehl zum Kopieren anzeigen, nichts heimlich mit sudo installieren |
| Unbekannter Modellname in `settings.json` | auf `large-v3` zurückfallen statt Absturz beim Laden |
| ffmpeg nur unter `/opt/homebrew/bin` | Pfad vor dem Lauf in `PATH` ergänzen |
| Kein KI-Anbieter nutzbar | Auto-Korrektur überspringen, Knopf deaktiviert, Transkription unberührt |

## Tests

Automatisiert:

- `webtool/test_device.py` — `pick()` mit gefälschtem torch: `cuda` vor `mps` vor `cpu`; `mps`
  nur wenn verfügbar gemeldet.
- `webtool/test_settings.py` — `whisper_model` Round-Trip; `job_env()` exportiert; echte
  Umgebungsvariable gewinnt; unbekanntes Modell fällt auf den Default zurück.
  (`TRANSKRIBOR_SETTINGS` setzen — sonst entscheidet die echte Einstellungsdatei mit.)
- `webtool/test_llm.py` — `available()` je Anbieterform.
- `webtool/test_api.py` — Auto-Korrektur startet nicht ohne nutzbaren Anbieter.
- `electron/setup.test.js` — `plan()` je Plattform, mit `node --test` (Standardbibliothek,
  kein Framework; erste JS-Tests im Repo).

Manuell, nicht automatisierbar — je ein vollständiger Lauf:

- Windows + RTX 5080 (Regression: es muss bleiben, wie es ist)
- Apple Silicon: Ersteinrichtung, Transkription, Diarisierung
- Linux-VM: Ersteinrichtung, CPU-Pfad

## Offene Messung (Gate für eine spätere Entscheidung)

Auf dem M-Mac dieselbe Audiodatei mit `large-v3` und `turbo`, je `mps` und `cpu`, Laufzeit
notieren. Das Ergebnis entscheidet, ob `whisper.cpp` mit Metal als zweites Backend nötig wird —
mit einer Zahl als Begründung statt aus dem Bauch. Solange die Messung fehlt, wird kein
zweites Backend gebaut.
