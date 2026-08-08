# Transkribor

Interview-Audio → kontextkorrigierte, **sprecher-markierte** Transkripte.
Schweizerdeutsch (oder andere Sprachen) mit **Whisper large-v3** (GPU), danach ein
LLM-Korrekturlauf (via Claude Code) für Kontextfehler und Sprecher-Labels.

## Systemvoraussetzungen

Die Transkription läuft lokal auf deinem Rechner. Empfohlen:

- **Windows / Linux:** NVIDIA-GPU mit aktuellem Treiber
- **macOS:** Apple Silicon (M1 oder neuer)
- **Ohne GPU** läuft alles ebenfalls, aber deutlich langsamer — dann in den Einstellungen
  eine kleinere Qualitätsstufe als „Beste Qualität" wählen.

Die Korrektur und Sprecher-Zuordnung brauchen zusätzlich ein Sprachmodell (eigener API-Key,
lokales Modell über einen OpenAI-kompatiblen Endpunkt wie Ollama, oder ein Claude-Code-Abo).
**Ohne Sprachmodell funktioniert die Transkription vollständig** — nur die Korrektur entfällt.

## Desktop-App (empfohlen)

`Transkribor-Setup-<version>.exe` aus den [Releases](https://github.com/napoleonmm83/Transkribor/releases)
installieren und starten. Beim ersten Start richtet die App die Spracherkennung selbst ein
(Python, ffmpeg, PyTorch, Whisper — mehrere GB, 10–30 Minuten, mit Fortschrittsanzeige).
Danach läuft alles offline auf dem eigenen Rechner. Updates meldet die App selbst.

Audio hineinziehen genügt: **Transkription und Korrektur starten automatisch**, der Status
aktualisiert sich live. Unter *Einstellungen* wird hinterlegt, womit korrigiert wird — Claude-Code-Abo
(kein Key) oder ein API-Key von Anthropic, OpenAI, Google, OpenRouter oder einem beliebigen
OpenAI-kompatiblen Dienst (auch lokal, z.B. Ollama).

Selbst bauen: `npm install && npm run dist` → Installer für die aktuelle Plattform in `dist\`
(Windows: `Transkribor-Setup-<version>.exe`, macOS: `.dmg`, Linux: `AppImage`/`.deb`).

## Projektstruktur

```
Transkribor/
├── transcribe.py          # Whisper-Transkription (projekt-aware)
├── transkribieren.ps1     # Starter für PowerShell
├── webtool/               # FastAPI-Backend + React-Editor (webtool.ps1 startet beides)
├── electron/              # Desktop-Hülle: Ersteinrichtung, Server-Start, Auto-Update
├── requirements.txt       # Python-Pakete ohne torch (wird plattformabhängig installiert)
├── tools/correct_label.mjs# Claude-Workflow: Kontextkorrektur + Sprecher
├── CLAUDE.md              # Anleitung für Claude (Korrektur-Schritt)
├── .venv/                 # Python-Umgebung (nicht in Git)
└── projekte/
    └── <Projektname>/
        ├── audio/          # hier Audio hineinlegen
        ├── transkripte/    # Ergebnisse (.md = fertig, .json/.txt = Roh)
        └── kontext.md      # optional: Beschreibung + bekannte Namen
```

## Neues Projekt

1. Ordner `projekte\<Name>\audio\` anlegen und Audiodateien (mp3/wav/m4a/…) hineinlegen.
2. Optional `projekte\<Name>\kontext.md` mit kurzer Beschreibung + bekannten Eigennamen —
   das verbessert sowohl Whisper als auch die Korrektur spürbar.

## Transkribieren (Schritt 1 — läuft allein)

```powershell
.\transkribieren.ps1 <Name>      # ein Projekt
.\transkribieren.ps1 --all       # alle Projekte
.\transkribieren.ps1 --list      # Projekte anzeigen
```

Erzeugt pro Datei `<base>.json`, `<base>.raw.txt`, `<base>.segments.txt` in `transkripte\`.
Bereits transkribierte Dateien werden übersprungen.

## Korrigieren + Sprecher markieren (Schritt 2 — mit Claude Code)

Claude Code in diesem Ordner öffnen und sagen: **„transkribiere Projekt \<Name\>"** bzw.
**„korrigiere Projekt \<Name\>"**. Claude liest `CLAUDE.md`, baut ein gemeinsames Glossar,
korrigiert jede Datei im Kontext, markiert die Sprecher und verifiziert gegen das
Rohtranskript. Ergebnis: `transkripte\<base>.md`.

## Manuelle Einrichtung (Windows, CLI)

Nur relevant, wenn du **nicht** die Desktop-App nutzt, sondern die Python-Umgebung selbst
aufsetzt (bislang nur für Windows dokumentiert — siehe „Systemvoraussetzungen" oben für die
allgemeine Geräteunterstützung).

- NVIDIA-GPU (getestet: RTX 5080 / Blackwell), Treiber mit CUDA 12.8+.
- Python-Umgebung liegt in `.venv` (torch cu128 + openai-whisper). Neu aufsetzen:
  ```powershell
  uv venv --python 3.13 .venv
  uv pip install --python .venv\Scripts\python.exe torch --index-url https://download.pytorch.org/whl/cu128
  uv pip install --python .venv\Scripts\python.exe openai-whisper
  ```
- ffmpeg (`winget install Gyan.FFmpeg`) — `transcribe.py` findet es automatisch.
- Modell `large-v3` lädt beim ersten Lauf einmalig (~3 GB) nach `~\.cache\whisper`.

## Editieren im Browser (Web-Tool, Stufe 1)

Lokaler Editor zum abschnittweisen Prüfen/Korrigieren mit Klick-zum-Abspielen. Frontend ist
React 19 + Vite + TypeScript + Tailwind v4 + shadcn/ui (`webtool/frontend/`), gebaut nach
`webtool/static/` (git-ignoriert) und von FastAPI ausgeliefert:

```powershell
.\webtool.ps1        # baut das Frontend bei Bedarf, startet http://127.0.0.1:8000/, öffnet den Browser
```

Frontend-Entwicklung mit Hot-Reload: `npm --prefix webtool/frontend run dev` (Vite auf :5173,
proxied `/api` zum FastAPI-Backend auf :8000).

- Zeigt vorhandene Transkripte pro Projekt, spielt je Abschnitt das Audio-Snippet,
  hebt unsichere Wörter hervor (Whisper-`probability`, Schwellen verstellbar).
- Korrektionen werden **nicht-destruktiv** in `<base>.edit.json` gespeichert; die
  Roh-`<base>.json` bleibt unangetastet; `<base>.md` wird als Export daraus erzeugt.

**Transkribieren im Browser (Stufe 2a):** In der Projektliste lädt ⬆ Audio in `projekte\<NAME>\audio\` hoch und ▶ startet `transcribe.py` als Hintergrundjob; der Fortschritt erscheint live im Panel; **Abbrechen** stoppt einen laufenden Job samt Prozessbaum. Hinweis: **nicht mit `uvicorn --reload` starten, während Jobs laufen** — ein Reload killt laufende Jobs und die Job-Liste.

**Korrigieren im Browser (Stufe 2b):** ✎ startet den Korrektur-Ablauf als Hintergrundjob (gleiches Live-Panel). Läuft über headless `claude -p` (Claude-Code-Abo, **kein API-Key**): erst ein gemeinsames Glossar über alle Roh-Transkripte, dann pro Datei eine segment-genaue Kontext-Korrektur + Sprecher-Labeling, das direkt `<base>.correction.json` schreibt, anschließend ein **Treue-Verifikations-Pass** gegen das Rohtranskript (Default an; abschaltbar per `--no-verify` bzw. Env `TRANSKRIBOR_VERIFY=0`), gefolgt vom deterministischen Assemble zu `<base>.edit.json` + `<base>.md`. Idempotent: Dateien mit `human_edited=true` oder bereits vorhandener `correction.json` werden übersprungen; eine fehlgeschlagene Datei bricht den Lauf nicht ab. Dasselbe auch per CLI: `python -m webtool.correct run <NAME>`.
