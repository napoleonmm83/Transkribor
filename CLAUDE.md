# Transkribor — Anleitung für Claude

Dieses Repo transkribiert Interview-Audio (oft **Schweizerdeutsch**) mit Whisper und
erzeugt daraus kontextkorrigierte, **sprecher-markierte** Transkripte.

## Ablauf, wenn der Nutzer „transkribiere Projekt <NAME>" sagt

(bzw. wenn neue Audiodateien in `projekte\<NAME>\audio\` liegen)

### Schritt 1 — Transkription (Whisper large-v3, GPU)
Läuft eigenständig, kann je nach Audiolänge dauern → am besten im Hintergrund:

```
E:\Git\Transkribor\.venv\Scripts\python.exe E:\Git\Transkribor\transcribe.py "<NAME>"
```

Erzeugt pro Audiodatei in `projekte\<NAME>\transkripte\`:
`<base>.json` (Vollausgabe), `<base>.raw.txt` (Fliesstext), `<base>.segments.txt` (mit Zeitstempeln).
Bereits vorhandene werden übersprungen.

### Schritt 2 — Kontext-Korrektur + Sprecher-Labeling (braucht Claude)

**Ein-Befehl-Variante (Stufe 2b):** `python -m webtool.correct run "<NAME>"` macht prep +
gemeinsames Glossar + pro Datei Korrektur + **Treue-Verifikation gegen Roh** + apply automatisch
per headless `claude -p` (oder im Web-Tool der ✎-Button). Der Treue-Pass läuft per Default
(abschaltbar per `--no-verify` bzw. Env `TRANSKRIBOR_VERIFY=0`). Für volle Kontrolle /
Parallelität der manuelle Workflow unten.

Bevorzugt als paralleler Workflow (ein geteiltes Glossar über alle Dateien → pro Datei
Korrektur → Verifikation gegen das Rohtranskript):

1. Sammle die Basisnamen: alle `*.segments.txt` in `projekte\<NAME>\transkripte\` (Dateiname ohne Endung).
2. Lies `projekte\<NAME>\kontext.md` falls vorhanden → `context`.
3. **Vor-Taggen** (unsichere Wörter für den LLM markieren):
   ```
   E:\Git\Transkribor\.venv\Scripts\python.exe -m webtool.correct prep "<NAME>"
   ```
   (erzeugt `<base>.tagged.txt` je Datei)
4. **Korrektur-Workflow** (segment-genaue Korrektur + Sprecher):
   ```
   Workflow({ scriptPath: "E:\\Git\\Transkribor\\tools\\correct_label.mjs",
              args: { dir: "E:\\Git\\Transkribor\\projekte\\<NAME>\\transkripte",
                      bases: [ ...basenames... ],
                      context: "<Inhalt von kontext.md oder kurze Beschreibung>" } })
   ```
   Der Workflow liefert `{ glossary, corrections: [{ base, context, speakers, segments, annotations, summary, verification }] }`.
   **`summary` = worum es inhaltlich geht, `verification` = was der Treue-Pass geändert hat.**
   Beides stand früher in `summary`; weil Verify zuletzt schreibt, landete in 13 von 14 echten
   Dateien ein Änderungsprotokoll statt einer Zusammenfassung. Nur `summary` wandert in die
   `edit.json` (und in den Markdown-Export) — Prüfprotokoll ist kein Inhalt.
   (Ist die Workflow-Funktion nicht verfügbar, führe die Korrektur **inline** aus — dieselben Regeln, siehe unten — und erzeuge dieselbe Korrektur-Struktur pro Datei.)
5. **Assemblieren**: pro Datei die zurückgegebene Korrektur nach `projekte\<NAME>\transkripte\<base>.correction.json` schreiben, dann:
   ```
   E:\Git\Transkribor\.venv\Scripts\python.exe -m webtool.correct apply "<NAME>" "<base>"
   ```
   (baut `<base>.edit.json` + `<base>.md`; überschreibt `edit.json` mit `human_edited=true` nicht — dafür `--force`).

Ergebnis: `projekte\<NAME>\transkripte\<base>.edit.json` (Editor-Dokument, im Web-Tool bearbeitbar) + `<base>.md` (Export).

## Korrektur-Regeln (gelten für Workflow UND inline)
- **Treu bleiben:** klare ASR-Fehler korrigieren (falsch gehörte Wörter, Eigennamen, im
  Kontext sinnlose Begriffe), zu lesbarem Standarddeutsch normalisieren (Schweizer „ss").
  **Nichts erfinden, Sinn nicht verändern, nicht über das Nötige hinaus glätten.**
- **Kontext nutzen:** Ein gemeinsames Glossar über alle Dateien sorgt für konsistente
  Schreibweisen von Namen/Orten/Begriffen.
- **Sprecher markieren:** meist zwei — **Interviewer** (stellt Fragen) und die befragte
  Person (mit Namen/Betrieb labeln, falls im Gespräch genannt, sonst „Befragte Person").
  Aufeinanderfolgende Segmente pro Sprecher zu Redebeiträgen bündeln.
- **Unsicheres offenlegen:** wirklich unklare Stellen nicht raten, sondern unter
  „## Anmerkungen" am Dateiende vermerken.

## KI-Anbieter (Einstellungsseite `/einstellungen`)
Die Korrektur hing fest am Claude-Code-Abo; jetzt wählt der Nutzer Anbieter + Modell im Browser.
- `webtool/settings.py` — JSON im Nutzerprofil (`%APPDATA%\Transkribor\settings.json`), **nicht im
  Repo**: ein Key hat in einem git-Verzeichnis nichts verloren. Frisch gelesen bei jedem Zugriff (wie
  die Env-Variablen) → ein Wechsel greift ohne Server-Neustart. `public()` liefert `has_key`/
  statt der Geheimnisse; die verlassen den Server nie, auch nicht über `GET /api/settings`.
- `webtool/llm.py` — Abo (`claude -p`) plus Anthropic-, OpenAI-, Google-, OpenRouter- und
  Custom-Endpoints (letzteres deckt Ollama/LM Studio/Groq/… ab). **Zwei HTTP-Dialekte reichen für
  alle**, darum `urllib` statt fünf SDKs — das hält auch den Auto-Installer klein. Modellliste kommt
  live vom Anbieter (`GET /models`), eine fest verdrahtete wäre in drei Monaten falsch.
- **Der Unterschied der beiden Welten ist, WER die Dateien anfasst:** `claude -p` liest und schreibt
  selbst (Read/Write-Tools), die API kennt keine Werkzeuge. Darum nimmt `correct._ask_llm(prompt,
  inputs, output)` Pfade — dieselben Prompts, zwei Zustellwege; im API-Weg landen die Eingaben im
  Prompt und `llm.complete_to_file` schreibt nur **gültiges** JSON (eine halbe `correction.json`
  würde der nächste Lauf als „fertig" durchwinken). Der `_claude_slots`-Deckel gilt für beide.
- **Kein stiller Rückfall aufs Abo**, wenn der Key fehlt: wer einen Anbieter einstellt, soll den
  Konfigurationsfehler sehen und nicht heimlich etwas anderes bekommen.
- Endpoints: `GET/PUT /api/settings`, `GET /api/settings/models`, `POST /api/settings/test`. Ein
  ausgelassenes `api_key` im PUT behält den gespeicherten Key (das Frontend kennt ihn nicht).

## Desktop-App (Electron)
`.\webtool.ps1` bleibt der Entwickler-Weg; für Nutzer gibt es einen Installer.
- `electron/main.js` — Fenster **zuerst** (die Ersteinrichtung dauert Minuten; wer auf nichts schaut,
  hält die App für kaputt), dann Umgebung prüfen → ggf. einrichten → uvicorn starten → App laden.
  `startLaeuft` ist der Riegel gegen den Doppelstart (`whenReady` prüft, und die Statusseite fragt
  beim Laden selbst nochmal — sonst laufen zwei uvicorn auf zwei Ports).
- `electron/backend.js` — das, was `webtool.ps1` tat, plus was ihm fehlte: freier Port statt fest
  8000, Warten auf „antwortet" (statt den Browser ins Leere zu schicken) und `taskkill /T` beim
  Beenden (sonst bleiben Whisper/claude als Waisen mit belegter GPU zurück).
- `electron/setup.js` — Erstinstallation: Python/ffmpeg via winget, venv, torch **cu128 zuerst**
  (`requirements.txt` enthält torch bewusst NICHT — mit `--extra-index-url` zöge pip sonst das
  CPU-Rad und die GPU wäre still weg), dann der Rest. Die venv gilt erst als fertig, wenn
  `import torch, whisper, fastapi, uvicorn` durchläuft — ein abgebrochener pip-Lauf sieht sonst
  „installiert" aus.
- `electron/paths.js` — **gepackt wird nie neben die .exe geschrieben** (Program Files ist
  schreibgeschützt und wird beim Update ersetzt): venv, `projekte/` und Einstellungen liegen in
  `userData`. Im Repo bleibt alles dort, wo `webtool.ps1` es erwartet.
- **Update-Zustand liegt in `electron/updater.js`**, nicht in `main.js`: der Automat bekommt
  den `autoUpdater` hineingereicht und ist damit ohne Electron testbar. `autoDownload` ist
  **aus** — sonst zöge das Prüfen sofort 100 MB, ungefragt. Die Oberfläche dazu steht in den
  Einstellungen (`useUpdate` + `SettingsPage`) und erscheint im reinen Browser gar nicht,
  weil `window.transkribor` dort fehlt.
- Bauen: `npm install && npm run dist` → `dist\Transkribor-Setup-<version>.exe` (~96 MB; die ML-Seite
  kommt beim ersten Start dazu, ein 5-GB-Setup bei jedem Update wäre unzumutbar).
  Release: Tag `v*` pushen → `.github/workflows/release.yml` baut und veröffentlicht,
  `electron-updater` zieht von dort. **Offen:** die Release-Assets müssen öffentlich sein (privates
  Repo braucht clientseitig ein Token), und der Installer ist unsigniert → SmartScreen-Warnung.
- `electron/setup.js` — `plan(platform, paketmanager)` entscheidet, was die Plattform braucht:
  Windows installiert Python/ffmpeg automatisch per winget, **macOS und Linux zeigen nur den
  Befehl zum Kopieren** (beides bräuchte sudo bzw. vorhandenes Homebrew — eine GUI-App, die
  dafür einen Passwort-Prompt öffnet, ist zu viel Magie). torch: cu128 auf Windows/Linux,
  PyPI-Standardrad auf macOS (bringt MPS mit; einen CUDA-Index gibt es dort nicht).
  Tests: `npm run test:electron` (`node --test`, keine Framework-Abhängigkeit).
- Build-Ziele: `nsis` (Windows), `dmg` arm64 (macOS), `AppImage`+`deb` (Linux).
- **`linux.depends` ist vollständig aufzuzählen, nicht zu ergänzen** — die Angabe *ersetzt*
  electron-builders Vorgabeliste. Dort fehlt `libasound2`: Electron braucht es, `apt` zieht es
  über keine der anderen Abhängigkeiten nach (mit `apt-get install --simulate` belegt), und ohne
  es stirbt der Start mit `error while loading shared libraries`. Auf Ubuntu 24.04 heisst das
  Paket `libasound2t64` und liefert `libasound2` per `Provides` — die Angabe passt also auf
  beide. `linux.synopsis` muss gesetzt sein, sonst bleibt die Kurzbeschreibung des deb leer und
  `apt search` zeigt nichts an (`description` füllt nur die Langfassung).
- **macOS-Signatur — `mac.identity: "-"` (ad-hoc) ist Pflicht, nicht Kosmetik.** Mit
  `CSC_IDENTITY_AUTO_DISCOVERY=false` liess electron-builder das Signieren ganz aus; da das
  Umpacken die von Electron mitgebrachte Signatur ohnehin zerstört, kam die App ohne gültige
  Signatur an und macOS meldete **„Transkribor ist beschädigt"** — mit *keinem* Weg, sie
  trotzdem zu öffnen (Rechtsklick > Öffnen hilft nur bei gültig signierten Apps). Ad-hoc
  signiert heisst: kein Zertifikat, aber gültig → Gatekeeper zeigt die normale
  „nicht verifiziert"-Meldung, die der Nutzer bestätigen kann. Dazu `hardenedRuntime: false`
  — Hardened Runtime + ad-hoc bräuchte sonst die Entitlement-Ausnahme
  `com.apple.security.cs.disable-library-validation`, und nötig ist er erst zur Notarisierung.
  Eine bereits geladene „beschädigte" App repariert man lokal mit
  `xattr -dr com.apple.quarantine <App>` + `codesign --force --deep --sign - <App>`.
  **Preis der ad-hoc-Lösung: Auto-Update ist auf macOS tot** — Squirrel.Mac verlangt eine
  echte Signatur, ad-hoc reicht laut Electron-Doku ausdrücklich nicht. `main.js` schreibt den
  Fehlschlag deshalb ins Protokoll, statt ihn zu verschlucken (sonst bliebe ein Mac still auf
  einer alten Version stehen). Mit Developer ID + Notarisierung läuft es ohne Codeänderung an.
- **DMG-Hintergrund erklärt die Gatekeeper-Warnung, bevor sie kommt.** Ankündigen kann die App
  sie nicht — vor dem erlaubten Start läuft kein Code von uns, das DMG-Fenster ist die einzige
  Fläche davor. `build/hintergrund.py` (PIL, Segoe UI) rendert `background.png` + `@2x`; die
  **PNG sind committet**, weil die CI-Runner weder PIL noch die Schriften haben. Die
  Symbolpositionen stehen doppelt — `dmg.contents` in `package.json` und `SYMBOL_*` im Skript
  (nur für den Pfeil) — die muss man **zusammen** ändern. Das Skript bricht ab, wenn eine
  Textzeile aus der Hinweiskarte läuft.

## Neues Projekt anlegen
`projekte\<NAME>\audio\` erstellen, Audio hineinlegen, optional `projekte\<NAME>\kontext.md`
mit Projektbeschreibung + bekannten Namen (verbessert Whisper und die Korrektur).

## GitHub-Management (Claude übernimmt das autonom)
Code-Änderungen landen ohne Rückfrage über den Standard-Flow — nicht direkt auf master:
Feature-Branch → Commit → `gh pr create --base master` → CI/Mergeability prüfen →
Rebase-Merge (`gh pr merge <#> --rebase --delete-branch`) → lokal `master` per Fast-Forward
nachziehen + verifizieren. Diese Regel ist die dauerhafte Freigabe für Push/PR/Merge auf das
(private) Remote. Vorher fragen nur bei: `projekte\`-Inhalten (Interviewdaten bleiben lokal,
nie committen), unklarem Scope, oder history-verändernden Aktionen (force-push, Reset).

## Umgebung (Fakten)
- venv: `.venv` (Python 3.13, torch cu128 + openai-whisper) — GPU: RTX 5080 / Blackwell (sm_120).
- ffmpeg: wird von `transcribe.py` automatisch gefunden (winget Gyan.FFmpeg) oder muss auf PATH sein.
  **Auf PATH steht es dabei nie:** winget legt für Gyan.FFmpeg *keinen* Link in `WinGet\Links`,
  also findet `where ffmpeg` es auch nach erfolgreicher Installation nicht. Wer ffmpeg sucht,
  muss zusätzlich `%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*\ffmpeg*\bin` abklopfen —
  `transcribe.ensure_ffmpeg()`, `diarize._ensure_ffmpeg()` und `setup.wingetFfmpeg()` tun das,
  bewusst je gespiegelt. Eine reine PATH-Prüfung meldet dauerhaft „fehlt", obwohl alles läuft.
- Whisper-Modell-Cache: `%USERPROFILE%\.cache\whisper` (einmaliger Download ~3 GB).
- Env-Overrides: `WHISPER_MODEL` (default large-v3), `WHISPER_LANG` (default de), `TRANSKRIBOR_VERIFY` (default 1; `0`/`false`/`no` schaltet den 2b-Treue-Pass server-weit ab), `TRANSKRIBOR_DIARIZE` (default 1; `0`/`false`/`no` schaltet die akustische Sprecher-Diarisierung server-weit ab — Erzeugung UND Konsumption), `TRANSKRIBOR_PARALLEL` (default 3; gleichzeitige `claude -p`-Aufrufe), `TRANSKRIBOR_AUTOCORRECT` (default 1; `0` stoppt die automatische Korrektur nach der Transkription), `TRANSKRIBOR_SETTINGS` (Pfad der Einstellungsdatei; **Tests müssen das setzen**, sonst entscheidet die echte Datei des Entwicklers über den KI-Anbieter), `TRANSKRIBOR_PROJEKTE` (Wurzel der Projektordner; `electron/backend.js` setzt sie auf `userData/projekte` — **jeder** Zugriff auf Projektpfade muss sie lesen, sonst sucht der gepackte Lauf neben dem Code und findet nichts).
- **Gerätewahl liegt in `webtool/device.py`** (`pick()` → cuda | mps | cpu), genutzt von
  `transcribe.py` und `webtool/diarize.py`. Upstream-Whisper kennt **kein MPS** — es wählt nur
  `cuda if torch.cuda.is_available() else cpu`. Scheitert MPS mitten in der Transkription,
  lädt `transcribe.py` das Modell **einmal** auf CPU neu und schreibt das ins Log;
  `PYTORCH_ENABLE_MPS_FALLBACK=1` setzen wir bewusst NICHT (schöbe einzelne Ops still auf die
  CPU, während die Anzeige weiter „mps" behauptet).
- **Whisper-Stufe und -Sprache stehen in den Einstellungen** (`whisper_model`, `whisper_lang`)
  und reisen über `settings.job_env()` → `jobs.py` → `transcribe.py`. Eine echte
  Umgebungsvariable `WHISPER_MODEL`/`WHISPER_LANG` gewinnt. Default bleibt
  `large-v3`/`de`. Auswahl im Browser: tiny / small / medium / turbo / large-v3.
- **ffmpeg auf macOS:** GUI-Apps erben dort ein anderes `PATH` als die Shell — per `brew`
  installiertes ffmpeg liegt unter `/opt/homebrew/bin` und ist für die App sonst unsichtbar
  (`POSIX_FFMPEG_DIRS` in `transcribe.py`).
- **`llm.available()`** prüft, ob überhaupt korrigiert werden kann (claude auf dem PATH bzw.
  Key + Modell). Die Auto-Korrektur startet ohne nutzbaren Anbieter **gar nicht**, statt einen
  Job zu starten, der scheitert; `GET /api/settings` liefert `ai_ready`/`ai_reason` fürs
  Frontend. Geprüft wird die Fähigkeit, nicht die Einstellung — das erspart eine Migration.
- **`GET /api/hardware`** meldet das aktive Rechenwerk (einmal pro Serverlauf ermittelt).
- Stufe 3 (Sprecher-Diarisierung): `webtool/diarize.py` (pyannote.audio 4.0.7, Modell `speaker-diarization-community-1`, GPU) läuft als **Prep-Schritt im `correct run`** (vor `prep`, auf den Lauf gescopt), schreibt best-effort `<base>.diar.json` (Turns + `{id, "Sprecher N"}` je Segment, idempotent). `cmd_prep` webt das `(Sprecher N)`-Präfix in `<base>.tagged.txt`; der Korrektur-Prompt lässt Claude pro akustischem Cluster einen konsistenten Namen vergeben (**Hybrid**: Akustik trennt *wer wann*, LLM benennt *wie*). Fehlt pyannote oder scheitert die GPU → kein Sidecar → Korrektur wie bisher (reines Text-Raten, keine Regression). **Windows-Gotcha:** pyannotes torchcodec-File-Decoding lädt nicht (`libtorchcodec_core*.dll`) → Audio wird in-memory via `whisper.load_audio` (ffmpeg, 16 kHz mono) geladen und als `{waveform, sample_rate}`-Dict übergeben. `jobs.py` serialisiert `transcribe`+`correct` auf der einen GPU. **Kein Einmal-Setup mehr** — siehe nächster Punkt.
- **Das Diarisierungsmodell liegt im Repo (`models/speaker-diarization-community-1/`, 31 MB)** und
  reist über `extraResources` in den Installer; `diarize.DIAR_MODEL` zeigt auf dessen `config.yaml`
  (relativ zu `webtool/`, gilt im Repo wie unter `resources/py`). **`HF_TOKEN` gibt es nicht mehr** —
  weder Env, noch Einstellung, noch Feld im Browser. Grund: das HF-Gate ist ein Kontaktformular,
  keine Lizenzschranke (**CC-BY-4.0**, Weitergabe erlaubt), kostete den Nutzer aber Konto + Token +
  Häkchen — der einzige Einrichtungsschritt, den kein Klick lösen konnte, und bei fehlendem Token
  fiel die Sprechertrennung **still** aus. Möglich ist das, weil die `config.yaml` ihre Gewichte als
  `$model/…` referenziert und `$model` ihr **eigenes Verzeichnis** ist → der Ordner ist unverändert
  verschiebbar (der `os.chdir`-Trick aus den pyannote-Tutorials gilt der alten 3.1-config, hier
  **nicht** nachbauen). CC-BY verlangt Namensnennung: `LICENSE-MODELLE.md` (liegt dem Paket bei) plus
  eine Zeile auf der Einstellungsseite. `test_diarize.py` prüft beides ab, was ein Verpackungsfehler
  brechen würde: dass die Gewichte da sind und dass `from_pretrained` einen **Pfad** bekommt (eine
  Repo-ID schleppte Hugging Face samt Token wieder ein).
- Web-Editor (Stufe 1): React 19 + Vite + TypeScript + Tailwind v4 + shadcn/ui in
  `webtool/frontend/`, gebaut nach `webtool/static/` (git-ignoriert, Build-Output) und von
  FastAPI (`webtool/app.py`) via **SPA-Catch-all** (`GET /{full_path}` → existierende statische
  Datei mit realpath-Guard, sonst `index.html`; unbekannte `/api/...` → 404) ausgeliefert —
  nötig, damit BrowserRouter-Deep-Links (`/p/…`) nach einem Reload laden. `.\webtool.ps1` baut
  das Frontend bei fehlendem `webtool\static\index.html` automatisch (`npm install` + `run
  build`), lädt eine optionale git-ignorierte `.env` (KEY=VALUE, z.B. `TRANSKRIBOR_DIARIZE` — Vorlage
  `.env.example`), startet dann uvicorn (:8000) und öffnet den Browser. Frontend-Entwicklung mit
  Hot-Reload: `npm --prefix webtool/frontend run dev` (Vite :5173, proxied `/api` zu :8000).
  Kanonisches Editier-Dokument bleibt `<base>.edit.json` (aus Roh-`<base>.json`), Export
  `<base>.md`. Spec: `docs/superpowers/specs/2026-07-06-transkribor-webtool-design.md`.
  **Router-basiert** (`react-router-dom`): `/` Projekt-Galerie (Projekt anlegen via
  `POST /api/projects`, löschen via `DELETE /api/projects/{p}` hinter einer
  Namen-eintippen-Bestätigung), `/p/:project` Arbeitsfläche (Drag&Drop-Multi-Upload,
  Transkribieren/Korrigieren, Live-Status pro Datei), `/p/:project/:base` Editor.
  **Live-Pipeline-Status:** pro Datei die aktuelle Phase (Diarisieren → Korrigieren →
  Verifizieren → Anwenden → Fertig / Übersprungen / Fehler), rein aus den Job-stdout-Zeilen
  geparst (`webtool/frontend/src/lib/jobPhases.ts`, Einzel-Cursor-Scan; kein neuer Backend-Job-
  State). Reload-robust, weil `GET /api/projects` je Projekt `active_job:{id,kind}` liefert
  (`jobs.active_for`) und das Frontend den laufenden Job über einen `JobProvider` wiederfindet.
  Spec/Plan: `docs/superpowers/specs/2026-07-10-transkribor-projekt-workspace-status-design.md`.
- Stufe 2a (Browser-Transkription): `POST /audio` (Upload), `POST /transcribe` (startet `transcribe.py` via `webtool/jobs.py`-Job), `GET /api/jobs/{id}` (Polling), `POST /api/jobs/{id}/cancel` (bricht den Job samt Prozessbaum ab → Status `cancelled`; auf Windows via `taskkill /F /T`, weil `terminate()` den `claude`+MCP-Subtree verwaisen liesse). Job-Registry ist in-memory (threading+Popen) — kein `--reload` während Jobs.
- **Job-Modell:** Dedupe je **(Projekt, Art)**, nicht je Projekt — Transkription und Korrektur eines Projekts laufen **nebeneinander**. `GPU_KINDS = ("transcribe",)`: nur Whisper wird global serialisiert; `correct` hängt an Opus und braucht die GPU nur für den kurzen pyannote-Schritt, es dort mitzuführen hiesse, dass eine 25-Minuten-Korrektur jede Transkription blockiert. `jobs.active_for(project)` liefert deshalb eine **Liste**, `GET /api/projects` gibt `active_jobs: [{id,kind}]`, und der `JobProvider` verfolgt mehrere Jobs und mergt ihre Phasen (`mergePhases`; ein laufender Job verdrängt den Terminal-Status derselben Datei aus einem anderen Job).
- **Auto-Trigger — Hochladen IST der Startschuss:** `POST /api/projects/{p}/audio` startet die Transkription selbst und gibt die Job-ID zurück (der Workspace adoptiert sie sofort, statt bis zum nächsten Poll zu warten); danach läuft über `then=` die Korrektur an. Kern ist **`jobs.request()`**: startet den Job **oder merkt genau EINEN Nachlauf vor** — fünf Uploads während eines laufenden Laufs reihen so nicht fünf Whisper-Läufe auf, einer sieht ohnehin alle inzwischen dazugekommenen Dateien. `transcribe.py` lädt das 3-GB-Modell nicht mehr, wenn nichts offen ist (Leerlauf-Runden sind seitdem Alltag und kosteten je ~30s). Abschaltbar bleibt nur die Korrektur (`TRANSKRIBOR_AUTOCORRECT=0`).
- **URL-Import ist eine eigene Job-Art `fetch`** (nicht mehr `transcribe`): der Download braucht keine GPU und wurde als GPU-Art von jeder laufenden Transkription blockiert — und die läuft seit dem Auto-Trigger ständig. `python -m webtool.fetch --download-only` lädt nur, `then=` übergibt an den normalen Transkriptions-Job; der direkte CLI-Aufruf transkribiert weiterhin selbst. `jobPhases.ts` behandelt `fetch` wie `transcribe` (gleicher Zeilen-Dialekt), `KIND_LABEL` liefert den Fallback-Text.
- **Live-Status ohne Reload:** `useProjects` pollt `/api/projects` (Default 4s, ersetzt das alte Intervall in `HomeGallery`). Nötig, seit Jobs auch ohne Klick starten — sonst sähe ein offener Tab weder die neue Datei noch den fremd gestarteten Job. Kein `setLoading` beim Poll (sonst flackert die Liste), und ein Poll-Fehler behält die letzte bekannte Liste.
- Stufe 2b (Browser-Korrektur): `POST /api/projects/{project}/correct` startet `python -m webtool.correct run <NAME>` als `jobs.py`-Job (kind `correct`; Dedupe je `(Projekt, "correct")` — läuft also parallel zu einer Transkription desselben Projekts). Der `run`-Driver macht `prep` → ein `claude -p` für ein gemeinsames `_glossar.json` → pro Datei ein `claude -p` (Korrektur, schreibt `<base>.correction.json`) → per Default ein zweiter `claude -p` (**Treue-Verifikation** gegen das ID-getaggte `<base>.tagged.txt`, überschreibt `correction.json` mit der geprüften Fassung; ein ungültig schreibender Verify wird auf die gültige Erst-Korrektur zurückgerollt) → `apply`. Aufruf: `claude -p "<prompt>" --model opus --permission-mode acceptEdits --allowedTools Read,Write --strict-mcp-config --mcp-config '{"mcpServers":{}}' --add-dir <projekte_root>`, `cwd`=Repo-Root (lädt diese CLAUDE.md). **Kein MCP-Server:** halbiert den Startup (16,3s → 7,7s gemessen) und hält die persönlichen Server aus einem Lauf raus, der nicht vertrauenswürdigen Transkripttext verarbeitet.
  **Parallelität:** Dateien laufen nach dem Glossar parallel, Blöcke einer Datei ebenfalls — aber **Block 1 läuft allein vor**, weil aus ihm die Cluster→Name-Zuordnung kommt, an der sich alle weiteren Blöcke orientieren (`known=_speaker_hint(...)`; sonst tauft jeder Block denselben Menschen anders). Der Deckel sitzt als `threading.Semaphore` in `_run_claude` und **nicht** in den Executors — sonst wären Datei- und Block-Parallelität multiplikativ. Default 3, via `TRANSKRIBOR_PARALLEL`. **Folge fürs Log:** die stdout-Zeilen verschränken sich, deshalb trägt **jede** Fortschrittszeile ihren Basisnamen (`→ Korrigiere <base> · Block i/n …`, `✓ <base> · Block i/n fertig`) — Vertrag mit `jobPhases.ts`, das `active` als `Record<base, …>` führt. **Erfolg = geschriebene `correction.json` existiert+parst+hat `segments`** (nicht Exitcode); fehlt sie → Datei überspringen, Rest weiterlaufen. Idempotent: `human_edited=true` oder vorhandene `correction.json` → SKIP. Ein via Cancel abgebrochener Lauf ist damit **resumbar**: schon fertig geschriebene `correction.json` bleiben stehen, ein Re-Run überspringt sie und holt nur fehlende/mid-write-kaputte (parsen nicht → gelten als „nicht vorhanden") nach; `apply` läuft beim erneuten Lauf. Der Treue-Pass ist Default-an, abschaltbar via `--no-verify` bzw. `TRANSKRIBOR_VERIFY=0` (kein Browser-Toggle — die Env greift server-weit über den uvicorn-Prozess). Verdoppelt die Opus-Aufrufe pro Datei; Cancel bricht Ausreißer ab. Kein API-Key (Claude-Code-Abo). Der Workflow `tools/correct_label.mjs` (Schritt 2 unten) bleibt die Alternative (Parallelität + In-Memory-Schema-Validierung der Agent-Ausgaben).
- URL-Import (YouTube/Instagram): `webtool/fetch.py` (yt-dlp) lädt die Tonspur als `.m4a`
  nach `projekte\<NAME>\audio\` und transkribiert anschliessend **nur** diese Dateien
  (`transcribe.find_audio(..., only=[...])`). Start im Web-Tool über das Feld „Video-URLs"
  (mehrere URLs, eine pro Zeile) oder per CLI:
  `python -m webtool.fetch "<NAME>" <url> [<url> ...]` (cwd = Repo-Root).
  Endpoint: `POST /api/projects/{p}/fetch` `{urls:[...]}` → Job mit `kind="transcribe"`
  (teilt sich damit GPU-Serialisierung und Ein-Job-pro-Projekt-Dedupe). Nur `https` und nur
  YouTube/Instagram (Whitelist in `webtool/fetch.py:ALLOWED_HOSTS`); Login-pflichtige
  Inhalte werden bewusst nicht unterstützt. **Einmal-Setup:** `.venv\Scripts\python.exe -m
  pip install yt-dlp`. **Gotcha:** Instagram-Extraktoren brechen häufig — `pip install -U
  yt-dlp` ist der übliche Fix.
