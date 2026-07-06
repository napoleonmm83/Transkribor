# Transkribor

Interview-Audio → kontextkorrigierte, **sprecher-markierte** Transkripte.
Schweizerdeutsch (oder andere Sprachen) mit **Whisper large-v3** (GPU), danach ein
LLM-Korrekturlauf (via Claude Code) für Kontextfehler und Sprecher-Labels.

## Projektstruktur

```
Transkribor/
├── transcribe.py          # Whisper-Transkription (projekt-aware)
├── transkribieren.ps1     # Starter für PowerShell
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

## Voraussetzungen

- NVIDIA-GPU (getestet: RTX 5080 / Blackwell), Treiber mit CUDA 12.8+.
- Python-Umgebung liegt in `.venv` (torch cu128 + openai-whisper). Neu aufsetzen:
  ```powershell
  uv venv --python 3.13 .venv
  uv pip install --python .venv\Scripts\python.exe torch --index-url https://download.pytorch.org/whl/cu128
  uv pip install --python .venv\Scripts\python.exe openai-whisper
  ```
- ffmpeg (`winget install Gyan.FFmpeg`) — `transcribe.py` findet es automatisch.
- Modell `large-v3` lädt beim ersten Lauf einmalig (~3 GB) nach `~\.cache\whisper`.
