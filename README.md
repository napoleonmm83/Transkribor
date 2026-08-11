# Transkribor

**Aus Interview-Aufnahmen werden lesbare Transkripte — auf deinem eigenen Rechner.**

Du ziehst deine Audiodatei ins Fenster, der Rest passiert von selbst: Transkribor schreibt
mit, erkennt, **wer gerade spricht**, korrigiert falsch verstandene Wörter im Zusammenhang
und legt dir einen fertigen Text hin, den du direkt weiterverwenden kannst.

Gemacht für alle, die viel mit Gesprächen arbeiten: Journalismus, Forschung, Podcast,
Vereins- und Firmenarchive. Auch mit **Schweizerdeutsch** kommt es zurecht.

---

## In drei Schritten loslegen

1. **[Transkribor herunterladen](https://github.com/napoleonmm83/Transkribor/releases)** und
   installieren (Windows, macOS oder Linux).
2. Beim ersten Start richtet sich die App selbst ein. Das dauert einmalig 10–30 Minuten und
   lädt mehrere Gigabyte — danach nie wieder.
3. Projekt anlegen, Audiodatei hineinziehen. **Fertig** — die Arbeit startet von allein, und
   du siehst live, wie weit sie ist.

> Der Installer ist nicht bei Microsoft bzw. Apple registriert (das kostet Jahresgebühren).
> Windows zeigt darum „Computer geschützt" → *Weitere Informationen* → *Trotzdem ausführen*.
> Auf dem Mac: Rechtsklick auf die App → *Öffnen*.

---

## Was du davon hast

**Deine Aufnahmen bleiben bei dir.** Das Zuhören und Mitschreiben passiert vollständig auf
deinem Rechner — ohne Konto, ohne Cloud, ohne Upload. (Die anschliessende Textkorrektur nutzt
ein KI-Modell deiner Wahl; wählst du dafür einen Onlinedienst, geht der *Text* dorthin. Wer
das nicht will, nimmt ein lokales Modell oder lässt die Korrektur weg.)

**Es erkennt, wer spricht.** Interviewer und Befragte werden getrennt und mit Namen versehen —
das Transkript liest sich wie ein Gespräch, nicht wie eine Textwand.

**Es korrigiert mitdenkend.** Ein Sprachmodell geht den Text im Zusammenhang durch: falsch
gehörte Ortsnamen, Fachbegriffe und Eigennamen werden geradegezogen, über alle Aufnahmen
eines Projekts hinweg einheitlich. Anschliessend prüft ein zweiter Durchgang, dass nichts
dazuerfunden oder weggelassen wurde.

**Du behältst das letzte Wort.** Im eingebauten Editor hörst du jeden Abschnitt per Tastendruck
nach und änderst, was nicht stimmt. Unsichere Stellen sind farbig markiert — du siehst sofort,
wo sich das Nachhören lohnt.

**Untertitel für YouTube.** Ein Klick erzeugt eine `.srt`-Datei, die du bei YouTube hochlädst;
sie ersetzt die schwachen Automatik-Untertitel. Die Sprechernamen kannst du dabei ein- oder
ausblenden.

**Ordnung, auch nach hundert Aufnahmen.** Projekte und Aufnahmen lassen sich jederzeit
umbenennen — beim Umbenennen einer Aufnahme bietet dir Transkribor die Namen der Sprecher an,
sodass aus `01172464` ein „Hans Müller, Garage Rüthi" wird. Suchfeld und `Strg+K` führen dich
auch in grossen Sammlungen mit einem Griff zum richtigen Projekt.

**Videos direkt aus dem Netz.** YouTube- oder Instagram-Adresse einfügen genügt; Transkribor
holt sich die Tonspur selbst.

**Es wartet nicht auf dich.** Aufnahmen werden nacheinander abgearbeitet, mehrere Projekte
parallel — du kannst weiterarbeiten oder das Fenster zumachen.

---

## Was du brauchst

- **Windows oder Linux:** am besten eine NVIDIA-Grafikkarte. Damit ist ein einstündiges
  Interview in wenigen Minuten fertig.
- **macOS:** Apple Silicon (M1 oder neuer). Dazu einmalig im Terminal:
  `brew install python ffmpeg whisper-cpp`
- **Ohne passende Grafikkarte** läuft ebenfalls alles, nur langsamer — dann in den
  Einstellungen eine kleinere Qualitätsstufe wählen.

Für die Korrektur und die Sprechernamen braucht es zusätzlich ein Sprachmodell: entweder ein
Abo, das du vielleicht schon hast (Claude Code oder ChatGPT/Codex), ein eigener Schlüssel bei
Anthropic, OpenAI, Google oder OpenRouter — oder ein Modell, das lokal auf deinem Rechner
läuft (z. B. Ollama). **Ohne Sprachmodell funktioniert das Transkribieren vollständig**, es
entfällt nur die Korrektur.

---

## Häufige Fragen

**Kostet es etwas?** Nein. Transkribor ist freie Software (Open Source). Kosten entstehen nur,
wenn du für die Korrektur einen kostenpflichtigen KI-Dienst wählst — mit einem vorhandenen
Abo oder einem lokalen Modell entfällt auch das.

**Brauche ich Internet?** Nur zum Herunterladen und für die einmalige Einrichtung. Danach
arbeitet das Transkribieren offline.

**Wie lange dauert eine Stunde Audio?** Mit NVIDIA-Grafikkarte wenige Minuten, auf einem
Apple-Silicon-Mac gut zehn, ohne Grafikbeschleunigung deutlich länger.

**Welche Sprachen?** Voreingestellt ist Deutsch (inklusive Schweizerdeutsch, das als
Hochdeutsch verschriftet wird). In den Einstellungen lässt sich jede andere von Whisper
unterstützte Sprache wählen.

**Was passiert mit meinen Dateien?** Sie bleiben in deinem Benutzerordner. Transkribor löscht
nichts von allein, und das Original-Transkript bleibt immer erhalten — deine Korrekturen
liegen daneben, nicht darüber.

---

## Gefällt es dir?

Transkribor ist kostenlos und bleibt es. Wenn es dir Arbeit abnimmt, freue ich mich über eine
Unterstützung — sie fliesst in Entwicklungszeit und die Signatur-Zertifikate, die den
Installer künftig ohne Warnmeldung durchgehen lassen.

**[❤ Transkribor unterstützen](https://github.com/sponsors/napoleonmm83)**

Genauso hilfreich und kostenlos: einen [Fehler melden oder eine Idee
vorschlagen](https://github.com/napoleonmm83/Transkribor/issues) — oder dem Projekt einen
Stern geben.

---

## Für Entwickler

Die Desktop-App ist der empfohlene Weg; alles darin läuft aber auch direkt aus dem Repo.

```powershell
.\webtool.ps1    # baut das Frontend bei Bedarf, startet http://127.0.0.1:8000/ und den Browser
```

Frontend mit Hot-Reload: `npm --prefix webtool/frontend run dev` (Vite auf :5173, `/api` wird
zum FastAPI-Backend auf :8000 durchgereicht). Installer selbst bauen:
`npm install && npm run dist` → `dist\` (Windows `.exe`, macOS `.dmg`, Linux `AppImage`/`.deb`).

**Ohne Oberfläche, direkt auf der Kommandozeile:**

```powershell
.\transkribieren.ps1 <Name>              # ein Projekt transkribieren (--all, --list)
python -m webtool.correct run <Name>     # korrigieren + Sprecher benennen
python -m webtool.fetch <Name> <url>     # Tonspur aus YouTube/Instagram holen
```

**Aufbau:**

```
Transkribor/
├── transcribe.py        # Transkription (faster-whisper auf CUDA, whisper.cpp auf Apple Silicon)
├── webtool/             # FastAPI-Backend + React-Editor (Frontend in webtool/frontend/)
├── electron/            # Desktop-Hülle: Ersteinrichtung, Server-Start, Auto-Update
├── models/              # mitgeliefertes Sprechertrennungs-Modell (CC-BY-4.0)
├── CLAUDE.md            # Arbeitsanleitung + das gesammelte Warum hinter den Entscheidungen
└── projekte/<Name>/
    ├── audio/           # Aufnahmen
    ├── transkripte/     # .md fertig, .edit.json editierbar, .json roh
    └── kontext.md       # optional: Beschreibung + bekannte Namen, verbessert die Korrektur
```

Die Roh-Transkription bleibt unangetastet: Korrekturen liegen in `<base>.edit.json`, Exporte
(`.md`, `.srt`) werden daraus erzeugt. Warum die Dinge so sind, wie sie sind — inklusive der
Messungen dahinter — steht in [`CLAUDE.md`](CLAUDE.md), Entwürfe in
[`docs/superpowers/specs/`](docs/superpowers/specs/).

**Technisch drunter:** Whisper `large-v3` über faster-whisper (CUDA) bzw. whisper.cpp (Metal),
Sprechertrennung mit pyannote, Korrektur über einen frei wählbaren LLM-Anbieter, Oberfläche
als React 19 + Vite + TypeScript + Tailwind v4 + shadcn/ui, Backend FastAPI, Desktop-Hülle
Electron mit Auto-Update.
