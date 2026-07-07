# Transkribor Web-Tool — Post-Merge-Plan (2026-07-07)

> **Ausgangslage:** Stufe 1→2b sind auf `master` (`fc32c6e`) gemerged, verifiziert
> verlustfrei, 60 Tests grün, Arbeitsbaum sauber. Dieser Plan ordnet die *verbleibende*
> Arbeit **nach Abhängigkeit**, nicht nach Wunschliste. Jede Aufgabe ist gegen den echten
> Code verankert (`Datei:Anker`) und adversarial auf Sequenz/Scope geprüft.

## Leitplanken
- **Treue vor Glätte** — ASR-Fehler korrigieren, nichts erfinden, Sinn nicht verändern.
- **Lokales Ein-Nutzer-Tool** — keine Multi-User-/Parallel-Annahmen; In-Memory-Job-Registry, Server nie mit `--reload` während Jobs.
- **Native-first** — Plattform/Stdlib vor Custom (z.B. `<input list>` statt Dropdown-Widget).
- **Kein neuer Dependency, kein API-Key** — Korrektur läuft über das Claude-Code-Abo (`claude -p`).

## Reihenfolge (abhängigkeits-getrieben)

```
P1  Dogfood (Ist-Zustand belegen)   ── BLOCKER, alles andere baut darauf
      │
      ▼
Phase 2  Korrektur-Kern härten
   2A  Glossar-Reuse-Guard + Stale-Tests   (entsperrt P2.1)
   2B  _run_claude-Vertragstest             (vor P2.1, das die Aufrufstellen vervielfacht)
   2C  Echtes Fehlersignal statt „grün trotz 0"
      │
      ▼
Phase 3  Editor-UX  (rein Frontend — parallel zu Phase 2 möglich)
   3A  Sprecher-Dropdown
   3B  Segment-Notizen/Anmerkungen-UI (optional)
      │
      ▼
P2.1  Per-Datei-Korrektur  ── ZULETZT, Mehrteiler mit Vorentscheidungen
      │
      ▼
Backlog  Cancel/Stop · Verifikations-Pass · transcribe-Tests · Stufe 3
```

**Warum diese Reihenfolge:** Der echte `claude -p`-Pfad (Stufe 2b) wurde **nie im Browser
geklickt** — alle Tests faken `_run_claude`. Erst den Ist-Zustand belegen (P1), *dann*
mutieren. Der Korrektur-Kern (`cmd_run`, `_run_claude`) wird von P2.1 vervielfacht, also
vorher härten (Phase 2). P2.2/3B sind reines Frontend und laufen parallel.

---

## P1 — Dogfood: den **unveränderten** ✎-Button belegen  ·  Aufwand: S  ·  ✅ ERLEDIGT (2026-07-07)

> **Ergebnis:** Bestanden. Mini-Demoprojekt `Demo-Dogfood` (frei erfunden, 4 Segmente
> Schweizerdeutsch) → ✎ im echten Browser geklickt → echter `claude -p`-Lauf in ~45s
> (`✓ Glossar: 6 Korrekturen → apply → run: fertig 1/1 [done]`). Korrektur einwandfrei
> (Beckerei→Bäckerei, „mir bache scho sit drü"→„wir backen schon seit drei",
> Ruggbrot→Roggenbrot, Suurteig→Sauerteig), Sprecher korrekt (Interviewer/Befragte Person),
> alle IDs erhalten. Badge wechselte auf ✎, Button ge-/entsperrt wie erwartet. Kein Bug.

**Ziel:** Beweisen, dass die 2b-Kette (prep → Glossar → pro Datei `claude -p` → apply) per
echtem Browser-Klick durchläuft — bevor irgendetwas daran geändert wird.

**Schritte / Touch-Points (kein Code-Edit):**
- `projekte/<Demo>/transkripte/<base>.json` + `<base>.raw.txt` — Mini-Demoprojekt mit **einer**
  Datei von Hand anlegen (kleines gültiges Whisper-JSON: `language`, `segments[]` mit
  `id/start/end/text/words` + passende `.raw.txt`). Spart GPU/Whisper. *(Anlegen erlaubt;
  bestehende `projekte/`-Daten nicht lesen.)*
- `webtool.ps1` — Server **ohne `--reload`** starten.
- `webtool/static/app.js:219` `startCorrect()` + `:34` Badge — nur beobachten.

**Akzeptanz:**
- ✎-Klick → `started=true`, `#jobstatus` zeigt Live-Log (`prep → Glossar → Korrigiere → fertig`).
- Danach existieren `<base>.correction.json / .edit.json / .md`; Badge wechselt auf ✎; Datei öffnet mit korrigiertem Text + Sprecher-Labels.
- Zweiter Klick während Lauf → „Es läuft bereits ein Job" (`started=false`).
- Beleg per Screenshot/Log (`browse`/`gstack`-Skill).

**Risiko/Realität:** löst **echte Opus-Calls** aus (Abo-Turn, Minuten, Kosten). Fällt ✎ durch,
ist das Ergebnis ein **Bugreport**, kein Merge — dann Root-Cause vor Phase 2.

---

## Phase 2 — Korrektur-Kern härten

### 2A — Glossar-Reuse-Guard + Stale-Tests (P2.3 + P3.2)  ·  Aufwand: S  ·  ✅ ERLEDIGT (2026-07-07)

> **Ergebnis (TDD):** Guard in `correct.py:_glossary` (reuse wenn `_glossar.json` ≥ `max(mtime aller .raw.txt)`, sonst neu). 3 Tests ergänzt: `test_run_reuses_fresh_glossary` (RED→GREEN, war der Treiber), `test_run_regenerates_stale_glossary`, `test_run_reruns_stale_correction` (Coverage für den bestehenden correction-Stale-Zweig). Suite **60→63 grün**. Noch uncommittet auf master → gehört auf einen Feature-Branch.


**Ziel:** `_glossar.json` nicht bei jedem Lauf neu per Opus bauen; spiegelt den bereits
existierenden `correction.json`-mtime-Guard. **Entsperrt P2.1** (sonst feuert jeder
Per-Datei-Klick einen vollen Korpus-Glossarlauf).

**Touch-Points:**
- `webtool/correct.py:214` `_glossary()` (vor `_run_claude` `:225`) — Reuse-Guard einbauen:
  wenn `_glossar.json` existiert **und** `getmtime(gpath) >= max(getmtime(f) for f in raw_files)`
  → laden + zurückgeben, `_run_claude` überspringen (Log „nutze vorhandenes _glossar.json").
  ⚠️ Schlüssel = **max über ALLE `.raw.txt`** (Glossar ist korpus-weit → stale, sobald *irgendeine*
  Roh-Datei neuer ist). Reiner `exists`-Guard wäre falsch.
- `webtool/test_correct.py` — zwei Tests am selben Reuse-Block:
  - `test_run_reruns_stale_correction`: `correction.json` schreiben, dann `os.utime(raw_json,(t+10,t+10))`
    → `correct.py:257`-Else-Zweig (Stale) abdecken (heute nur der Reuse-Zweig getestet).
  - Analog für `_glossar.json` (Reuse + Stale).
  ⚠️ mtime-Flakiness: raw-mtime **explizit** per `os.utime` nach vorn setzen, nicht auf Auflösung verlassen.

**Akzeptanz:** 2. Lauf ohne geänderte `.raw.txt` ⇒ kein Opus-Glossar-Call; neuere `.raw.txt` ⇒ Neu-Bau; fehlendes/ungültiges `_glossar.json` ⇒ wie bisher ohne Glossar weiter (keine Regression).

### 2B — `_run_claude`-Vertragstest + Fehlerzweige (P3.1)  ·  Aufwand: M  ·  ✅ ERLEDIGT (2026-07-07)

> **Ergebnis:** 4 Coverage-Tests (`subprocess.run`/`_claude_exe` gefälscht): argv + cwd-Confinement + stdin + timeout, plus die drei Fehlerzweige (fehlende Exe → still, `returncode≠0` → geloggt, `TimeoutExpired` → gefangen). Kein Produktionscode. Commit `c57d806`.


**Ziel:** Die 2b-Kernmechanik automatisiert absichern, **bevor P2.1 die Aufrufstellen vervielfacht**.
Kein echter `claude`-Lauf (das ist P1) — `subprocess.run` faken.

**Touch-Points:**
- `webtool/test_correct.py` (Muster `:102`): `monkeypatch` auf `correct.subprocess.run` (capture) +
  `correct._claude_exe`. Assert: `cmd` = `[exe,'-p','--model','opus','--permission-mode','acceptEdits',
  '--allowedTools','Read,Write','--add-dir',projekte_root]`, `cwd==projekte_root`, `input==prompt`,
  `timeout==900`, `text=True`. `creationflags` nur auf `nt`.
- `_claude_exe()` `correct.py:122` — (a) gefunden → Pfad; (b) `which`→None → `FileNotFoundError`
  **wird still geschluckt** (`correct.py:138`) — genau der Silent-Failure-Modus testen.

**Akzeptanz:** argv/cwd/stdin/timeout-Vertrag belegt; `_claude_exe`-Zweige belegt; **kein** echter Prozess/Netz/Opus in CI.

### 2C — Echtes Fehlersignal statt „grün trotz 0 Korrekturen"  ·  Aufwand: S–M  ·  ✅ ERLEDIGT (2026-07-07)

> **Ergebnis:** `main()`-`run`-Zweig exitet `1`, wenn Dateien versucht (nicht `human_edited`) aber 0 korrigiert wurden → Job wird Fehler statt „done". „Nichts zu tun" bleibt Erfolg (kein Fehlalarm). 3 CLI-Tests. Commit `0d959a4`. (Nur der Aggregat-Exit; `_run_claude` bleibt pro Aufruf bewusst still.)


**Ziel:** Heute liefert `cmd_run` Exit 0 / Job-Status `done` auch bei **0/N** korrigiert — z.B.
`claude` nicht auf PATH → `FileNotFoundError` geschluckt (`correct.py:138`), jede Datei skippt,
Job **grün trotz Totalausfall**. Ein distinktes Signal einführen.

**Touch-Points:**
- `webtool/correct.py` `cmd_run` — bei `done==0 && total>0` non-zero Exit / klare Fehlerzeile;
  `_run_claude` sollte „Exe fehlt" von „claude lief, schrieb aber nichts" unterscheidbar loggen.
- `webtool/jobs.py` — Fehl-Exit als solchen im Job-Status spiegeln (nicht als `done`).
- Test: PATH-loser Lauf ⇒ Fehlersignal, nicht `done`.

**Akzeptanz:** Lauf ohne `claude`/mit 0 Erfolgen erscheint im UI als Fehler, nicht als erfolgreich.

---

## Phase 3 — Editor-UX (rein Frontend, parallel zu Phase 2)

### 3A — Sprecher-Dropdown aus `doc.speakers` (P2.2)  ·  Aufwand: S  ·  ✅ ERLEDIGT (2026-07-07)

> **Ergebnis:** `renderSegments` baut `<datalist id=spk-options>` aus `Union(doc.speakers, alle seg.speaker)`, jedes Sprecher-Input via `list=`. Native Vorschläge + Freitext, kein `<select>` → kein stiller Werteverlust; neu getippte Sprecher werden bei commit ergänzt. Im Browser verifiziert (Optionen-Union, Freitext, dynamisch, Werterhalt); kein JS-Test-Harness im Repo.


**Ziel:** Spec §5.2 „Dropdown aus speakers + Freitext". Native `<input list>` + `<datalist>`.

**Touch-Points:**
- `webtool/static/app.js:71` `spk` → `spk.setAttribute('list','spk-options')`.
- `app.js:65` (renderSegments-Start) → einmal pro Doc `<datalist id="spk-options">` füllen.
- `webtool/edit_model.py:49/92` — **keine Änderung** (`speakers` wird schon befüllt).

⚠️ **Stille Sprecher-Verlust-Falle:** Optionen müssen `Union(doc.speakers, alle seg.speaker,
aktueller Wert)` sein — sonst wird ein Wert wie „Befragte Person" (nicht in `speakers`) beim
Rendern verloren. Freitext muss weiter möglich bleiben. Kleiner CSS-Check in `style.css`.

**Akzeptanz:** Vorschläge sichtbar + Freitext möglich; gesetzter Sprecher nie still zurückgesetzt; `speakers=[]` ⇒ normales Freitext-Input (keine Regression).

### 3B — Segment-Notizen/Anmerkungen-UI  ·  Aufwand: S  ·  optional

**Ziel:** Schema hat `seg.note` + doc-`annotations`, `render_md.py:27` exportiert sie unter
„## Anmerkungen" — aber der Editor hat **kein Eingabefeld**. „Unsicheres offenlegen" ist im
Browser nicht möglich.

**Touch-Points:** `webtool/static/app.js` renderSegments — pro Segment ein optionales `note`-Feld;
doc-level `annotations`-Feld. `markDirty`/`save` greifen bereits.

---

## P2.1 — Per-Datei-Korrektur  ·  Aufwand: M–L  ·  ✅ ERLEDIGT (2026-07-07)

> **Entscheidungen (Nutzer):** (a) Glossar korpus-weit reuse · (b) `jobs.py`-Dedupe bleibt pro Projekt · (c) Per-Datei-✎ korrigiert immer neu (bypasst Reuse-Guard), `human_edited` nur nach UI-Bestätigung → `--force`.
> **Umgesetzt:** `cmd_run(project, base=None, force=False)` + `run <project> [base] [--force]`; Endpoint `POST /api/projects/{p}/files/{base}/correct[?force=]` (404 bei unbekanntem base); Per-Datei-✎ im Editor (Confirm→`?force=true` bei has_edit). 2C-Fehlersignal respektiert Scope+force. **7 neue Tests** (Backend+API, Suite 70→77), Frontend browser-verifiziert (fetch-capture: scoped URL, force nur nach Confirm).


> **Kein Einzelticket.** Berührt 3 Schichten (correct.py, app.py, app.js) **plus** die
> jobs.py-Dedupe-Invariante. Erst Vorentscheidungen klären, dann bauen. Setzt **2A** voraus.

**Vorab-Entscheidungen (siehe „Offene Entscheidungen"):**
- **(a) Glossar-Scope Einzeldatei** — Korpus-Glossar wiederverwenden (empfohlen, braucht 2A) vs. neu bauen.
- **(b) jobs.py-Dedupe-Key** — `_active[project]` (`jobs.py:31/42`) serialisiert **heute** transcribe⇔correct
  pro Projekt und schützt vor der Stale-Raw-Race. **Key nicht** auf `project+base` ändern → sonst
  bricht diese Absicherung. Also: sequentiell pro Projekt, UX-Text „anderer Job läuft" anpassen.
- **(c) Force/Re-Korrektur-Semantik** — sonst **No-Op**: `cmd_run` reused gültige `correction.json`
  (`correct.py:257`) und **skippt `human_edited` hart** (`:252`) — genau die Dateien, für die man
  den Button will. Braucht „Neu korrigieren erzwingen" (an Spec §2 „nur nach expliziter Bestätigung").

**Touch-Points:**
- `webtool/app.py` (nach `:141`, Muster `get_file :96`) — `@app.post('/api/projects/{project}/files/{base}/correct')`;
  projektweiten Endpoint als Alias behalten.
- `webtool/correct.py:236` `cmd_run(project, base=None)` — bei `base`: `all_bases=[base]` (früh raus wenn unbekannt).
- `webtool/correct.py:284` run-Subparser — `base` als `nargs='?'` + `safe_name`.
- `webtool/static/app.js:31` Datei-Zeilen — kleiner Per-Datei-✎; `startCorrect` um base-Variante erweitern.
- `CLAUDE.md` §Umgebung 2b + `README.md` — neuen Endpoint nachziehen.

**Akzeptanz:** Endpoint/CLI korrigieren **nur** `<base>` (andere unangetastet); ohne `base` weiter
alle (Rückwärtskompatibilität, Bestandstests grün); unbekannter `base` → 400 ohne Traceback;
Isolations-Regressionstest (andere `correction.json` unangetastet, Glossar wiederverwendet).

---

## Backlog / später (priorisiert)

| Thema | Quelle | Warum relevant |
|---|---|---|
| **Cancel/Stop für Jobs** | Spec §11 | `jobs.py:41` hält `pid`, nutzt sie nie zum Kill. Ein projektweiter Lauf = N×900s Opus ohne Abbruch. |
| **Verifikations-/Treue-Pass im 2b-Pfad** | Spec §7 | 2b ist Single-Pass; nur `tools/correct_label.mjs` verifiziert gegen Roh. Halluzinationen gehen ungeprüft nach `.md`. **Entscheidung nötig:** in 2b integrieren vs. `correct_label.mjs` als separater Pfad belassen. |
| **`human_edited`-Re-Korrektur aus Browser** | Spec §2 | `--force` nur auf `apply`, nicht `run`/API. Deckt sich mit P2.1-(c). |
| **`transcribe.py`-Tests** | — | 0 Tests (skip-existing, ffmpeg-Discovery, 3 Ausgaben). GPU-unabhängige Teile testbar. |
| **§8-UI-Details** | Spec §8 | ⚙-Regler-Toggle, Zeit-Anzeige, globaler Play-Button, Einfachklick-Play, rAF-Highlight, Waveform-Regionen. |
| **Stufe 3** | Roadmap | pyannote-Diarization, Wort-Karaoke, weitere Export-Formate. ASR bleibt large-v3. |

---

## Offene Entscheidungen (brauchen dich)

1. **P2.1-Semantik** (vor Implementierung): (a) Glossar-Scope Einzeldatei, (b) Dedupe-Key bestätigen (Empfehlung: pro Projekt serialisiert lassen), (c) Force/Re-Korrektur-Verhalten.
2. **Verifikations-Pass:** in den 2b-`run`-Driver integrieren (ein zweiter `claude -p` je Datei, Treue-Check gegen Roh) — oder `correct_label.mjs` bleibt der „volle Kontrolle"-Pfad?
3. **Umfang jetzt:** nur bis Phase 3 (poliertes 2b) — oder inkl. P2.1 und Backlog-Punkte?

---

*Verankert gegen `master@fc32c6e`; Sequenz/Scope adversarial geprüft (2 Agenten). Aufwände S/M/L = grob < ½ Tag / ~1 Tag / > 1 Tag.*
