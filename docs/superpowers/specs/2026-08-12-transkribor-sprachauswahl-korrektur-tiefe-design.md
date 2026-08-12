# Sprachauswahl + Korrektur-Tiefe

**Stand:** 2026-08-12, master `ce4697a`. Issue #132.

## Problem

Ein englisches YouTube-Video (`PqVo5ThzN0c`) wurde transkribiert und kam **auf Deutsch**
heraus, nicht in der Originalsprache. Zwei Ursachen, die zusammenwirken:

1. **Whisper wird fest „Deutsch" vorgegeben.** `WHISPER_LANG` defaultet auf `de`
   (`webtool/settings.py:89`), `settings.job_env()` reicht das als `WHISPER_LANG` an den
   Job-Subprozess (`webtool/jobs.py:141`), und `transcribe._opts()` zwingt ihn als
   `language=` in faster-whisper (`transcribe.py:118`). Über die Originalsprache wird nichts
   erkannt — sie ist fest vorgegeben.
2. **Der Korrektur-Schritt übersetzt aktiv ins Deutsche.** Die Korrektur-Prompts haben
   „Standarddeutsch" als Ziel fest einbetoniert: `correct.py:326` („oft Schweizerdeutsch ->
   lesbares Standarddeutsch"), `correct.py:337` („zu lesbarem Standarddeutsch normalisieren"),
   `correct.py:45` (`DEFAULT_CONTEXT`: „… nach Standarddeutsch transkribiert"). Ein
   Sprachmodell, das diese Anweisung bekommt, übersetzt englisches Transcript ins Deutsche.

Hinzu: **es gibt keinen Sprachwähler in der Oberfläche.** `whisper_lang` existiert im Backend
vollständig (`settings.public()` liefert es, `SettingsPage.tsx` zeigt es aber nur für die
Modell-Qualität, nicht für die Sprache). Der Nutzer kann weder die Transkriptionssprache noch
die Korrektur-Tiefe wählen.

## Lösung (Marcus' Wahlen)

- **Sprache pro Datei**, nicht nur pro Projekt: jedes Audio (Upload oder URL-Import) bekommt
  seinen eigenen Sprachwert, Vorgabe = Projektstandard. **Ein Projekt darf Dateien in
  verschiedenen Sprachen enthalten** (Marcus' ausdrücklicher Fall: Schweizerdeutsch-Interviews
  plus ein englisches Einmal-Video).
- **Sprache setzt die Vorgabe, übersteuerbar**: aus der Datei-Sprache folgt automatisch die
  Korrektur-Tiefe; pro Datei (und als Projekt-Vorgabe) umstellbar.
- **Vier Korrektur-Tiefen** (s.u.); Vorgabe bei Dialekt = voll+Dialekt, bei sauberen Sprachen
  = voll ohne Dialekt; „leicht" und „nur Zusammenfassung" sind zusätzlich wählbar.
- **Schweizerdeutsch-Pipeline bleibt unangetastet** (Marcus' Hauptbedingung): Dateien mit
  Sprache *Schweizerdeutsch* laufen exakt wie heute.
- **Zusammenfassung in jeder Stufe** — auch „nur Zusammenfassung" produziert eine
  Inhalts-Zusammenfassung (Marcus: „sicher eine Kontext-Zusammenfassung mitnehmen").

## Datenmodell

### `projekt.json` (neu, im Projektordner neben `kontext.md`)

Projekte sind bisher reine Ordner ohne Metadaten. Diese Feature braucht zwei Werte pro
Projekt und pro Datei. Eine kleine JSON-Datei ist die eine Wahrheitsquelle — `kontext.md`
bleibt Marcus' lesbarer Kontext (keine Maschinendaten dort).

```json
{
  "sprache": "ch",            // Projekt-Standard-Sprache (s. Tabelle); Default "ch"
  "korrektur": "auto",        // Projekt-Standard-Tiefe (auto|voll_dialekt|voll|leicht|zusammenfassung); Default "auto"
  "dateien": {                // pro Basisname, sobald die Datei Sprache/Tiefe einzeln trägt
    "PqVo5ThzN0c": {"sprache": "en", "korrektur": "auto"}
  }
}
```

- **Lesen:** `transcribe.py` und `correct.py` lesen die Datei direkt (plain `json.load`,
  kein `webtool`-Import — `transcribe.py` bleibt lauffähig ohne das Paket, siehe dessen
  Docstring). Fehlt sie oder ein Eintrag → Projekt-Standard → `ch` (legacy-sicher, s. Constraints).
- **Schreiben:** beim Anlegen des Projekts (Default `ch`/`auto`), beim Speichern der
  Projekt-Einstellungen und beim Upload/Import (Datei-Eintrag mit gewählter Sprache).
- Die Datei ist nicht kritisch: fehlt sie, läuft alles wie heute auf Schweizerdeutsch.

### Sprach-Tabelle (eine Quelle, alle drei Consumers)

| id | Label | Whisper-Code | Dialekt-Korrektur | Prompt-Zielsprache |
|----|-------|--------------|-------------------|--------------------|
| `ch` | Schweizerdeutsch | `de` | **ja** | „lesbares Standarddeutsch" |
| `de` | Deutsch | `de` | nein | „lesbares Standarddeutsch" |
| `en` | Englisch | `en` | nein | „clear English" |
| `fr` | Französisch | `fr` | nein | „français courant" |
| `it` | Italienisch | `it` | nein | „italiano corretto" |
| `auto` | Automatisch | `None` | nein | erkannte Sprache (s. Constraints) |

Definiert an **einer** Stelle (z. B. `webtool/sprachen.py`), konsumiert von: dem Frontend
(Wähler), `transcribe.py` (`language`-Code), `correct.py` (Prompt-Ziel + Dialekt-Flag).

## Korrektur-Tiefen

Vier Stufen. Die Tiefe pro Datei = `dateien[base].korrektur` → sonst Projekt-`korrektur` →
sonst `auto` (= aus der Sprache abgeleitet: `ch`→`voll_dialekt`, alles andere→`voll`).

| Tiefe | Schritte | LLM-Aufrufe | Default bei |
|-------|----------|-------------|-------------|
| `voll_dialekt` | Glossar + Korrektur (Dialekt→Standard, Zielsprache) + Treue-Check | ~3 | Schweizerdeutsch |
| `voll` | Glossar + Korrektur (Zielsprache, **keine** Dialekt-Glättung) + Treue-Check | ~3 | de/en/fr/it |
| `leicht` | **ein** Lauf: Zusammenfassung + Sprecher-Namen + offensichtliche ASR-Fehler/Namen. Kein Glossar, kein Treue-Check | 1 | (wählbar) |
| `zusammenfassung` | **ein** Lauf: Zusammenfassung + Sprecher-Namen. Transkripttext bleibt Roh | 1 | (wählbar) |

**Die Ersparnis** („Korrektur einsparen" bei sauberen Sprachen): `voll`/`voll_dialekt` laufen
Glossar + Block-Korrektur + Verify; `leicht`/`zusammenfassung` sind ein einziger Aufruf und
skippen Glossar und Treue-Check. Die Zusammenfassung entsteht in **jeder** Stufe.

### Wiederverwendung von `apply_correction` (kein neuer Apply-Pfad)

`leicht` und `zusammenfassung` schreiben dieselbe `<base>.correction.json` wie die vollen
Modi, nur mit weniger/schmaleren `segments`:

- `leicht` → `segments: [{id, speaker, text}]` (Text leicht korrigiert, `[[...]]` entfernt).
- `zusammenfassung` → `segments: [{id, speaker}]` **ohne** `text`-Schlüssel.

`apply_correction` lässt bei einem Eintrag **ohne** `text`-Schlüssel den Rohtext stehen
(festgehalten in CLAUDE.md, gemessen am ARD-Text-Fall). Damit baut der Zusammenfassungs-Modus
ein fertiges `edit.json` mit benannten Sprechern + Zusammenfassung + unangetastetem Text —
ohne dass Apply den Text-Pfad ändert. Dasselbe gilt für die Sprecher- und `summary`-Felder.

## Architektur

### Transkription — `transcribe.py` liest Sprache pro Datei

`transcribe_project(name, model, language, only)` bekommt heute **einen** `language`-Wert für
alle Dateien. Änderung: im Datei-Loop (`transcribe.py:221`) wird je Datei die Sprache aus
`projekt.json` gelesen (Datei-Eintrag → Projekt-Standard → `language`-Arg als letzten
Rückfall, das heutige Verhalten). `_opts(language)` steht ohnehin pro Datei (`:239`), der
Modell-Lader davor bleibt einmalig. Für `auto` → `language=None`, faster-whisper erkennt selbst.

### Korrektur — `correct.py` wird sprach- und tiefenbewusst

`cmd_run(project, base, force, verify)` läuft heute für jede Datei denselben Pfad. Änderung:
die Schleife `one(b)` (`:601`) liest Datei-Sprache + -Tiefe und **verzweigt**:

- `voll_dialekt` / `voll` → `_correct_file(...)` wie heute, aber die Prompts tragen die
  **Zielsprache** und den **Dialekt-Flag** (nur `voll_dialekt` glättet Dialekt; beide führen
  den Treue-Check, sofern `verify` an). Glossar nur gebaut, wenn mind. eine Datei im Lauf eine
  `voll*`-Tiefe hat (sonst gespart).
- `leicht` → neuer `_light_correct_file(...)`: ein `_ask_llm` mit einem neuen
  `_light_prompt` (liest `tagged.txt`, schreibt `correction.json` mit `summary`/`speakers`/
  leicht korrigiertem `text`/`annotations`). Kein Glossar, kein Verify.
- `zusammenfassung` → neuer `_summary_only_file(...)`: ein `_ask_llm` mit einem neuen
  `_summary_prompt` (liest `tagged.txt`, schreibt `correction.json` mit `summary`/`speakers`/
  `segments:[{id,speaker}]` ohne `text`). Kein Glossar, kein Verify.

Anschluss bei `cmd_apply` unverändert (gleiche `correction.json`-Form).

### Prompt-Parameterisierung

Die festen deutschen Zielvorgaben werden ersetzt durch zwei Parameter, die aus der
Sprach-Tabelle kommen: **`ziel`** (Prompt-Zielsprache, z. B. „clear English") und
**`dialekt`** (bool). Konkret:

- `_correct_prompt`/`_verify_prompt`: „(oft Schweizerdeutsch -> lesbares Standarddeutsch)" →
  sprachabhängige Einleitung; „zu lesbarem Standarddeutsch normalisieren (Schweizer „ss«)" →
  „normalisieren zu {ziel}" plus den Schweizer-„ss"-Hinweis **nur** wenn `dialekt`.
- `DEFAULT_CONTEXT`: wird nicht mehr fest verdrahtet; `kontext.md` bleibt die Quelle, der
  Fallback beschreibt die Sprache neutral.
- **Die Treue-Regeln zu `[Musik]` und ASR-Artefakten bleiben in ALLEN Voll-Prompts
  sprachunabhängig stehen** (Whisper singt über jeder Sprache „sicheren Unsinn"); siehe
  CLAUDE.md. Nur in den leichten Modi entfallen sie (dort wird nicht treue-geprüft).

### Diarisierung

Akustisch und sprachunabhängig (`webtool/diarize.py`, pyannote). Bleibt für **alle** Sprachen
und **alle** Tiefen unverändert laufen; die Sprecher-Namen-Vergabe im LLM passiert in jeder
Stufe (auch `zusammenfassung`). Kein Eingriff nötig.

### Job-Anbindung

`WHISPER_LANG` aus `settings.job_env()` bleibt der globale Rückfall (legacy-/CLI-Nutzung).
`transcribe.py` zieht sich die echten Werte aber aus `projekt.json`. Die Endpunkte
`POST …/audio`, `POST …/fetch`, `POST …/correct` und `POST …/files/{base}/correct`
(`webtool/app.py:693/552/527/535`) brauchen keinen neuen Sprache-Parameter im Kommando: die
Sprache steht in `projekt.json`, die Subprozesse lesen sie selbst. Neu ist nur, dass Upload
und Fetch die gewählte Sprache in `projekt.json.dateien[base]` eintragen, **bevor** sie den
Transkriptions-Job anstossen.

## Bedienung (UI)

- **Projekt-Einstellungen** (neu, erreicht über das ⋯-Menü des Projekts — `ProjektMenue`):
  Standard-Sprache + Standard-Tiefe für das Projekt. Default bei Neuanlage: *Schweizerdeutsch*
  / *auto* (= heutiges Verhalten).
- **Am Upload (Drag&Drop) und am URL-Importfeld**: ein Sprach-`<Select>`, Vorgabe =
  Projekt-Standard. Dahinter die Korrektur-Tiefe ausgeklappt (Vorgabe *auto*). Für das
  englische Einmal-Video: URL einfügen, Sprache am Feld auf *Englisch* — kein Projekt-Umbauen.
- **Bestehende Datei, Sprache ändern**: erfordert **Neu-Transkription** (Whisper hat die
  Sprache ins `.json` gebrannt). Die UI bietet „neu transkribieren" an. **Tiefe ändern**
  braucht keine Neu-Transkription, nur „neu korrigieren".

## Constraints (hart)

1. **Sprache nachträglich ändern ⇒ neu transkribieren.** Whisper brennt `language` ins
   Roh-`.json` (`_ergebnis`, `:173`). Tiefe ist nur eine Korrektur-Einstellung und ändert sich
   ohne Neu-Transkription.
2. **Dialekt ist nicht erkennbar.** Whispers Code für Schweizerdeutsch ist `de` — nicht von
   Hochdeutsch zu unterscheiden. Bei `auto` liefert Whisper zwar eine Sprache, aber nie
   „Schweizerdeutsch". Die erkannte Sprache füllt die Prompt-Zielsprache deterministisch
   (erkannt `en` → „clear English", erkannt `de` → „Standarddeutsch" **ohne** Dialekt-Glättung);
   die Tiefe defaultet auf `voll`. Was `auto` **nicht** leisten kann, ist die
   Dialekt-Glättung: wer Schweizerdeutsch-Audio als `auto` erfasst, bekommt kein
   Dialekt→Standarddeutsch. UI-Hinweis bei `auto`: „Schweizerdeutsch wird nicht automatisch
   erkannt — bei Dialekt-Audio Sprache explizit auf *Schweizerdeutsch* stellen."
3. **Legacy-Dateien ohne `projekt.json`/Eintrag** gelten als Schweizerdeutsch + `auto` ⇒
   `voll_dialekt`. Kein Verhaltenswechsel für bestehende Projekte.
4. **Schweizerdeutsch = heutige Pipeline, exakt.** `voll_dialekt` ist kein neuer Modus, sondern
   der heutige Pfad mit denselben Prompts (nur dass `ziel`/`dialekt` jetzt explizit „Standarddeutsch"/
   `true` sind). Das ist die Rückfall-Garantie.

## Bewusst NICHT gebaut

- **Diakriten- bzw. Dialekt-Erkennung** aus dem Audio. Dialekt bleibt eine bewusste Wahl,
  kein Heurismus (die `compute_flags`-Lektion aus CLAUDE.md: Heuristiken täuschen hier
  Sicherheit vor, die nicht da ist).
- **Pro-Segment-Sprachwechsel** innerhalb einer Datei (Code-Switching). Eine Datei = eine
  Sprache. Code-Switching wäre ein eigenes Thema.
- **Sprachspezifische Glossare** für gemischte Projekte. Das Glossar bleibt korpus-weit und
  sprachneutral formuliert (Eigennamen sind der Hauptwert und sprachunabhängig); für
  nicht-deutsche Dateien ist das eine akzeptierte Näherung. Folge-Issue, falls es stört.
- **Rückwirkendes Umstellen** schon korrigierter Dateien in andere Sprachen ohne
   Neu-Transkription (technisch ausgeschlossen, s. Constraint 1).
- **Neue Sprachen jenseits ch/de/en/fr/it/auto** jetzt einzeln freischalten. Die Tabelle ist
  erweiterbar; der Wähler zeigt genau diese sechs (Marcus' Auswahl).

## Offene Punkte (Folge-Issues, nach dem Merge)

- Tatsächliche Treue-Messung der leichten Modi an sauberen Sprachen (die vollen Prompts sind
  über Monate gegen Schweizerdeutsch entwickelt; ob „leicht"/„zusammenfassung" für Englisch
  ausreicht, ist ungemessen — analog Issue-#130-Vorgehen).
- Gemischtsprachiges Glossar (s.o.).
- UI: Sprache auch pro einzelner **bereits liegender** Datei umstellbar (heute nur am
  Upload/Import und in den Projekt-Standards).

## Risiko

- **Prompt-Qualität bei neuen Sprachen.** Die Voll-Prompts sind stark auf Schweizerdeutsch→Deutsch
  getestet. Für en/fr/it ist die sprachbewusste Variante plausibel, aber ungemessen — der
  Treue-Pass (`verify`) fängt grobe Abweichungen auf, darum bleibt er in `voll` an.
- **`projekt.json`-Drift**, wenn Dateien von Hand in `audio/` kopiert werden: sie haben keinen
  Eintrag und fallen auf den Projekt-Standard. Das ist dasselbe Verhalten wie heute (alle Dateien
  ch), also keine Regression — nur keine neue Sprache für von-Hand-Kopien.
