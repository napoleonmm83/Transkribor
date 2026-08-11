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
- **Musik/Gesang → `[Musik]`, ASR-Artefakte → leerer Text.** Über Gesungenem erfindet Whisper
  *selbstbewussten* Unsinn, und genau daran scheitert jeder Zahlenfilter: an einem Open-Air-
  Mitschnitt (198 Segmente) stand „Find the Strub!" sechsmal in Folge bei
  `compression_ratio` 1,80 und `avg_logprob` −0,34 — **0 von 198** Segmenten überschritten
  *irgendeine* der beiden Schwellen aus `compute_flags`. Die LLM-Korrektur erkennt es dagegen
  ungefragt (sie vergab von sich aus den Sprecher „Bühnenstimme" und schrieb „scheinen Liedtext
  zu enthalten" in die Anmerkungen) — darum liegt die Erkennung im Prompt, nicht in einer
  Heuristik. **Die Regel muss in BEIDEN Prompts stehen:** der Treue-Pass prüft auf
  „Inhalt weggelassen" und drehte `[Musik]` sonst als Untreue zurück.
- **Ein leerer `text` in der `correction.json` ist eine Entscheidung, kein fehlender Wert.**
  `apply_correction` hatte dort ein `if text:` — womit jede Streichung verfiel: die Korrektur
  leerte vier Segmente mit „ARD Text im Auftrag von Funk" (eine Untertitel-Floskel aus Whispers
  Trainingsdaten, im Ton nicht vorhanden), und alle vier standen danach trotzdem im Export.
  Unterschieden wird jetzt am **Schlüssel**: `"text": ""` streicht, ein Eintrag *ohne*
  `text`-Schlüssel lässt den Rohtext stehen. Der Rohtext bleibt in `raw_text` ohnehin erhalten.
- **`--force` muss bis in den Block-Cache durchgereicht werden.** Es galt nur der
  zusammengeführten `correction.json`; liegengebliebene `<base>.partN.correction.json` wurden
  weiter nach Existenz + Zeitstempel wiederverwendet. Ein Lauf nach einer **Prompt-Änderung**
  übernahm damit still Blöcke nach der alten Regel — genau so landete die Musik-Markierung beim
  ersten Test nur in Block 1 von 2. Die Kehrseite bleibt bestehen und ist getestet: **ohne**
  `--force` sind die Teil-Dateien weiterhin der Resume-Anker eines abgebrochenen Laufs.

## KI-Anbieter (Einstellungsseite `/einstellungen`)
Die Korrektur hing fest am Claude-Code-Abo; jetzt wählt der Nutzer Anbieter + Modell im Browser.
- `webtool/settings.py` — JSON im Nutzerprofil (`%APPDATA%\Transkribor\settings.json`), **nicht im
  Repo**: ein Key hat in einem git-Verzeichnis nichts verloren. Frisch gelesen bei jedem Zugriff (wie
  die Env-Variablen) → ein Wechsel greift ohne Server-Neustart. `public()` liefert `has_key`/
  statt der Geheimnisse; die verlassen den Server nie, auch nicht über `GET /api/settings`.
- `webtool/llm.py` — **zwei Abos** (Claude Code via `claude -p`, ChatGPT via `codex exec`) plus
  Anthropic-, OpenAI-, Google-, OpenRouter- und Custom-Endpoints (letzteres deckt
  Ollama/LM Studio/Groq/… ab). **Zwei HTTP-Dialekte reichen für alle**, darum `urllib` statt fünf
  SDKs — das hält auch den Auto-Installer klein. Modellliste kommt live vom Anbieter
  (`GET /models`), eine fest verdrahtete wäre in drei Monaten falsch.
- **Bei den Abo-CLIs gibt es keine Liste zu holen** — weder `claude` noch `codex` kennt einen
  Befehl, der Modelle auflistet, und die Fehlermeldung eines ungültigen Modells zählt auch keine
  auf (beides geprüft). Dort stehen **Aliase** in `PROVIDERS`: `opus`/`sonnet`/`haiku`/`fable`
  zeigen immer auf die neueste Generation, weil Anthropic den Zeiger umbiegt — der Grund gegen
  eine feste Liste (in drei Monaten falsch) trifft sie also nicht. **Leeres Modell heisst „nimm
  deine eigene Voreinstellung"**, darum ist es bei CLIs kein Pflichtfeld. `list_models()`
  beantwortet beide Fälle über denselben Endpoint, damit das Frontend nicht zwei Wege kennt.
- **Die Gemini-CLI fehlt absichtlich als Abo:** ihr Zugang ist für Einzelpersonen abgeschaltet
  (`IneligibleTierError`, gemessen — auch mit `GEMINI_CLI_TRUST_WORKSPACE`). Als API-Anbieter mit
  eigenem Key bleibt Gemini unverändert nutzbar. Nebenbefund für den Fall einer Rückkehr:
  `--approval-mode plan` wird in einem nicht vertrauten Ordner **still** auf `default`
  herabgestuft — der Lesemodus wäre dort also nachzuprüfen, nicht anzunehmen.
- **Der Unterschied der beiden Welten ist, WER die Dateien anfasst** — nicht Abo gegen Key:
  `claude -p` liest und schreibt selbst (Read/Write-Tools), **alle anderen** (API *und* Codex)
  kennen keine Werkzeuge. Darum nimmt `correct._ask_llm(prompt, inputs, output)` Pfade —
  dieselben Prompts, zwei Zustellwege; im werkzeuglosen Weg landen die Eingaben im Prompt
  (`_with_files`) und `llm.complete_to_file` schreibt nur **gültiges** JSON (eine halbe
  `correction.json` würde der nächste Lauf als „fertig" durchwinken). `llm.use_api()` beantwortet
  genau diese Frage, der `_claude_slots`-Deckel gilt für alle.
- **`codex exec` läuft zwingend mit `--sandbox read-only`.** Im Prompt steht Transkripttext, der
  aus einem URL-Import stammen kann — eine Injektion darf höchstens Unsinn *antworten*, niemals
  Dateien anfassen. Werkzeuge braucht der Weg ohnehin nicht. Die Antwort kommt über
  **`-o <datei>`**, nicht aus der Konsolenausgabe: `codex exec` druckt seinen Sitzungsverlauf mit,
  und darin steht der **Prompt im Klartext** — `parse_json` (erste `{` bis letzte `}`) griffe quer
  durch dieses Echo. Erfolg wird an der Antwortdatei gemessen, nicht am Exitcode: ein
  gescheiterter Login endet mit 0.
- **Das Modell für `claude -p` kommt aus den Einstellungen** (`correct.py`, Rückfall `opus`).
  Vorher war es eine Konstante — wer sein Opus-Kontingent aufgebraucht hatte, konnte nicht auf
  `sonnet` ausweichen.
- **Kein stiller Rückfall aufs Abo**, wenn der Key fehlt: wer einen Anbieter einstellt, soll den
  Konfigurationsfehler sehen und nicht heimlich etwas anderes bekommen.
- Endpoints: `GET/PUT /api/settings`, `GET /api/settings/models`, `POST /api/settings/test`. Ein
  ausgelassenes `api_key` im PUT behält den gespeicherten Key (das Frontend kennt ihn nicht).

## Anmeldung an den Abo-CLIs (`webtool/auth.py`)
Beide Abos melden sich im Browser an; die App fragt den Zustand ab und fährt den Vorgang.
- **Installiert ≠ angemeldet.** `available()` prüfte nur den PATH, meldete grün, und die
  Auto-Korrektur startete einen Lauf, der am Login scheiterte. Jetzt fragt sie zusätzlich
  `auth.status()` — das kostet **0,09 s (codex) bzw. 0,26 s (claude)**, gemessen, gegen einen
  abgebrochenen Korrekturlauf von Minuten. `check()` fragt zuerst `available()`: sonst legt der
  Testknopf bei abgemeldetem Codex ein rohes `401 … Missing bearer … cf-ray: …` vor — richtig,
  aber unbrauchbar, weil die einzige sinnvolle Reaktion („anmelden") nicht darin steht.
- **Zwei Richtungen, eine Oberfläche:** `claude auth login --claudeai` druckt eine URL und
  **wartet auf einen Code** über stdin (`redirect_uri` zeigt auf platform.claude.com — es gibt
  keinen lokalen Callback zum Abfangen). `codex login --device-auth` druckt URL **und** Code,
  eingegeben wird beides im Browser, die CLI pollt selbst. Darum hängt das Eingabefeld an
  `braucht_code`, nicht am Anbieternamen.
- **Eigenes Modul statt `jobs.py`**, zwei gemessene Gründe: der Login braucht **stdin** (allen
  Jobs eine nie beschriebene Pipe zu geben, wäre eine Verhaltensänderung für Transkription und
  Korrektur), und `jobs.py` liest **zeilenweise** — `Paste code here if prompted > ` kommt ohne
  Zeilenumbruch und läge dort im Puffer. `auth.py` liest deshalb zeichenweise.
- **ANSI-Codes müssen raus, bevor irgendetwas in der Ausgabe gesucht wird.** Codex schreibt
  `\x1b[94mhttps://…\x1b[0m` und `\x1b[94mIUO4-YVUNH\x1b[0m`. Ungefiltert frisst die URL-Regex
  das `\x1b[0m` mit (kaputter Link), und die Wortgrenze vor dem Code scheitert am `m` aus
  `[94m` — zwischen zwei Wortzeichen gibt es keine. Der Code blieb unsichtbar, und der
  Geräte-Flow konnte nie fertig werden.
- **Erfolg misst `status()`, nicht der Exitcode** — dieselbe Regel wie bei `_run_claude` (Datei)
  und `_run_codex` (Antwortdatei): ein abgebrochener Browser-Flow endet auch mit 0.
- **Der Vorgang ist auf den eingestellten Anbieter gefiltert** (`zustand(provider)`), und das
  Frontend baut den Block per `key={s.provider}` neu auf. **Beides ist nötig:** wer während
  einer Codex-Anmeldung auf das Claude-Abo umstellte, sah sonst die Codex-URL unter der
  Claude-Überschrift. Ein Wechsel beendet den gegenstandslosen Vorgang samt Prozessbaum; ein
  Doppelklick auf denselben Anbieter dagegen **nicht** — sonst stirbt der Versuch, in dessen
  Browser-Tab gerade jemand tippt.
- **Das Modellfeld braucht `key={provider|model}`.** Es ist unkontrolliert (`defaultValue` +
  Speichern bei `onBlur`); ohne den Schlüssel behielt es beim Anbieterwechsel den alten Wert und
  schrieb ihn beim nächsten Klick **zurück** — `opus` landete so als Codex-Modell in der
  Einstellungsdatei, woran `codex exec -m opus` scheitert.
- Endpoints: `GET /api/settings/auth`, `POST|GET /api/settings/auth/login`,
  `POST /api/settings/auth/login/code`, `POST /api/settings/auth/login/cancel`.
- Tests laufen gegen eine **nachgebaute CLI**, nie gegen `claude`/`codex`: ein echter
  Login-Aufruf griffe in die Anmeldung des Entwicklers ein. Der Preis dafür ist real — die
  ANSI-Falle und der Anbieterwechsel fielen erst im Browser auf, weil das Skript sauberen Text
  druckte. Wer hier etwas ändert, sieht sich die **Rohausgabe** der echten CLI an.

## App-Hülle (Fensterraster, Seitenleiste, Titelzeile, OS-Integration)
Vorher brachte nur der Editor ein Vollbild-Raster mit, die drei anderen Seiten waren zentrierte
Lesespalten — bei 1280 px Fenster blieben rund 500 px leer, und das liest das Auge als Artikel im
Fensterrahmen. Vier Dinge, die man nicht aus dem Diff liest:
- **`h-screen` gibt es genau EINMAL**, in `components/AppShell.tsx`. `AppShell` ist der
  Datenprovider, `Rahmen` das Raster (Titelzeile / [Leiste | Inhalt] / Statuszeile). Jede Seite
  füllt ihre Zelle; wer irgendwo ein zweites `h-screen` setzt, hat die zweite Stelle, an der das
  Fenster aufgeteilt wird — genau den Zustand, den dieser Umbau abgeschafft hat.
- **`window.transkribor` ist die Weiche zwischen App- und Browser-Betrieb**, nicht der Plattform.
  Dieselbe Oberfläche läuft unter `webtool.ps1` (:8000) und Vite (:5173); dort fehlt die Brücke,
  und jede Electron-Funktion muss ein **No-Op** sein statt zu werfen. Das ist der Betriebsmodus,
  den beim Entwickeln niemand öffnet — eine Regression dort fällt erst spät auf. `TitleBar`
  rendert deshalb `null`, `fortschritt` wird übersprungen, `titelleisteFarbe` verpufft.
- **Die Fensterknöpfe malt das Betriebssystem, nicht wir** (`electron/fenster.js`:
  `titleBarStyle:'hidden'` + `titleBarOverlay` auf Windows/Linux, `hiddenInset` auf macOS). Das
  war der Grund, die rahmenlose Variante überhaupt zu wagen: selbst gezeichnete Knöpfe wären das
  Stück, das auf jeder Plattform anders bricht — und macOS/Linux sind ungeprüft (Issue #36).
  `fensterOptionen(platform, dunkel)` ist eine **reine Funktion** (Muster wie `setup.plan`), weil
  sie das Einzige daran ist, was sich ohne die fremde Hardware prüfen lässt. `TITELLEISTE_HOEHE`
  (40) hat ein Gegenstück im `h-10` der `TitleBar` — zwei Zahlen in zwei Laufzeiten, beide Seiten
  tragen einen Kommentar auf die andere.
- **`onSettled` meldet Übergänge, keine Zustände** (`hooks/useActiveJob.tsx`). Der Rückruf trägt
  `beendet: Job[]` — nur die Jobs, die in **diesem** Tick terminal wurden. Ein Zuhörer, der
  stattdessen `jobs` aus seinem Render-Closure liest, sieht dort veralteten Stand (wir rufen
  synchron nach `setJobs`), und wer das mit einer Zeitschaltung umgeht, verlässt sich auf Reacts
  Batching-Zeitpunkt statt auf Daten. Der `zuletzt`-Stand je Kennung ist **nicht** überflüssig:
  `ids` friert beim Effekt-Aufsatz ein, und holt die Effekt-Bereinigung den geplanten
  `setTimeout` nicht ein, feuert die alte Tick-Closure erneut. Diese Race lässt sich in keinem
  Test erzwingen — die Begründung ist das Argument, nicht ein roter Lauf.
- **Ein Abruf, egal wie viele Leser:** `hooks/useProjektDaten.tsx` hält Projektliste und
  Dateiliste für die ganze App (`useProjekte`, `useDateien`). Vorher rief jede Seite `useProjects`
  selbst; mit der dauerhaften Seitenleiste wären es zwei parallele Polls geworden — also genau
  die Last, die PR #67 gemessen abgebaut hat. Das aufgeklappte Projekt der Leiste **ist** das aus
  der URL; ein zweiter Begriff von „offen" wäre eine zweite Wahrheit.
- **Die Projektliste sortiert das Frontend, nicht das Backend** (`list_projects` liefert
  `os.scandir`-Reihenfolge). Beim Umzug der Liste in die Leiste ging diese Sortierung einmal
  still verloren — wer die Liste anfasst, prüft die Reihenfolge mit.

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
  `import torch, faster_whisper, fastapi, uvicorn` durchläuft — ein abgebrochener pip-Lauf sieht sonst
  „installiert" aus.
- `electron/paths.js` — **gepackt wird nie neben die .exe geschrieben** (Program Files ist
  schreibgeschützt und wird beim Update ersetzt): venv, `projekte/` und Einstellungen liegen in
  `userData`. Im Repo bleibt alles dort, wo `webtool.ps1` es erwartet.
- **Update-Zustand liegt in `electron/updater.js`**, nicht in `main.js`: der Automat bekommt
  den `autoUpdater` hineingereicht und ist damit ohne Electron testbar. `autoDownload` ist
  **aus** — sonst zöge das Prüfen sofort 100 MB, ungefragt. Die Oberfläche dazu steht in den
  Einstellungen (`useUpdate` + `SettingsPage`) und erscheint im reinen Browser gar nicht,
  weil `window.transkribor` dort fehlt.
- **Geprüft wird beim Start UND alle 6 h** (`main.js`, `setInterval` + `unref()`). Der Start
  allein reichte nicht: eine App, die tagelang offen bleibt — bei langen Transkriptionen der
  Normalfall — erfuhr von einer neuen Fassung erst beim nächsten Start. Zwei Riegel hängen
  davor, beide gegen eine **falsche Anzeige**, nicht gegen Last (eine Runde ist ein GET auf
  `latest.yml`, ~1 KB): `net.isOnline()` — offline erzeugte sonst alle 6 h „Prüfung
  fehlgeschlagen" in der Fusszeile plus eine Zeile im Protokoll, ungefragt — und
  `updater.sollPruefen(stand)`, das nur aus `unbekannt`/`aktuell`/`fehler` heraus erneut sucht.
  Das ist eine **Weissliste**: ein gefundenes Update (`verfuegbar`/`laedt`/`bereit`) würde vom
  nächsten Tick sonst aus der Fusszeile geschoben, und eine später dazukommende Zustandsart
  gilt im Zweifel als „nichts zu tun".
- Bauen: `npm install && npm run dist` → `dist\Transkribor-Setup-<version>.exe` (~96 MB; die ML-Seite
  kommt beim ersten Start dazu, ein 5-GB-Setup bei jedem Update wäre unzumutbar).
  Release: Tag `v*` pushen → `.github/workflows/release.yml` baut und veröffentlicht,
  `electron-updater` zieht von dort. **Offen:** die Release-Assets müssen öffentlich sein (privates
  Repo braucht clientseitig ein Token), und der Installer ist unsigniert → SmartScreen-Warnung.
- **Releases, die keine App sind, MÜSSEN `--prerelease` tragen** (`modelle-v1` mit den
  GGML-Dateien ist das einzige bisher). `electron-updater` fragt `/releases/latest`, und GitHub
  beantwortet das mit dem **zuletzt veröffentlichten** Nicht-Prerelease — nicht mit der höchsten
  Version. `modelle-v1` erschien nach `v0.5.0` und wurde damit „Latest"; jeder Update-Check
  starb daraufhin an `404 … modelle-v1/latest.yml`, obwohl an der App nichts falsch war.
  Prereleases nimmt GitHub von „Latest" aus, die Asset-URLs bleiben unverändert — der
  GGML-Download merkt nichts davon. Ein `v*`-Release darf den Riegel nicht tragen: es SOLL
  „Latest" werden.
- `electron/setup.js` — `plan(platform, paketmanager, arch, brew)` entscheidet, was die
  Plattform braucht: Windows per winget, **macOS per `brew install`, sobald Homebrew da ist**,
  **Linux zeigt nur den Befehl** (`apt`/`dnf`/`pacman` brauchen echtes sudo). Die frühere
  Begründung „macOS bräuchte sudo" **vermischte zwei Fälle**: Homebrew *selbst* zu
  installieren legt `/opt/homebrew` an und fragt nach dem Kennwort — `brew install <paket>`
  danach nicht, der Ordner gehört dem Nutzer. Fehlt Homebrew, nennt der Hinweis jetzt den
  **brew.sh-Einzeiler**; vorher stand dort ein `brew install …`, das ohne brew mit „command
  not found" endet — ein Rat, der genau dem nicht hilft, der ihn braucht. `whisper-cpp` wird
  auf Apple Silicon **mitinstalliert** (Fehlschlag bricht nicht ab: langsam ist besser als
  gar nicht). torch: cu128 auf Windows/Linux, PyPI-Standardrad auf macOS (bringt MPS mit;
  einen CUDA-Index gibt es dort nicht).
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
  Fläche davor. `build/marke.py` rendert ihn (PIL, Brand-Schriften aus `build/fonts`) zusammen
  mit dem App-Icon und den beiden NSIS-Bildern; die **Ausgaben sind committet**, weil die
  CI-Runner weder PIL noch die Schriften haben. Die Symbolpositionen stehen doppelt —
  `dmg.contents` in `package.json` und `SYMBOL_*` im Skript (nur für den Pfeil) — die muss man
  **zusammen** ändern. Das Skript bricht ab, wenn eine Textzeile aus der Hinweiskarte läuft.
  Geprüft wird nicht der Renderer, sondern die fertige Datei: `build/test_bilder.py` liest die
  Kopfdaten mit `struct` und kommt **ohne PIL** aus — sonst liefe der Test im CI-Python-Job nicht,
  der bewusst ohne schwere Abhängigkeiten fährt.

## Neues Projekt anlegen
`projekte\<NAME>\audio\` erstellen, Audio hineinlegen, optional `projekte\<NAME>\kontext.md`
mit Projektbeschreibung + bekannten Namen (verbessert Whisper und die Korrektur).

## Die README wird mitgepflegt — automatisch, ohne Rückfrage
**Ändert sich, was der Nutzer sieht oder tun kann, wird die README im selben PR nachgezogen.**
Nicht als Nachtrag „irgendwann", nicht auf Zuruf. Der Grund: CLAUDE.md wächst bei jeder
Arbeit von selbst mit (sie ist die Arbeitsanleitung), die README nicht — sie war nach fünf
Funktionen bereits veraltet, und sie ist das Einzige, was ein neuer Nutzer je liest.

**Nachzuziehen ist**, was jemand ohne Quellcode merkt: eine neue Funktion, eine geänderte
Bedienung, andere Voraussetzungen, ein weggefallener Schritt. **Nicht** nachzuziehen: interne
Umbauten, Testarbeit, Abhängigkeits-Updates — dort ändert sich für den Nutzer nichts.

**Der Ton ist der einer Anleitung, nicht eines Changelogs.** Die README richtet sich an
Menschen ohne technischen Hintergrund: **was es ihnen bringt**, in ihren Worten, unter dem
passenden Abschnitt — nicht „neu in 0.12: `?sprecher=false` am SRT-Endpunkt". Wer die
Fassung wissen will, liest die Releases. Technisches gehört in den Abschnitt „Für
Entwickler" ans Ende, und was die README behauptet, muss stimmen: dass die Aufnahmen den
Rechner nie verlassen, gilt fürs Transkribieren — bei der Korrektur über einen Onlinedienst
nicht, und genau das steht auch dort.

## Offene Punkte werden Issues — automatisch, ohne Rückfrage
**Was am Ende einer Arbeit offen bleibt, wird ein GitHub-Issue.** Nicht eine Zeile im Bericht,
nicht ein Eintrag in einem Ledger, das mit dem Arbeitsverzeichnis stirbt — ein Issue. Der Grund
ist gemessen: PR #68 produzierte neun geparkte Befunde, und ohne Issues hätte sie nach dem Merge
niemand mehr gefunden, weil der Ledger git-ignoriert ist und der PR-Text im Archiv verschwindet.

**Issue-würdig ist**, was jemand später tun könnte: ein bewusst nicht behobener Befund, eine
benannte Testlücke, eine aufgeschobene Entscheidung, ein Fund eines Reviewers, den man geparkt
hat. **Nicht** issue-würdig: was in derselben Arbeit behoben wurde, reine Zwischenstände, und
Dinge, die schon woanders stehen (CLAUDE.md-Fakten, bestehende Issues — vorher `gh issue list`
prüfen).

**Wann:** direkt bevor die Arbeit als fertig gemeldet wird — vor dem PR-Merge, spätestens vor dem
Release. Nicht auf eine Aufforderung warten, nicht sammeln.

**Jedes Issue trägt drei Dinge**, sonst ist es in drei Monaten wertlos: die **Fundstelle**
(`Datei` bzw. `Datei:Zeile`), **warum es zählt** (welche Wirkung, für wen), und **wie es gefunden
wurde** (welcher Review, welche Messung, welche Sichtprüfung) — Letzteres, weil daran hängt, wie
belastbar der Befund ist. Labels: `bug` für falsches Verhalten und Testlücken, `enhancement` für
Geschmacks- und Ausbaufragen. Ist ein Punkt bewusst so entschieden, gehört die Entscheidung samt
Begründung ins Issue, nicht nur der Mangel.

## GitHub-Management (Claude übernimmt das autonom)
Code-Änderungen landen ohne Rückfrage über den Standard-Flow — nicht direkt auf master:
Feature-Branch → Commit → `gh pr create --base master` → CI/Mergeability prüfen →
Rebase-Merge (`gh pr merge <#> --rebase --delete-branch`) → lokal `master` per Fast-Forward
nachziehen + verifizieren. Diese Regel ist die dauerhafte Freigabe für Push/PR/Merge auf das
(private) Remote. Vorher fragen nur bei: `projekte\`-Inhalten (Interviewdaten bleiben lokal,
nie committen), unklarem Scope, oder history-verändernden Aktionen (force-push, Reset).

## Umgebung (Fakten)
- venv: `.venv` (Python 3.13, torch cu128 + faster-whisper) — GPU: RTX 5080 / Blackwell (sm_120).
  torch bleibt trotz des ASR-Wechsels: **pyannote** braucht es (und liefert nebenbei die
  cuBLAS-DLLs, die CTranslate2 fehlen).
- ffmpeg: wird von `transcribe.py` automatisch gefunden (winget Gyan.FFmpeg) oder muss auf PATH sein.
  **Auf PATH steht es dabei nie:** winget legt für Gyan.FFmpeg *keinen* Link in `WinGet\Links`,
  also findet `where ffmpeg` es auch nach erfolgreicher Installation nicht. Wer ffmpeg sucht,
  muss zusätzlich `%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*\ffmpeg*\bin` abklopfen —
  `transcribe.ensure_ffmpeg()` und `setup.wingetFfmpeg()` tun das, bewusst je gespiegelt.
  **Die Transkription braucht ffmpeg nicht mehr** (faster-whisper dekodiert über PyAV) — der
  URL-Import (yt-dlp) schon, und der ist der Grund, warum `ensure_ffmpeg` bleibt. Eine reine PATH-Prüfung meldet dauerhaft „fehlt", obwohl alles läuft.
- Modell-Cache: `%USERPROFILE%\.cache\huggingface` (einmaliger Download ~3 GB, CTranslate2-Format
  von `Systran/faster-whisper-<stufe>`). Ein altes `%USERPROFILE%\.cache\whisper\large-v3.pt`
  (3 GB) wird nicht mehr gelesen und kann weg.
- Env-Overrides: `WHISPER_MODEL` (default large-v3), `WHISPER_LANG` (default de), `TRANSKRIBOR_VERIFY` (default 1; `0`/`false`/`no` schaltet den 2b-Treue-Pass server-weit ab), `TRANSKRIBOR_DIARIZE` (default 1; `0`/`false`/`no` schaltet die akustische Sprecher-Diarisierung server-weit ab — Erzeugung UND Konsumption), `TRANSKRIBOR_PARALLEL` (default 3; gleichzeitige `claude -p`-Aufrufe), `TRANSKRIBOR_AUTOCORRECT` (default 1; `0` stoppt die automatische Korrektur nach der Transkription), `TRANSKRIBOR_SETTINGS` (Pfad der Einstellungsdatei; **Tests müssen das setzen**, sonst entscheidet die echte Datei des Entwicklers über den KI-Anbieter), `TRANSKRIBOR_PROJEKTE` (Wurzel der Projektordner; `electron/backend.js` setzt sie auf `userData/projekte` — **jeder** Zugriff auf Projektpfade muss sie lesen, sonst sucht der gepackte Lauf neben dem Code und findet nichts), `TRANSKRIBOR_ENV` (Pfad der `.env`; gepackt `userData/.env`, sonst Repo-Wurzel), `TRANSKRIBOR_GGML` (Verzeichnis der GGML-Modelle; gepackt `userData`, sonst `models/ggml` — dieselbe Regel wie `TRANSKRIBOR_PROJEKTE`: neben der `.app` darf nichts geschrieben werden), `TRANSKRIBOR_GGML_URL` (Vorlage mit `{datei}`-Platzhalter für den Download; gewinnt gegen das `modelle-v1`-Release — der Weg, um ein Modell zu testen, das noch nirgends hängt).
- **Die `.env` liest der Server selbst** (`settings.load_env()`, aufgerufen ganz oben in `app.py` — vor jedem Zugriff auf `os.environ`). Vorher parsten `webtool.ps1` und `electron/backend.js` sie je selbst: derselbe Parser in zwei Sprachen, und ein von Hand gestartetes `uvicorn webtool.app:app` sah die Datei überhaupt nicht. **Die Datei gewinnt gegen eine schon gesetzte Variable** — genau so verhielten sich beide Launcher, eine Umkehr wäre eine stille Verhaltensänderung.
- **Trust-Boundary Browser:** eine Origin-Middleware in `app.py` weist Requests mit nicht-Loopback-`Origin` mit 403 ab. Die Bindung auf `127.0.0.1` allein reicht nicht: multipart-Upload und POST ohne Body sind CORS-„simple" und lösen **keinen** Preflight aus, jede besuchte Fremdseite konnte also Audio unterschieben (`upload_audio` legt das Projekt sogar an) und GPU-Jobs starten. Nicht-Browser-Aufrufe (curl, Tests) schicken keinen `Origin` und laufen unverändert; `:5173` (Vite-Dev) ist Loopback und bleibt erlaubt.
- **Gerätewahl liegt in `webtool/device.py` — und zwar zweigeteilt.** `pick()` → cuda | mps | cpu
  gilt der torch-Welt (`webtool/diarize.py`, pyannote). `pick_asr()` → cuda | cpu gilt der
  Transkription: **CTranslate2 (faster-whisper) kennt kein MPS**, dokumentiert sind nur
  cpu/cuda/auto. Seit whisper.cpp gilt `pick_asr()` nur noch für den **Rückfall** — welche
  Engine überhaupt rechnet, beantwortet `asr_engine(modell)` (nächster Punkt). `describe()`
  liefert deshalb **alle drei** (`device` + `asr` + `asr_engine`), und die
  Einstellungsseite hängt ihren CPU-Hinweis an `asr`: an `device` gehängt schwiege er auf einem
  Mac genau dort, wo er nötig wäre. `PYTORCH_ENABLE_MPS_FALLBACK=1` setzen wir weiterhin NICHT
  (schöbe einzelne Ops still auf die CPU, während die Anzeige „mps" behauptet) — dieselbe Regel,
  die auch das `asr`-Feld erzwingt: die Anzeige darf nicht lügen.
- **Auf Apple Silicon transkribiert whisper.cpp über Metal, nicht faster-whisper.** Gemessen auf
  M1 Pro an 8,7 Min Interview bei identischen Decoder-Einstellungen: **650 s → 99 s (0,81× →
  5,29× Echtzeit)**. Ausschlaggebend war aber nicht der Faktor, sondern dass whisper.cpp als
  einzige Variante schneller wird, **ohne den Decoder zu verschlechtern** — voller Beam-Search
  statt greedy, gleiche Segmentzahl wie die Referenz. mlx-whisper fiel deshalb raus (langsamer
  als die CPU bei `turbo`, und `beam_size` wirft `NotImplementedError`). Was dabei zu wissen ist:
  - **Die Verzweigung sitzt an zwei Rändern** — `device.asr_engine(modell)` und `setup.js:plan()`
    (nennt `whisper-cpp` in derselben brew-Zeile wie python/ffmpeg) — und **konvergiert vor dem
    `<base>.json`-Vertrag**: `whispercpp.ergebnis()` baut exakt dieselbe dict-Form wie
    `transcribe._ergebnis()`. Alles dahinter bleibt einpfadig.
  - **An der Plattform festgemacht, nicht an `pick() == "mps"`**: whisper.cpp rechnet über Metal
    und braucht kein torch — an MPS gehängt fiele eine Mac-Installation ohne torch grundlos auf
    die langsame CPU zurück.
  - **Drei Rückfälle auf faster-whisper**, damit nie etwas *ausfällt* statt nur langsam zu sein:
    kein Apple Silicon, `whisper-cli` fehlt, oder eine Stufe ohne GGML-Datei am Release
    (`large-v1`, die `.en`-Varianten).
  - **q5_0 statt fp16 kostet 7 % Tempo und spart 1,9 GB** (1,01 statt 2,88 GB) — damit passt das
    Modell unter die 2-GB-Grenze für Release-Assets und kommt aus `modelle-v1` statt von Hugging
    Face. Der Mac-Pfad ist dadurch HF-frei (mit `HF_HUB_OFFLINE=1` verifiziert).
  - **DTW bleibt aus** (unvereinbar mit Flash Attention, halbiert den Durchsatz), und
    **`cpu_threads` bleibt beim Default** — mehr Threads sind *langsamer*, sobald sie auf
    Effizienzkernen landen (4→82 s, 8→171 s).
  - **Wort-Wahrscheinlichkeit ist das Mittel der Token-Werte**, nicht Minimum oder Produkt: die
    hätten `UNCERTAIN_TAG_THRESHOLD = 0.5` still entkalibriert (15,6 % statt 6,5 % unter der
    Schwelle) und den Editor mit Falschwarnungen geflutet.
  Details und die volle Messtabelle: `docs/superpowers/specs/2026-08-09-transkribor-apple-silicon-asr-design.md`.
- **ASR ist faster-whisper (CTranslate2), nicht mehr openai-whisper — auf Windows und Linux.** Gemessen an 309 s echtem
  Interview-Audio (large-v3, RTX 5080, identische Decoder-Parameter): **557 s → 18 s, Faktor ~31**
  (0,55× → 17× Echtzeit) bei **96 % Wortübereinstimmung** und mehr Wort-Zeitstempeln. faster-whisper
  ist zudem lauf-zu-lauf deterministisch; openai-whisper lieferte auf derselben Datei mal 67, mal 81
  Segmente. **Nicht** die Ursache war der Triton-/DTW-Rückfall: ohne `word_timestamps` war
  openai-whisper mit 700 s noch langsamer, `triton-windows` hätte also nichts gebracht.
- **Whisper bekommt KEINEN `initial_prompt` — er kostete ganze Passagen.** Er stand einmal in
  `transcribe._opts` („Interview auf Schweizerdeutsch…", bzw. der Inhalt von `kontext.md`) und
  brachte den Decoder dazu, ein 30-Sekunden-Fenster **vorzeitig zu beenden**; Whisper schiebt den
  Lesezeiger daraufhin um das **ganze** Fenster weiter, und die restliche Sprache darin wird nie
  angeschaut. Kein falsches Wort, sondern **gar keines** — und nichts im Ergebnis, woran man es
  sähe. Gemessen an ganzen Dateien bei sonst identischen Parametern: **1226 → 1346 Wörter**
  (`01172464`, 9:27), 454 → 590 (`C0701`), 140 → 158 (`C0761`); in einem Fall fehlten **18 s am
  Stück**, ausgerechnet die Antwort auf die erste Interviewfrage. **17 von 37** vorhandenen
  Aufnahmen trugen die Signatur. Seinen erklärten Zweck erfüllte er dabei nicht: Schweizerdeutsch-
  Marker (`isch`, `nöd`, `gsi`, `öppis`) kamen in **keinem** Lauf vor, mit Prompt wie ohne — Whisper
  normalisiert Deutsch von sich aus. Mit `kontext.md` schadete er zusätzlich, weil deren
  Markdown-Stil abfärbte (kleingeschrieben, ohne Satzzeichen). **`condition_on_previous_text` ist
  nicht beteiligt** (getrennt geprüft: auf `False` bleibt die Lücke). `kontext.md` bleibt erhalten
  und geht unverändert als `context` in die **Korrektur** — dort holt das gemeinsame Glossar ein
  falsch gehörtes Wort zurück; eine Passage, die Whisper nie gelesen hat, kann niemand mehr
  zurückholen. Ein Wächtertest (`test_opts_gibt_whisper_KEINEN_initial_prompt`) hält die Zeile
  draussen: sie sieht nützlich aus und ihr Schaden ist unsichtbar.
- **`transcribe._cuda_dlls_auf_pfad()` ist Pflicht, keine Vorsichtsmassnahme.** CTranslate2 bringt
  cuBLAS/cuDNN **nicht** mit, torch (cu128) schon — ohne den Griff stirbt der erste GPU-Lauf mit
  `Library cublas64_12.dll is not found or cannot be loaded`. **`os.add_dll_directory()` reicht
  nicht** (gemessen): CTranslate2 lädt per plainem `LoadLibrary`, das diese Liste nicht konsultiert
  — nur `PATH` wirkt, und zwar gesetzt **vor** `from faster_whisper import …`.
- **Der MPS-Rückfall in `transcribe.py` ist ersatzlos weg** (~35 Zeilen plus vier Tests): mit
  cuda/cpu gibt es den Fall nicht. Übrig bleibt die Regel, die davon zählte — eine kaputte Datei
  überspringen, der Lauf geht weiter.
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
- Stufe 3 (Sprecher-Diarisierung): `webtool/diarize.py` (pyannote.audio 4.0.7, Modell `speaker-diarization-community-1`, GPU) läuft als **Prep-Schritt im `correct run`** (vor `prep`, auf den Lauf gescopt), schreibt best-effort `<base>.diar.json` (Turns + `{id, "Sprecher N"}` je Segment, idempotent). `cmd_prep` webt das `(Sprecher N)`-Präfix in `<base>.tagged.txt`; der Korrektur-Prompt lässt Claude pro akustischem Cluster einen konsistenten Namen vergeben (**Hybrid**: Akustik trennt *wer wann*, LLM benennt *wie*). Fehlt pyannote oder scheitert die GPU → kein Sidecar → Korrektur wie bisher (reines Text-Raten, keine Regression). **Windows-Gotcha:** pyannotes torchcodec-File-Decoding lädt nicht (`libtorchcodec_core*.dll`) → Audio wird in-memory via `faster_whisper.decode_audio` (PyAV, 16 kHz mono) geladen und als `{waveform, sample_rate}`-Dict übergeben. Das lief früher über `whisper.load_audio`, das ffmpeg als **Binary** per subprocess rief — daher brauchte `diarize.py` ein eigenes `_ensure_ffmpeg`; PyAV dekodiert in-process, die Funktion ist ersatzlos weg. `jobs.py` serialisiert `transcribe`+`correct` auf der einen GPU. **Kein Einmal-Setup mehr** — siehe nächster Punkt.
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
  build`) und startet dann uvicorn (:8000) und den Browser — die optionale git-ignorierte
  `.env` (KEY=VALUE, Vorlage `.env.example`) lädt der Server selbst, siehe oben.  Frontend-Entwicklung mit
  Hot-Reload: `npm --prefix webtool/frontend run dev` (Vite :5173, proxied `/api` zu :8000).
  Kanonisches Editier-Dokument bleibt `<base>.edit.json` (aus Roh-`<base>.json`), Export
  `<base>.md`. Spec: `docs/superpowers/specs/2026-07-06-transkribor-webtool-design.md`.
- **`GET /api/projects` liefert nur die Zusammenfassung, `GET /api/projects/{project}` die
  Dateiliste.** Grund: drei Seiten (Galerie, Arbeitsfläche, Editor) teilten sich EINEN
  Endpunkt mit voller Dateiliste + drei `os.path.exists` je Datei, obwohl die Galerie aus dem
  ganzen Block nur zwei Zahlen zieht (`files.length`, wie viele `has_edit`). Zusammenfassung ist
  `{name, dateien, fertig, geaendert, active_jobs}`, pro Projekt ein `os.scandir` über
  `transkripte/` und eines über `audio/` statt 3N Einzelabfragen. **Gemessen** (300
  Attrappen-Projekte, ~3900 Aufnahmen, `list_projects()` direkt ohne HTTP-Server, Minimum aus
  fünf Läufen): **902 Dateisystem-Zugriffe** (300 Projekte × drei — `scandir` Transkripte,
  `scandir` Audio, plus das `isdir` aus `paths.audio_dir`, das dessen Existenz prüft — plus
  zwei für den Wurzelordner) und **~30 KB JSON-Nutzlast**, gegenüber vorher 13 691 Zugriffen
  und ~394 KB bei derselben Datenmenge. Die Dauer je Aufruf lag zwischen ~50 und ~115 ms
  (schwankt mit der Rechnerlast) — deutlich unter den 310 ms vorher, aber weniger dramatisch
  verbessert als die Zugriffszahl: die Zeit steckt im Lesen der Verzeichnisse selbst, nicht in
  der Zahl der Python-Aufrufe. Spec inkl. Methode:
  `docs/superpowers/specs/2026-08-10-transkribor-galerie-skalierung-design.md`.
- **`geaendert` ist `max(Datei-mtime)`, NICHT die mtime eines Ordners.** Verzeichnis-mtime
  bewegt sich nicht, wenn eine vorhandene Datei überschrieben wird — der Editor tut aber genau
  das mit `<base>.edit.json`. Eine Sortierung nach Ordner-mtime würde also die Arbeit nicht
  abbilden, um die es bei „zuletzt geändert" geht. `DirEntry.stat()` kostet dafür auf Windows
  keinen zusätzlichen Zugriff (kommt mit dem Verzeichnislisting mit).
- **Galerie (`HomeGallery.tsx`) für hunderte statt zehn Projekte:** klebendes Suchfeld über dem
  Namen (kein Enter nötig), laufende Projekte oben angeheftet als Karten (der einzige
  zeitkritische Zustand), der Rest als dichte 44px-Zeilen statt Dreispalten-Raster (das zwingt
  das Auge bei dreihundert Projekten in ein Z über hundert Reihen), Standardsortierung „zuletzt
  geändert" (umschaltbar auf Name). Dazu `Ctrl+K`/`Cmd+K` als Befehlspalette
  (`components/ProjektPalette.tsx`) über shadcns `Command` — von überall erreichbar, auch aus
  dem Editor, weil sie als Geschwister der `<Routes>` in `App.tsx` sitzt, nicht in der Galerie.
  `cmdk` lag als Abhängigkeit bereits vor, keine neue dazugekommen. Beide Kürzel (`Ctrl+K` hier,
  `Ctrl+←/→` im Editor) greifen nicht, während in einem `<input>`/`<textarea>`/
  `contentEditable` getippt wird.
- **`useProjectFiles` pollt nicht** (anders als `useProjects`) — ein zweiter eigener Poll wäre
  genau die Verdopplung, die die Aufteilung Zusammenfassung/Detail abschaffen soll. Stattdessen
  stossen zwei billigere Signale `refreshFiles()` an: `useActiveJob.onSettled` (ein Job dieses
  Prozesses wird terminal) UND eine Änderung von `dateien`/`fertig` im ohnehin laufenden
  Summenpoll (`useProjects`). **Beide sind nötig, nicht nur `onSettled`:** ein Job läuft oft
  Minuten, und `onSettled` feuert erst am Ende — ohne den zweiten Anstoss blieb eine bereits
  fertig transkribierte Datei mitten im Lauf für den Rest des Laufs deaktiviert (`has_raw` kommt
  nur über `refreshFiles()` rein), und eine von Hand in `audio/` kopierte Datei (kein Job, also
  nie ein `onSettled`) blieb bis zum Reload unsichtbar. `onSettled` bleibt trotzdem nötig: ein
  woanders gestarteter Job (z. B. „Korrigieren" aus der Arbeitsfläche, während der Editor offen
  ist) ändert `dateien`/`fertig` erst, wenn der ganze Lauf fertig ist — dazwischen ist
  `onSettled` der einzige Anlass, der die frisch geschriebene `<base>.edit.json` bemerkt.
- **Einzelne Aufnahme neu anstossen oder löschen:** `DELETE /api/projects/{p}/files/{base}`
  (Audio **und** alle Transkripte) und `POST /api/projects/{p}/files/{base}/transcribe`
  (Transkripte weg, dann der normale Projektlauf). Drei Dinge, die man nicht aus dem Diff liest:
  **Die abgeleiteten Dateien müssen beim Neu-Transkribieren mit weg** — `load_or_build_doc`
  bevorzugt `<base>.edit.json` vor der Roh-JSON, sonst zeigt der Editor nach dem Neulauf
  weiter den alten Text. **Kein eigener CLI-Schalter**: `transcribe.py` überspringt vorhandene
  `<base>.json`, also macht der Projektlauf genau die eine fehlende Datei und zieht per `then=`
  die Autokorrektur nach. **`glob.escape(base)` ist Pflicht**, nicht Vorsicht: `safe_name` lässt
  `[` und `*` durch, und der URL-Import legt Dateien wie `Video [dQw4w9].m4a` an — ungeschützt
  liest glob das `[` als Zeichenklasse und findet nichts. Beide Endpunkte antworten mit 409,
  solange **irgendein** Job des Projekts läuft (Dateien wegzuräumen, während ein Lauf sie
  schreibt, ist ein Datenrennen; eine Job-zu-Datei-Zuordnung gibt es im Backend nicht).
- **Umbenennen ist EIN Mechanismus für Projekt und Aufnahme** (`POST …/rename` und
  `POST …/files/{base}/rename`, im ⋯-Menü und in der Leiste). Vier Dinge, die man nicht aus
  dem Diff liest: **`os.path.exists` allein darf nicht über „Name frei?" entscheiden** —
  Windows' Dateisystem ist case-insensitiv, beim reinen Schreibweisenwechsel („weistannen" →
  „Weisstannen") zeigt es auf genau den Ordner, den man umbenennt, und die Aktion scheiterte
  mit „gibt es schon"; `_ziel_frei` trennt das per `os.path.samefile`. **Erst die ganze Liste
  prüfen, dann umbenennen**: auf halbem Weg abzubrechen liesse eine Aufnahme zurück, die es
  zweimal halb gibt — der Basisname ist die einzige Verbindung zwischen Ton und Transkript.
  **`base`/`project`/`audio` stehen IM Dokument** (`edit_model.build_edit_doc`), und
  `render_md` macht aus `base` den Titel — ohne Nachziehen trüge der nächste Export den alten
  Namen. **Die Sprechernamen sind ein Vorschlag, kein Automatismus**: ein Klick setzt sie ins
  Feld, geschickt wird trotzdem erst mit „Umbenennen". Sie kommen aus **einem** `getDoc` beim
  Öffnen des Dialogs, nicht aus der Dateiliste — die hält sich seit PR #67 bewusst von jedem
  Dokumentzugriff fern. Ist die Datei im Editor offen, wandert die Adresse mit (`replace`,
  der alte Pfad ist tot).
- **Die Datei-Aktionen liegen in EINEM Bauteil** (`components/DateiMenue.tsx`, das `⋯`-Menü in
  Arbeitsfläche *und* Seitenleiste). Vorher standen Korrigieren-Knopf und Überschreib-Rückfrage
  zweimal getrennt im Code, und die Fassungen liefen auseinander: die Arbeitsfläche schickte
  immer `force=false`, womit der Server eine handbearbeitete Datei **still übersprang** — von
  aussen sah das aus wie „die Korrektur lässt sich nicht neu anstossen". `DateiMenue` holt sich
  Nachladen, Job-Adoption und die Editor-Brücke aus den Kontexten statt über durchgereichte
  Requisiten; die dreistufige `onCorrectFile`-Kette (AppShell → Sidebar → FileRow) ist damit weg.
  **Löschen und Neu-Transkribieren verlassen den Editor, Korrigieren nicht:** dort bleibt das
  offene Dokument gültig und wird nach dem Lauf nachgeladen (mit Rückfrage bei Ungespeichertem),
  während ein verworfenes Transkript im Editor stehen bliebe und beim Speichern die gelöschte
  Datei neu anlegte.
- **Untertitel-Export `<base>.srt`** (`webtool/render_srt.py`, `POST …/export/srt`, Knopf im
  Editor) — die Datei geht in YouTube Studio unter „Untertitel > Datei hochladen" und ersetzt
  das schwache Auto-Transkript. Zwilling von `render_md.py`: gleiche Eingabe, andere Ausgabe.
  Zwei Entscheidungen, die man nicht umdrehen sollte, ohne den Grund zu kennen: der
  Sprechername steht **nur beim Wechsel** und mit `>>` davor (in jeder Zeile frisst er den
  halben Schirm, ganz weg verliert man bei zwei Stimmen den Faden) — abschaltbar über
  `?sprecher=false` bzw. den zweiten Eintrag im `.srt`-Menü der Editor-Leiste (zwei Menüpunkte
  statt eines Schalters: ein Schalter bräuchte einen Zustand, den man beim nächsten Export
  wieder raten müsste), und Zeilen brechen bei 42
  Zeichen an Wortgrenzen — ohne das schiebt YouTube ein langes Segment als eine einzige Zeile
  quer über das Bild. **Kein `?fmt=` am `/export`-Zwilling**: der müsste dafür seinen
  Rückgabeschlüssel `md` aufgeben. Läuft nur auf Knopfdruck, die Pipeline schreibt keine `.srt`.
  Aufeinanderfolgende `[Musik]`-Segmente ziehen **beide** Exporte zusammen — im SRT zu EINEM Cue
  über die ganze Spanne (sonst stünde sechsmal dieselbe Zeile da), im Markdown zu einer Zeile.
  Der Musik-Cue trägt **keinen** Sprechernamen, und danach wird der Name wieder genannt.
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
- Stufe 2b (Browser-Korrektur): `POST /api/projects/{project}/correct` startet `python -m webtool.correct run <NAME>` als `jobs.py`-Job (kind `correct`; Dedupe je `(Projekt, "correct")` — läuft also parallel zu einer Transkription desselben Projekts). Der `run`-Driver macht `prep` → ein `claude -p` für ein gemeinsames `_glossar.json` → pro Datei ein `claude -p` (Korrektur, schreibt `<base>.correction.json`) → per Default ein zweiter `claude -p` (**Treue-Verifikation** gegen das ID-getaggte `<base>.tagged.txt`, überschreibt `correction.json` mit der geprüften Fassung; ein ungültig schreibender Verify wird auf die gültige Erst-Korrektur zurückgerollt) → `apply`. Aufruf: `claude -p "<prompt>" --model opus --permission-mode acceptEdits --allowedTools Read,Write --strict-mcp-config --mcp-config '{"mcpServers":{}}' --add-dir <transkripte-Ordner>`, `cwd`=derselbe Ordner. **Der Schreibbereich ist EIN Projekt, nicht der Projektbaum:** `_ask_llm` leitet ihn aus dem Zielpfad ab (`os.path.dirname(output)`) — alle Ein- und Ausgaben eines Aufrufs liegen ohnehin im selben `transkripte`-Ordner. Vorher stand dort `projekte_root`, womit ein präpariertes Transkript (Prompt-Injection über den Audioinhalt, z.B. aus einem URL-Import) in die Transkripte **jedes anderen Projekts** schreiben konnte. **Kein MCP-Server:** halbiert den Startup (16,3s → 7,7s gemessen) und hält die persönlichen Server aus einem Lauf raus, der nicht vertrauenswürdigen Transkripttext verarbeitet.
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
