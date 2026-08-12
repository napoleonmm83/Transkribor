# Sprache pro bereits liegender Datei nachträglich wählbar

**Stand:** 2026-08-12, master `e3ee269`. Issue #135 (Follow-up zu #132 / PR #133).

## Problem

Sprache und Korrektur-Tiefe sind nur **am Upload/URL-Import** und **als Projekt-Standard**
wählbar. Eine bereits liegende Datei nachträglich auf eine andere Sprache zu setzen, geht nur
über „Neu transkribieren" — aber das ändert nicht den Sprachwert, den Whisper beim Neulauf
nimmt: die Sprache wird aus `projekt.json` gelesen (`transcribe._datei_whisper_code`), und den
Datei-Eintrag dort kann der Nutzer nicht erreichen. Wer beim Upload die falsche Sprache erwischt
hat, muss den Datei-Eintrag von Hand setzen oder die Datei löschen und neu hochladen.

Dasselbe gilt für die **Korrektur-Tiefe**: ein Datei-Eintrag `korrektur` existiert im Modell
(`projekt.setze_datei`), ist aber über die Oberfläche nicht pro Datei erreichbar — nur der
Projekt-Standard.

## Was schon steht (deshalb ist die Aufgabe klein)

- **Datenmodell pro Datei** ist fertig: `projekt.setze_datei(project, base, sprache, korrektur)`
  schreibt den Override, `datei_sprache`/`datei_korrektur`/`tiefe_effektiv` lesen ihn
  (Override, sonst Projekt-Standard). `transcribe.py` und `correct.py` konsumieren das bereits.
- **Job-Endpunkte** für die nötigen Trigger stehen: `POST …/files/{base}/transcribe` (wirft
  Transkripte weg, läuft Whisper neu, zieht über `then=` die Autokorrektur nach) und
  `POST …/files/{base}/correct` (Einzeldatei-Korrektur, `force` nach UI-Bestätigung). Beide
  sperren über `_keine_jobs(project, base)` mit 409, falls ein Job diese Aufnahme anfasst.
- **Projekt-Einstellungsdialog** (`ProjektEinstellungenDialog.tsx`) + Endpunkt-Paar
  `GET/PUT /api/projects/{project}/einstellungen` sind die Vorlage: zwei Selects, lädt beim
  Öffnen, schreibt beim Speichern.

Fehlt: das **Datei-Pendant des Endpunkts**, ein **Menüeintrag** und die **Trigger-Verzweigung**.

## Lösung (Marcus' Wahlen)

- **Ein Dialog pro Datei**, erreichbar über einen neuen Eintrag „Sprache & Korrektur-Tiefe" im
  ⋯-Menü der Datei (`DateiMenue.tsx`), zwischen „Umbenennen" und dem Trenner. Er zeigt die
  *effektiven* Werte der Datei (Override oder Projekt-Standard) in zwei Selects.
- **Auto-Trigger beim Speichern** (Marcus' Wahl): der Dialog schreibt den Override **und**
  stößt sofort die nötige Neuberechnung an. Unterschieden nachdem, was sich geändert hat und
  ob schon ein Transkript liegt (`has_raw`):

  | Geändert | `has_raw` | Aktion beim Speichern |
  |---|---|---|
  | Sprache | ja | **Neu transkribieren** (Whisper neu, Kette zieht Korrektur nach) |
  | nur Tiefe | ja | **Neu korrigieren** (`force=true`) |
  | Sprache + Tiefe | ja | Neu transkribieren (deckt beides, da die Kette die Tiefe übernimmt) |
  | beliebig | nein | nur Override schreiben (nächste Transkription/Korrektur übernimmt ihn) |
  | nichts | — | nur Override (bzw. gar kein PUT, s.u.) |

- **Knopf-Text und Hinweis spiegeln die Aktion**, damit der destruktive Charakter klar ist —
  der Dialog ist die Bestätigung, ein zweites Modal gibt es nicht:
  - Sprache geändert & `has_raw` → „Speichern & neu transkribieren"; Hinweis: Transkript,
    Korrektur und Export werden verworfen (Audio bleibt) — **bei `has_edit` inkl. der
    handbearbeiteten Fassung**.
  - nur Tiefe geändert & `has_raw` → „Speichern & neu korrigieren"; Hinweis bei `has_edit`:
    die handbearbeitete Fassung wird überschrieben (`force=true`, s.u.).
  - `!has_raw` oder nichts geändert → „Speichern".

## Architektur

### Backend (`webtool/app.py`, `webtool/projekt.py`)

Neu: `GET/PUT /api/projects/{project}/files/{base}/einstellungen` — das Datei-Pendant des
Projekt-Endpunkts. Beide validieren `_validate(project, base)`.

- **GET** liefert `{sprache, korrektur, sprach_choices, tiefen}` mit `sprache =
  _projekt.datei_sprache(project, base)`, `korrektur = _projekt.datei_korrektur(project, base)`
  (effektive Werte) sowie `_sprachen.fuer_frontend()` / `_sprachen.TIEFEN` (dieselben Auswahlen
  wie beim Projekt-Dialog — eine Quelle). 404, wenn kein Audio und kein Transkript liegt
  (`find_audio` + `_raw_path` prüfen, wie `retranscribe_file`).
- **PUT** schreibt ausschließlich: `_projekt.setze_datei(project, base, sprache, korrektur)`.
  **Kein Job-Start, keine 409-Sperre** — derselbe sperrfreie Schreibpfad, den auch der Upload
  geht (`upload_audio` ruft `setze_datei`, während ein Lauf laufen kann; der laufende Job hat
  seine Sprache beim Start bereits gelesen). Body-Klasse wiederverwendet `EinstellungenBody`
  (`sprache`/`korrektur`, beides optional, `None` wird ignoriert).

`projekt.py` braucht **keine Änderung** — `setze_datei`/`datei_sprache`/`datei_korrektur` stehen.

### Frontend

- **`lib/api.ts`**: `getFileEinstellungen(project, base)` / `saveFileEinstellungen(project, base,
  patch)` — Spiegel der Projekt-Funktionen gegen den neuen Pfad.
- **`components/DateiEinstellungenDialog.tsx`** (neu): baut auf
  `ProjektEinstellungenDialog` auf — zwei Selects, lädt beim Öffnen, schreibt beim Speichern —
  erweitert um den kontext-abhängigen Hinweis, den dynamischen Knopf-Text und den Auto-Trigger.
  controlled (`offen`/`onOpenChange`), steht **neben** dem Menü (ein Dialog *im* Menü wird beim
  Schließen mit ausgehängt — dieselbe Falle wie `UmbenennenDialog` in `DateiMenue`).
- **`components/DateiMenue.tsx`**: neuer Eintrag „Sprache & Korrektur-Tiefe" (Icon `Languages`
  aus lucide), öffnet den Dialog. Die Trigger-Rückrufe (`startRetranscribeFile`/
  `startCorrectFile`, Job-Adoption, Editor-Reload/`vergiss`) hängen an der **bestehenden**
  `jobStarten`/`korrekturFertig`/`editorVergessen`/`wegVomEditor`-Logik — kein zweiter
  Job-Mechanismus.

### Trigger-Verzweigung (Frontend, nach erfolgreichem PUT)

```
hat_sprache_geaendert = gespeicherteSprache !== urspruenglicheSprache
hat_tiefe_geaendert   = gespeicherteTiefe   !== urspruenglicheTiefe

if (!file.has_raw)                     → nur Override (fertig)
elif hat_sprache_geaendert             → startRetranscribeFile  (Editor vergisst + verlässt)
elif hat_tiefe_geaendert               → startCorrectFile(force=true)  (Editor lädt nach)
else                                   → nur Override (fertig)
```

**Sprache-Trigger = destruktiv wie „Neu transkribieren":** die Aufnahme hat die falsche Sprache
gehabt, das alte Transkript ist wertlos. Der Editor vergisst seine Fassung und verlässt die
Datei (`editorVergessen` + `wegVomEditor`), sonst spülte der Verlassens-Flush die alte Fassung
als Waise zurück — derselbe Schutz wie beim manuellen „Neu transkribieren" und beim Löschen
(#106-Review C1/C2).

**Tiefe-Trigger = wie „Neu korrigieren":** das Dokument bleibt gültig, der Editor lädt nach dem
Lauf nach (`korrekturFertig`, mit der bekannten dirty-Rückfrage). `force=true` bewusst gesetzt:
der Nutzer hat die Tiefe geändert und damit explizit eine Neukorrektur verlangt — der Dialog ist
die Bestätigung, die das manuelle „Neu korrigieren" sonst über seinen Bestätigungs-Dialog
einholt. Ohne `force` überspränge `correct.py` eine `human_edited`-Datei still, und die neue
Tiefe wirkte nicht.

## Randfälle und bewusste Entscheidungen

- **409 nach dem Speichern:** Startet ein Job auf dieser Datei, während der Dialog offen war,
  antwortet der Trigger-Endpunkt 409. Der Override ist trotzdem geschrieben (gültig für den
  nächsten manuellen Anstoß). Der Toast nennt den 409-Grund; der Nutzer bedient den
  bestehenden Neu-transkribieren/Korrigieren-Knopf. Kein automatischer Retry (die Vorgabe ist
  weg, der Anlass kann Minuten dauern).
- **`projekt.json` Read-Modify-Write-Race = Issue #134** (offen, vorbestehend). `setze_datei`
  macht load→modify→write; #135 nutzt denselben Pfad und verschlimmert es nicht. **Nicht hier
  behoben** — die Fehlerfolge (ein Override geht verloren) ist beherrschbar, und die Lösung
  gehört zu #134, nicht zu diesem Feature.
- **Effektiv vs. explizit:** der Dialog zeigt die effektiven Werte. Ohne Datei-Override steht
  dort der Projekt-Standard. Speichern würde einen expliziten Override gleich dem Standard
  schreiben (verhaltenstneutral, nur etwas Noise in `projekt.json`). Darum schickt das Frontend
  das PUT **nur, wenn sich mindestens ein Wert geändert hat** — unverändertes Speichern ist ein
  No-op.
- **Beide-geändert:** Sprache-Änderung dominiert, weil die Retranscribe-Kette die neue Tiefe
  über die Autokorrektur ohnehin übernimmt. Kein separater Korrektur-Lauf nötig.
- **`aiReason` (kein nutzbarer KI-Anbieter):** der Tiefe-Trigger ruft „Neu korrigieren" auf,
  das am `_require_ai`-Riegel scheitert (409). Sprache-Trigger (Neu transkribieren) braucht
  keinen Anbieter und läuft immer. Der Datei-Einstellungs-Eintrag ist daher **nicht** wie
  „Korrigieren" gesperrt — Sprache zu ändern geht immer. Schlägt der Tiefe-Trigger fehl, fällt
  der Toast wie bei jedem manuellen „Neu korrigieren".
- **Datei ohne Audio und ohne Transkript:** GET antwortet 404; der Eintrag fehlt oder ist
  deaktiviert. Praktisch irrelevant — eine Datei in der Liste hat mindestens eines von beiden.

## Testabdeckung

- **Backend (`test_api.py`):** GET liefert effektive Werte + Auswahlen; GET 404 bei
  unbekannter Datei; PUT schreibt Override (`setze_datei` nachgefragt), None-Werte
  ignoriert; PUT ist sperrfrei (kein 409-Kontext nötig).
- **Frontend:** `DateiEinstellungenDialog.test.tsx` — rendert Selects, Hinweis-Text je
  Szenario (Sprache-Änderung/Tiefe-Änderung/`!has_raw`), Knopf-Text je Szenario,
  Trigger-Auswahl (retranscribe vs. correct vs. none), 409-Toast, kein PUT bei nichts-geändert.
  `DateiMenue.test.tsx` — neuer Eintrag öffnet den Dialog.

## Doku (im selben PR)

- **README:** nutzer­sichtbare neue Funktion — im Abschnitt zur Sprachauswahl nachziehen
  („Sprache nachträglich pro Datei ändern — erfordert Neu-Transkription").
- **CLAUDE.md:** Fakt zur Architektur (Datei-Endpunkt-Paar + Trigger-Verzweigung), im Stil der
  bestehenden Sprachauswahl-Einträge.

## Nicht darin (YAGNI)

- Kein Undo für den Sprachwechsel (das Audio bleibt; wer die alte Sprache will, wählt sie neu).
- Kein Batch-Wechsel für mehrere Dateien (der Normal­fall ist eine Datei mit falscher Sprache).
- Keine Unterscheidung „geerbt vs. explizit" im Dialog (effektive Werte reichen; Noise durch
  Override-gleich-Standard wird durch das „nur bei Änderung"-PUT vermieden).
- Kein Fix des `projekt.json`-Races (#134).
