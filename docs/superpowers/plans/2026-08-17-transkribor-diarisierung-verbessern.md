# Sprechertrennung substanziell verbessern — Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die Sprechertrennung messbar machen und dann gezielt verbessern — statt Änderungen zu bauen, deren Wirkung niemand belegen kann.

**Architecture:** Drei Blöcke. Block A behebt zwei Fehler, die keine Messung brauchen (#266 toter Schalter, #267 fehlende Prompt-Regel). Block B baut `tools/diar_eval.py`: ein Werkzeug, das eine eingefrorene Referenz gegen eine Diarisierungs-Konfiguration hält und drei Zahlen liefert. Block C fährt damit Kandidaten durch — nur was gegen den Nullpunkt gewinnt und die Positivkontrollen nicht verschlechtert, wird übernommen.

**Tech Stack:** Python 3.13 (`.venv`), pyannote.audio 4.0.7 + torch cu128 (GPU), FastAPI, pytest · React 19 + TypeScript + vitest · scikit-learn und scipy (liegen als pyannote-Abhängigkeiten bereits vor — in dieser Arbeit ausgeführt, nicht angenommen)

**Spec:** `docs/superpowers/specs/2026-08-17-transkribor-diarisierung-verbessern-design.md`

## Global Constraints

Diese gelten für **jede** Aufgabe unten; sie werden dort nicht wiederholt.

- **Das Audio verlässt den Rechner nicht** (Marcus, 2026-08-17). Keine Cloud-API, kein `precision-2`, kein Hochladen zu Diagnosezwecken.
- **Nie nach `projekte\` schreiben.** Messläufe rufen `diarize.diarize_file` direkt, **nie** `correct.cmd_diarize` — letzteres legt Sidecars in echtem Material an. Wegwerf-Projekte für Funktionstests, danach löschen.
- **`eval/` ist gitignoriert** und wird nie committet — das sind Interviewinhalte (Repo-Regel: „`projekte\`-Inhalte bleiben lokal, nie committen"). Das *Werkzeug* wird committet, seine Tests laufen auf **synthetischen** Daten.
- **Die CI braucht dafür zwei neue Pakete.** Sie installiert heute nur `fastapi python-multipart pytest httpx`; `scipy`/`scikit-learn` kommen lokal **nur transitiv über pyannote** und stehen in keiner `requirements.txt`. Ohne sie fallen die Metrik-Tests mit `ModuleNotFoundError` um — die Zusage „die CI prüft das Werkzeug" wäre nicht bloss unerfüllt, der Lauf wäre **rot**. Die schlanke Installation ist dort ausdrücklich ein **Wächter** gegen Modulebenen-Importe von torch/pyannote (Kommentar in `test.yml:57-64`); scipy und sklearn sind nicht torch, der Wächter bleibt scharf — das gehört als Begründung dazu.
- **Jeder Fix bekommt einen mutationsgeprüften Test:** Logik raus → genau dieser Test rot → sauber zurückspielen. Nach einer Mutationsserie `find webtool -name __pycache__ -type d -exec rm -rf {} +`.
- **Reviewkette in fester Reihenfolge:** `superpowers:requesting-code-review` ZUERST, dann CodeRabbit (CLI, dann Bot — den PR-**Kommentar** lesen, nicht die Prüfspalte).
- **Lokaler Funktionstest vor „fertig".** Frontend im Browser, Backend über den echten Pfad. Berichtet wird, was gemessen wurde.
- **README wird im selben PR nachgezogen**, wenn sich für den Nutzer etwas ändert.
- **Offene Punkte werden GitHub-Issues**, bevor die Arbeit als fertig gemeldet wird.
- **Vor jedem Modellwechsel drei Prüfungen, keine Annahmen:** Weitergabe-Lizenz (das jetzige Modell ist CC-BY-4.0, steht in `LICENSE-MODELLE.md`), Lauffähigkeit auf **Apple Silicon** (der Mac-Pfad ist bewusst Hugging-Face-frei), Paketgrösse gegen die **2-GB-Grenze** für Release-Assets.
- **Standard-Flow:** Feature-Branch → PR gegen `master` → Rebase-Merge. Nie direkt auf `master`. `git add -A` ist gesperrt.

## Dateien

| Datei | Verantwortung | Block |
|---|---|---|
| `webtool/correct.py` | `_diarize_enabled` → `diarize_enabled` (öffentlich); vier Prompts tragen die Cluster-Regel | A |
| `webtool/app.py` | `diarisierung_aktiv` im Datei-Einstellungs-GET | A |
| `webtool/frontend/src/lib/types.ts` | `DateiEinstellungen.diarisierung_aktiv` | A |
| `webtool/frontend/src/components/DateiEinstellungenDialog.tsx` | Feld deaktivieren + Hilfetext | A |
| `README.md` | Vorbehalt im Abschnitt „Es hat zu wenige Sprecher erkannt" | A |
| `tools/diar_eval.py` | **neu** — Metriken, `freeze`, `run`, `vergleich` | B |
| `webtool/test_diar_eval.py` | **neu** — Unit-Tests der Metriken, synthetisch | B |
| `.gitignore` | `eval/` | B |
| `webtool/diarize.py` | Konfigurations-Fingerabdruck (erst in Block C, mit dem ersten Gewinner) | C |

`tools/diar_eval.py` ist bewusst **ein** Modul: die drei Unterbefehle teilen sich Referenzformat und Metriken, und getrennte Dateien liefen beim nächsten Umbau auseinander. Es bleibt unter `tools/` statt in `webtool/`, weil es kein Teil des Produkts ist — es wird nie vom Server importiert.

---

# Block A — die zwei Fixes ohne Messbedarf (PR 1)

Hängt nicht an Block B und wartet nicht auf Marcus' Referenzarbeit.

## Task 1: `diarize_enabled` öffentlich machen

**Files:**
- Modify: `webtool/correct.py:184-185` (Definition), `:148`, `:194`, `:752` (Aufrufe)
- Test: `webtool/test_correct.py`

**Interfaces:**
- Produces: `correct.diarize_enabled() -> bool` — liest `TRANSKRIBOR_DIARIZE`, alles ausser `0`/`false`/`no` (case-insensitiv, getrimmt) heisst an. Task 2 importiert sie aus `app.py`.

- [ ] **Step 1: Umbenennen, alle vier Stellen**

In `webtool/correct.py` die Definition:

```python
def diarize_enabled() -> bool:
    """Ist die akustische Sprechertrennung eingeschaltet? (`TRANSKRIBOR_DIARIZE`)

    Oeffentlich, weil `app.py` sie beantwortet: der Datei-Einstellungs-Dialog zeigt sonst ein
    Feld an, das nichts tut (#266). Eine zweite Kopie der Regel dort waere die Divergenzfalle —
    dieselbe Regel an zwei Orten laeuft beim naechsten Umbau auseinander.
    """
    return os.environ.get("TRANSKRIBOR_DIARIZE", "1").strip().lower() not in ("0", "false", "no")
```

Und die drei Aufrufstellen `_diarize_enabled()` → `diarize_enabled()` (Zeilen 148, 194, 752).

- [ ] **Step 2: Prüfen, dass kein Aufruf übrig ist**

Run: `grep -rn "_diarize_enabled" webtool/ tools/`
Expected: keine Treffer.

- [ ] **Step 3: Tests laufen lassen**

Run: `.venv/Scripts/python.exe -m pytest webtool/test_correct.py -q`
Expected: PASS (reine Umbenennung, kein Verhalten geändert).

- [ ] **Step 4: Commit**

```bash
git add webtool/correct.py
git commit -m "refactor(correct): diarize_enabled wird oeffentlich (Vorbereitung #266)"
```

---

## Task 2: `diarisierung_aktiv` im Datei-Einstellungs-GET

**Files:**
- Modify: `webtool/app.py:14-26` (Import), `:359-379` (Handler)
- Test: `webtool/test_api.py` (bei den übrigen `dateieinstellungen`-Tests, ab Z. 1450)

**Interfaces:**
- Consumes: `correct.diarize_enabled()` aus Task 1
- Produces: `GET /api/projects/{p}/files/{base}/einstellungen` enthält `diarisierung_aktiv: bool`. Task 3 (Frontend) liest genau diesen Schlüssel.

- [ ] **Step 1: Den fehlschlagenden Test schreiben**

In `webtool/test_api.py`, hinter `test_dateieinstellungen_liefert_effektive_werte`:

```python
def test_dateieinstellungen_meldet_ob_diarisierung_laeuft(client, tmp_projekt, monkeypatch):
    """Ohne diese Auskunft zeigt der Dialog ein Feld an, das nichts tut (#266).

    BEIDE Richtungen, nicht nur die interessante: ein Feld, das IMMER „aus" meldet, ist
    derselbe Schaden von der anderen Seite — der Nutzer koennte die Sprecherzahl dann nie
    mehr setzen. Die Mutation „fest auf False" macht die erste Zusicherung rot.
    """
    monkeypatch.delenv("TRANSKRIBOR_DIARIZE", raising=False)
    r = client.get(f"/api/projects/{tmp_projekt}/files/S1/einstellungen")
    assert r.json()["diarisierung_aktiv"] is True

    monkeypatch.setenv("TRANSKRIBOR_DIARIZE", "0")
    r = client.get(f"/api/projects/{tmp_projekt}/files/S1/einstellungen")
    assert r.json()["diarisierung_aktiv"] is False
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `.venv/Scripts/python.exe -m pytest webtool/test_api.py::test_dateieinstellungen_meldet_ob_diarisierung_laeuft -q`
Expected: FAIL mit `KeyError: 'diarisierung_aktiv'`

- [ ] **Step 3: Handler erweitern**

In `webtool/app.py` zu den Importen (alphabetisch vor `from . import device`):

```python
# `as _correct` ist PFLICHT, nicht Stil: `app.py:742` definiert `def correct(project)` (den
# Endpunkt). Ein unaliasiertes `from . import correct` wuerde davon ueberschrieben, und
# `correct.diarize_enabled()` liefe erst zur REQUEST-Zeit in einen AttributeError — kein Test
# beim Start, kein Fehler beim Import, ein 500er im Betrieb. Nicht "aufraeumen".
from . import correct as _correct
```

**Gegengeprüft im Review, damit es niemand erneut prüft:** kein Zirkelimport (alle sechs Modulkopf-Importe von `correct.py` — `llm`, `paths`, `settings`, `sprachen`, `edit_model`, `render_md` — importiert `app.py` bereits, und keines importiert `app`), und die Kosten sind **8,4 ms** einmalig beim Serverstart (gemessen, auf den vorhandenen App-Importen aufgesetzt).

Im Handler `dateieinstellungen` das Rückgabe-Dict ergänzen:

```python
    # `diarisierung_aktiv` ist wie `sprecher_max` ein reiner Server-Wert, der mitreist: das
    # Feld „Anzahl Sprecher" ist ohne Diarisierung ein toter Schalter (#266). Die Auskunft ist
    # belastbar, weil `settings.job_env()` nur WHISPER_MODEL/WHISPER_LANG setzt — der
    # correct-Subprozess liest exakt denselben Wert wie dieser Server.
    return {**_projekt.datei_ansicht(project, base),
            "sprach_choices": _sprachen.fuer_frontend(), "tiefen": _sprachen.TIEFEN,
            "sprecher_max": _sprachen.SPRECHER_MAX,
            "diarisierung_aktiv": _correct.diarize_enabled()}
```

- [ ] **Step 4: Test laufen lassen, Erfolg bestätigen**

Run: `.venv/Scripts/python.exe -m pytest webtool/test_api.py -q`
Expected: PASS, alle.

- [ ] **Step 5: Mutationsprobe**

`diarisierung_aktiv` fest auf `False` setzen → Test läuft → **muss rot sein** (erste Zusicherung). Zurückspielen, `__pycache__` leeren, erneut laufen lassen.

Run: `.venv/Scripts/python.exe -m pytest webtool/test_api.py::test_dateieinstellungen_meldet_ob_diarisierung_laeuft -q`

- [ ] **Step 6: Commit**

```bash
git add webtool/app.py webtool/test_api.py
git commit -m "feat(api): Datei-Einstellungen melden, ob die Diarisierung laeuft (#266)"
```

---

## Task 3: Das Feld sagt es an, statt zu lügen

**Files:**
- Modify: `webtool/frontend/src/lib/types.ts:62-77`
- Modify: `webtool/frontend/src/components/DateiEinstellungenDialog.tsx:239-254`
- Modify: `webtool/frontend/src/components/DateiEinstellungenDialog.test.tsx:7-23` (`BASIS`)
- Modify: `README.md` (Abschnitt „Es hat zu wenige Sprecher erkannt", ~Z. 252-260)
- Test: `webtool/frontend/src/components/DateiEinstellungenDialog.test.tsx`

**Interfaces:**
- Consumes: `diarisierung_aktiv: boolean` aus Task 2

- [ ] **Step 1: Typ erweitern — und ALLE Attrappen suchen**

In `types.ts` innerhalb von `DateiEinstellungen`:

```ts
  /** Ist der Kill-Switch `TRANSKRIBOR_DIARIZE` AN? Dann kehrt `cmd_diarize` sofort zurueck,
   *  und das Feld „Anzahl Sprecher" waere ein Schalter, der gespeichert wird und nichts tut
   *  (#266).
   *
   *  Beantwortet AUSDRUECKLICH nicht „laeuft die Sprechertrennung wirklich": fehlt pyannote
   *  oder ist die GPU voll, steht hier `true` und es passiert trotzdem nichts. Dieselbe
   *  Trennung wie bei `llm.available()` („Installiert != angemeldet") — dort wurde sie
   *  spaeter nachgezogen, hier ist sie als Issue festgehalten. Der Hilfetext im Dialog nennt
   *  deshalb `TRANSKRIBOR_DIARIZE` beim Namen und behauptet nichts Weitergehendes. */
  diarisierung_aktiv: boolean
```

Danach **jede** Attrappe finden, die `DateiEinstellungen` erfüllt — ein fehlendes Pflichtfeld wirft erst beim Bauen (`tsc -b`), nicht im vitest-Lauf:

Run: `grep -rn "getFileEinstellungen'\)\.mockResolvedValue\|: DateiEinstellungen" webtool/frontend/src`

In `DateiEinstellungenDialog.test.tsx` `BASIS` ergänzen um `diarisierung_aktiv: true,`.

- [ ] **Step 2: Den fehlschlagenden Test schreiben**

In `DateiEinstellungenDialog.test.tsx`, im `describe('… Sprecherzahl (#264)')`:

```tsx
  it('sperrt das Feld und sagt es an, wenn die Diarisierung aus ist (#266)', async () => {
    // Vorher: der Dialog nahm die Zahl entgegen, speicherte sie, meldete „Speichern & neu
    // korrigieren" und startete einen Lauf, der die Sprechertrennung nie anfasst — waehrend
    // der Hilfetext ausdruecklich versprach, es „trennt die Stimmen deutlich zuverlaessiger".
    vi.spyOn(api, 'getFileEinstellungen')
      .mockResolvedValue({ ...BASIS, diarisierung_aktiv: false, sprecher: 4 })
    render(<DateiEinstellungenDialog project="p" base="a" file={datei()} offen />)
    await sprachWaehlerDa()
    expect(feld()).toBeDisabled()
    // Der gespeicherte Wert bleibt SICHTBAR — verstecken hiesse, ihn kommentarlos zu
    // verschlucken; der Nutzer soll sehen, was dasteht und warum es nicht wirkt.
    expect(feld()).toHaveValue('4')
    expect(screen.getByText(/auf diesem Server abgeschaltet/)).toBeInTheDocument()
    expect(screen.queryByText(/zuverlässiger/)).not.toBeInTheDocument()
  })

  it('laesst das Feld bedienbar, solange die Diarisierung laeuft (#266)', async () => {
    // Gegenprobe: ein Feld, das IMMER gesperrt ist, ist derselbe Schaden von der anderen
    // Seite. Ohne diese Zusicherung bliebe die Mutation „disabled fest auf true" gruen.
    vi.spyOn(api, 'getFileEinstellungen').mockResolvedValue(BASIS)
    render(<DateiEinstellungenDialog project="p" base="a" file={datei()} offen />)
    await sprachWaehlerDa()
    expect(feld()).not.toBeDisabled()
    expect(screen.getByText(/zuverlässiger/)).toBeInTheDocument()
  })
```

- [ ] **Step 3: Test laufen lassen, Fehlschlag bestätigen**

Run: `npm --prefix webtool/frontend run test -- DateiEinstellungenDialog`
Expected: FAIL — das Feld ist nicht deaktiviert, der Text fehlt.

- [ ] **Step 4: Dialog anpassen**

In `DateiEinstellungenDialog.tsx` vor dem `return`:

```tsx
  // `=== false` statt `!…`: der Typ sagt „Pflichtfeld", aber der Typ ist der VERTRAG, nicht
  // die Garantie — Server und Bundle sind getrennt, ein aelterer Server liefert `undefined`.
  // Das muss „laeuft" heissen: der Rueckfall geht zum bisherigen Verhalten, nicht in eine
  // Sperre, die niemand aufheben kann.
  const diarAus = data?.diarisierung_aktiv === false
```

Am `<input id="fs-sprecher" …>` ergänzen: `disabled={diarAus}` und
`className="… disabled:cursor-not-allowed disabled:opacity-50 …"` (an die bestehende Klassenliste anhängen).

Den Hilfetext ersetzen:

```tsx
              <p id="fs-sprecher-hilfe" className="mt-1.5 text-sm text-muted-foreground">
                {diarAus
                  ? 'Die Sprechertrennung ist auf diesem Server abgeschaltet '
                    + '(TRANSKRIBOR_DIARIZE=0) — die Zahl hätte hier keine Wirkung.'
                  : sprecherWahl === undefined
                  ? `Bitte eine ganze Zahl von 1 bis ${sprecherMax} eintragen — oder leer lassen.`
                  : 'Leer lassen heisst automatisch erkennen. Wer weiss, wie viele Personen '
                    + 'gesprochen haben, trägt es hier ein — das trennt die Stimmen deutlich '
                    + 'zuverlässiger, vor allem bei Aufnahmen mit einem Kameramikrofon.'}
              </p>
```

- [ ] **Step 5: Test laufen lassen, Erfolg bestätigen**

Run: `npm --prefix webtool/frontend run test -- DateiEinstellungenDialog`
Expected: PASS

- [ ] **Step 6: Typprüfung — `tsc --noEmit` reicht NICHT**

Die `tsconfig.json` an der Frontend-Wurzel ist eine reine Solution-Datei; `tsc --noEmit` prüft dort **nichts** und meldet Exit 0. Geprüft wird per `tsc -b`:

Run: `npm --prefix webtool/frontend run build`
Expected: Exit 0. Bricht es an einer `as DateiEinstellungen`-Attrappe ab, fehlt dort das neue Pflichtfeld (Step 1).

- [ ] **Step 7: Mutationsprobe, beide Richtungen einzeln**

`disabled={diarAus}` → `disabled={false}` ⇒ erster Test rot. Zurück. `disabled={true}` ⇒ zweiter Test rot. Zurück, Tests grün.

- [ ] **Step 8: README nachziehen**

Im Abschnitt „**Es hat zu wenige Sprecher erkannt — was tun?**" (~Z. 252) hinter der Erklärung des Feldes einen Satz ergänzen:

```markdown
Steht das Feld grau und meldet, die Sprechertrennung sei abgeschaltet, dann läuft Transkribor
mit `TRANSKRIBOR_DIARIZE=0` — dann werden die Sprecher allein aus dem Gesprächsverlauf
erschlossen, und die Zahl ändert daran nichts.
```

- [ ] **Step 9: Lokaler Funktionstest im Browser**

Wegwerf-Projekt anlegen (**nicht** in `projekte\` arbeiten). Server einmal normal starten und den Dialog öffnen (Feld bedienbar, Text „zuverlässiger"), dann mit `TRANSKRIBOR_DIARIZE=0` neu starten und denselben Dialog öffnen (Feld grau, neuer Text). Screenshot beider Zustände. Danach das Wegwerf-Projekt löschen.

- [ ] **Step 10: Commit**

```bash
git add webtool/frontend/src/lib/types.ts \
        webtool/frontend/src/components/DateiEinstellungenDialog.tsx \
        webtool/frontend/src/components/DateiEinstellungenDialog.test.tsx README.md
git commit -m "fix(dialog): Sprecherzahl-Feld sagt an, wenn die Diarisierung aus ist (#266)"
```

---

## Task 4: Die Zusammenlege-Erlaubnis in alle vier Prompts

**Files:**
- Modify: `webtool/correct.py:499` (`_correct_prompt` Regel 4), `:549` (`_verify_prompt`), `:588` (`_light_prompt`), `:607` (`_summary_prompt`)
- Test: `webtool/test_correct.py`

**Interfaces:**
- Produces: `correct.CLUSTER_REGEL` — ein Modulkonstante-String, den alle vier Prompts einbetten. Task 5 misst gegen ihn.

- [ ] **Step 1: Den fehlschlagenden Test schreiben**

In `webtool/test_correct.py` bei den übrigen Prompt-Tests:

```python
def test_alle_umbenennenden_prompts_erlauben_zwei_cluster_pro_person():
    """Die Erlaubnis stand seit 328ebf2 NUR in _correct_prompt — und der Treue-Pass schreibt
    ZULETZT. Dieselbe Falle wie bei `[Musik]` und der Fremdsprachen-Regel: was der Verify-Pass
    nicht als erlaubt kennt, dreht er als Fehlzuordnung zurueck.

    `_summary_prompt` ist hier ANDERS als bei der Mehrsprachig-Regel dabei: die laesst es
    bewusst aus (seine Segmente haben keinen text-Schluessel, es gibt nichts zu uebersetzen) —
    Sprecher vergibt es aber sehr wohl, also gilt die Cluster-Regel dort.
    """
    prompts = {
        "correct": correct._correct_prompt("b", "t.txt", "c.json", "g.json", "kontext"),
        "verify":  correct._verify_prompt("b", "t.txt", "c.json", "kontext"),
        "light":   correct._light_prompt("b", "t.txt", "c.json", "kontext"),
        "summary": correct._summary_prompt("b", "t.txt", "c.json", "kontext"),
    }
    for name, p in prompts.items():
        assert correct.CLUSTER_REGEL in p, f"{name}-Prompt traegt die Cluster-Regel nicht"


def test_cluster_regel_nennt_den_gemessenen_grund():
    """Eine blosse Erlaubnis reichte nicht — sie stand da, und die Aufspaltung passierte
    trotzdem (#267, gemessen an Rhyathlon/00114307 mit vorgegebener Sprecherzahl 5). Die Regel
    nennt deshalb das konkrete Erkennungsmerkmal, nicht nur die Befugnis.
    """
    assert "Kameramikrofon" in correct.CLUSTER_REGEL
    assert "Frageform" in correct.CLUSTER_REGEL
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `.venv/Scripts/python.exe -m pytest webtool/test_correct.py -k cluster -q`
Expected: FAIL mit `AttributeError: module 'webtool.correct' has no attribute 'CLUSTER_REGEL'`

- [ ] **Step 3: Konstante anlegen und in alle vier Prompts einsetzen**

In `webtool/correct.py` bei den übrigen Modulkonstanten:

```python
# Die EINE Fassung der Cluster-Regel, eingebettet in alle vier Prompts, die Sprecher vergeben.
# Vier Kopien liefen beim naechsten Umbau auseinander — und ausgerechnet der Verify-Pass, der
# ZULETZT schreibt, haette dann die Fassung ohne Erlaubnis (genau der Zustand vor #267).
# Der zweite Satz ist nicht Beiwerk: die blosse Erlaubnis stand seit 328ebf2 in
# _correct_prompt, und die Aufspaltung passierte trotzdem — es fehlte das Erkennungsmerkmal.
CLUSTER_REGEL = (
    "Ein Cluster-Wechsel heisst: die STIMME wechselt — nicht zwingend die PERSON. Bei "
    "Aufnahmen mit einem Kameramikrofon verteilt die Diarisierung denselben Menschen "
    "regelmaessig auf mehrere Cluster; sprechen zwei Cluster durchweg in Frageform, ist das "
    "derselbe Interviewer. Zwei Cluster denselben Namen zu geben ist deshalb eine ERLAUBTE "
    "Entscheidung, KEINE Fehlzuordnung."
)
```

**Die Regel ERSETZT die widersprechende Anweisung, sie steht NICHT daneben.** Das ist der Kern dieser Aufgabe und der Grund, warum die blosse Erlaubnis seit `328ebf2` wirkungslos blieb: Regel 4 beginnt heute mit „Das akustische (Sprecher N)-Präfix ist **die WAHRHEIT, WER spricht**" — und zwei Sätze später stünde „das Präfix teilt Menschen auf". Genau diese Form hat dieses Repo beim Mehrsprachig-Fix bewusst verworfen; die Begründung steht wörtlich in `correct.py:473-478` („Ein Prompt mit zwei sich widersprechenden Anweisungen ist genau die Form, an der die [Musik]-Regel schon einmal hängengeblieben ist").

In `_correct_prompt` wird Regel 4 deshalb **am Kopf** geändert — „ist die WAHRHEIT, WER spricht" fällt weg:

```
4) SPRECHER: Das akustische (Sprecher N)-Präfix sagt, WANN die Stimme wechselt — vergib pro Cluster GENAU EINEN konsistenten Namen: meist „Interviewer“ (stellt Fragen) und die befragte Person (Name/Betrieb falls genannt, sonst „Befragte Person“). {CLUSTER_REGEL} Eine Cluster-Grenze nur überschreiben, wenn sie offensichtlich falsch ist (z.B. ein einzelnes Rückkanal-Wort). Fehlt das Präfix, ordne nach Inhalt zu (wie bisher). Gib JEDEM Segment einen Sprecher.
```

In `_verify_prompt` fällt aus derselben Erwägung „Fehlzuordnungen korrigieren" als pauschaler Auftrag weg — er ist es, der die Zusammenlegung als Fehler liest:

```
- SPRECHER: konsistent pro akustischem (Sprecher N)-Cluster und plausibel (Interviewer stellt Fragen; Antworten korrekt zugeordnet)? {CLUSTER_REGEL} Falsch zugeordnete Segmente korrigieren, aber zwei Cluster mit demselben Namen NICHT auseinanderziehen — nur pruefen, ob es zutrifft.
```

In `_light_prompt` Schritt 3 und `_summary_prompt` Schritt 2 jeweils `{CLUSTER_REGEL}` an den Satz über die Namensvergabe anhängen (dort steht keine widersprechende Anweisung, die zu ersetzen wäre — nachgesehen: beide sagen nur „vergib pro Cluster einen konsistenten Namen").

**Zusätzlicher Wächter**, weil die Ersetzung sonst beim nächsten Umbau zurückfallen kann:

```python
def test_correct_prompt_nennt_das_cluster_praefix_nicht_mehr_die_wahrheit():
    """Die Erlaubnis stand seit 328ebf2 da und wirkte NICHT — weil zwei Saetze darueber
    „das Praefix ist die WAHRHEIT, WER spricht" stand. Dieselbe Form, gegen die
    correct.py:473-478 beim Mehrsprachig-Fix ausdruecklich entschieden hat: die Regel ERSETZT
    die widersprechende Anweisung, sie steht nicht daneben.
    """
    p = correct._correct_prompt("b", "t.txt", "c.json", "g.json", "kontext")
    assert "WAHRHEIT, WER spricht" not in p
```

- [ ] **Step 4: Test laufen lassen, Erfolg bestätigen**

Run: `.venv/Scripts/python.exe -m pytest webtool/test_correct.py -q`
Expected: PASS, alle.

- [ ] **Step 5: Mutationsprobe — jeder Prompt einzeln**

`{CLUSTER_REGEL}` nacheinander aus je **einem** der vier Prompts entfernen ⇒ der erste Test muss jedes Mal rot werden und **den Namen des betroffenen Prompts nennen**. Danach „Kameramikrofon" aus der Konstante nehmen ⇒ zweiter Test rot. Zuletzt den Kopf von Regel 4 auf die alte Fassung zurücksetzen („ist die WAHRHEIT, WER spricht") ⇒ dritter Test rot. Alles zurückspielen.

**Gegengeprüft, GEMESSEN im Review:** diese Prompt-Änderung macht **keinen** bestehenden Test rot (78/78 grün). Die drei Constraint-Tests, die den Prompt-Wortlaut festnageln (`test_korrektur_prompt_ohne_mehrsprachig_unveraendert`, `test_leicht_prompt_ohne_mehrsprachig_unveraendert`, `test_summary_prompt_bleibt_ohne_regel`) zielen alle auf **andere** Stellen (Regel 2, Überschrift, „MEHRSPRACHIG") und bleiben grün.

Run: `find webtool -name __pycache__ -type d -exec rm -rf {} +` und die Suite erneut.

- [ ] **Step 6: Commit**

```bash
git add webtool/correct.py webtool/test_correct.py
git commit -m "fix(correct): alle vier Sprecher-Prompts erlauben zwei Cluster je Person (#267)"
```

---

## Task 5: Messen, ob der Treue-Pass die Zusammenlegung wirklich zurückdrehte

Der Fix aus Task 4 steht auf einer **Herleitung** aus dem Prompttext (Spec 4.2). Diese Aufgabe belegt oder widerlegt sie — und der Fix bleibt in beiden Fällen bestehen (Konsistenz über alle Prompts), nur die Wirkungsbehauptung hängt davon ab.

**Files:**
- Nur Messung, keine Quelländerung. Protokoll ins Scratchpad.

- [ ] **Step 1: Wegwerf-Projekt aus einer Kopie anlegen**

```bash
SRC="/c/Users/marcu/AppData/Roaming/Transkribor/projekte/Rhyathlon"
DST="E:/Git/Transkribor/projekte/ZZ-diar-probe"
mkdir -p "$DST/audio" "$DST/transkripte"
cp "$SRC/audio/00114307.mp3" "$DST/audio/"
cp "$SRC/transkripte/00114307.json" "$DST/transkripte/"
```

Nur `.json` mitkopieren — **keine** `edit.json`/`correction.json`, sonst überspringt der Lauf die Datei.

- [ ] **Step 2: Sprecherzahl 5 setzen (der Fall aus #267)**

```bash
.venv/Scripts/python.exe -c "from webtool import projekt; projekt.setze_datei('ZZ-diar-probe','00114307',sprecher=5)"
```

- [ ] **Step 3: Lauf auf dem Stand VOR Task 4 (Negativkontrolle)**

**Nicht `git stash`** — Task 4 Step 6 hat die Prompt-Änderung bereits committet, und `git stash` fasst Committetes nicht an. Der „Vorher"-Lauf liefe damit **mit** dem Fix, die Negativkontrolle wäre wertlos und meldete zwangsläufig „kein Unterschied". Stattdessen die Datei gezielt auf den Vorstand holen:

```bash
git checkout HEAD~1 -- webtool/correct.py
.venv/Scripts/python.exe -m webtool.correct run ZZ-diar-probe
```

Danach die Cluster→Name-Tabelle ziehen (dasselbe Muster wie in der Voruntersuchung): trägt der Interviewer in **zwei** Clustern denselben Namen, oder zwei verschiedene? Ergebnis notieren, `correction.json`/`edit.json`/`diar.json` beiseitelegen.

- [ ] **Step 4: Lauf MIT Task 4**

`git checkout HEAD -- webtool/correct.py`, abgeleitete Dateien im Wegwerf-Projekt löschen (`*.correction.json`, `*.edit.json`, `*.tagged.txt`, `*.md`), `run` erneut. **`--force` ist Pflicht**, sonst übernimmt der Block-Cache stillschweigend Teilblöcke nach der alten Regel.

- [ ] **Step 5: Ergebnis festhalten — auch wenn es negativ ist**

Beide Tabellen in den PR-Text. Findet die Messung keinen Unterschied, wird das **so berichtet** („die Regel ist jetzt konsistent, eine Wirkung liess sich an einer Datei nicht zeigen") und ein Issue eröffnet. Ein Fix ohne belegte Wirkung darf nicht als Verbesserung verkauft werden.

- [ ] **Step 6: Wegwerf-Projekt löschen**

```bash
rm -rf "E:/Git/Transkribor/projekte/ZZ-diar-probe"
```

- [ ] **Step 7: PR 1 aufmachen**

Reviewkette nach den Global Constraints: erst `superpowers:requesting-code-review`, dann CodeRabbit CLI, dann Bot. Danach Rebase-Merge, `master` lokal per Fast-Forward nachziehen. Issues #266/#267 schliessen.

---

# Block B — Messgrundlage (PR 2)

Kann parallel zu Block A gebaut werden. Task 8 wartet auf Marcus' Referenzarbeit, Tasks 6–7 nicht.

## Task 6: Metriken als reine Funktionen, synthetisch getestet

**Files:**
- Create: `tools/diar_eval.py`
- Create: `webtool/test_diar_eval.py`
- Modify: `.gitignore`

**Interfaces:**
- Produces:
  - `sprecherzahl(zuordnung: dict) -> int` — Anzahl verschiedener Etiketten
  - `v_measure(vorhersage: dict, referenz: dict) -> tuple[float, float, float]` — (Homogenität, Vollständigkeit, V)
  - `fehlerquote(vorhersage: dict, referenz: dict, dauer: dict) -> float` — zeitgewichtet, 0.0 = perfekt
  - Alle drei nehmen `{segment_id: etikett}` und ignorieren IDs, die nur einer Seite bekannt sind.

- [ ] **Step 1: `eval/` ignorieren**

An `.gitignore` anhängen:

```
# Referenzsatz und Messlaeufe der Sprechertrennung: das sind Interviewinhalte.
# Dieselbe Regel wie fuer projekte/ — bleibt lokal, wird nie committet.
eval/
```

- [ ] **Step 2: Die fehlschlagenden Tests schreiben**

`webtool/test_diar_eval.py`:

```python
"""Metriken der Sprechertrennungs-Messung — rein synthetisch.

Bewusst OHNE echtes Material: der Referenzsatz liegt unter eval/ und wird nie committet
(Interviewinhalte). Die CI muss das Werkzeug trotzdem pruefen koennen.
"""
import importlib.util
import os
import sys

import pytest

_PFAD = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                     "tools", "diar_eval.py")
_spec = importlib.util.spec_from_file_location("diar_eval", _PFAD)
de = importlib.util.module_from_spec(_spec)
sys.modules["diar_eval"] = de
_spec.loader.exec_module(de)


def test_fehlerquote_ist_null_bei_perfekter_zuordnung():
    ref = {1: "A", 2: "A", 3: "B"}
    dauer = {1: 1.0, 2: 2.0, 3: 3.0}
    assert de.fehlerquote({1: "X", 2: "X", 3: "Y"}, ref, dauer) == 0.0


def test_fehlerquote_ist_unabhaengig_von_den_etiketten():
    """Cluster-Namen sind willkuerlich ('SPEAKER_00' gegen 'Interviewer'). Eine Metrik, die
    sie vergleicht statt die PARTITION, misst die Benennung — genau das, was die Diarisierung
    gar nicht leistet. Ohne diese Zusicherung waere jede Zahl des Werkzeugs wertlos.
    """
    ref = {1: "A", 2: "B", 3: "A"}
    dauer = {1: 1.0, 2: 1.0, 3: 1.0}
    assert de.fehlerquote({1: "B", 2: "A", 3: "B"}, ref, dauer) == 0.0


def test_fehlerquote_gewichtet_nach_ZEIT_nicht_nach_anzahl():
    """Ein falsch zugeordnetes 30-Sekunden-Segment wiegt schwerer als ein falsches
    1-Sekunden-Segment.

    Alle drei Segmente landen in EINEM Cluster. Die beste Zuordnung waehlt B (6 s richtig),
    die 2 s von A sind der Fehler -> 2/8 = 0,25. Die Mutation „nach Segmentzahl zaehlen"
    waehlte A (2 von 3 Segmenten) und lieferte 1/3 — deutlich daneben, also rot.
    """
    ref = {1: "A", 2: "A", 3: "B"}
    dauer = {1: 1.0, 2: 1.0, 3: 6.0}
    quote = de.fehlerquote({1: "X", 2: "X", 3: "X"}, ref, dauer)
    assert quote == pytest.approx(2.0 / 8.0)


def test_v_measure_erkennt_ueber_UND_unterclustering():
    """Der Grund fuer V-Measure statt Trefferquote oder Reinheit: Reinheit belohnt
    Ueber-Clustering (k = n gibt 100 %), die ungarische Trefferquote bestraft es rechnerisch
    (ueberzaehlige Cluster bleiben unpaarig). V-Measure ist symmetrisch.
    """
    ref = {1: "A", 2: "A", 3: "B", 4: "B"}
    assert de.v_measure({1: "X", 2: "X", 3: "Y", 4: "Y"}, ref)[2] == pytest.approx(1.0)
    # alles in einen Topf (Unterclustering) und jedes fuer sich (Ueberclustering):
    assert de.v_measure({1: "X", 2: "X", 3: "X", 4: "X"}, ref)[2] < 0.5
    assert de.v_measure({1: "W", 2: "X", 3: "Y", 4: "Z"}, ref)[2] < 1.0


def test_metriken_ignorieren_einseitig_bekannte_segmente():
    """Die Referenz kann Segmente auslassen (unklare Stelle), der Lauf kann welche liefern,
    die es dort nicht gibt. Beides darf die Zahl nicht verschieben, sondern muss aus der
    Rechnung fallen — sonst misst man die Vollstaendigkeit der Referenz.
    """
    ref = {1: "A", 2: "B"}
    dauer = {1: 1.0, 2: 1.0, 99: 5.0}
    assert de.fehlerquote({1: "X", 2: "Y", 99: "Z"}, ref, dauer) == 0.0
    assert de.sprecherzahl({1: "X", 2: "Y"}) == 2


def test_gar_keine_gemeinsamen_segmente_ist_KEIN_bestwert():
    """Der gefaehrlichste Zustand des ganzen Werkzeugs: passen die Segment-IDs des Laufs nicht
    zur eingefrorenen Referenz (neu transkribierte Datei, verschobene IDs, ein
    --projekte-Tippfehler auf eine andere Kopie), gibt es NICHTS zu vergleichen.

    Eine 0.0 hiesse dort „fehlerfrei" — der Lauf bestuende die Abnahmekriterien 1 und 2
    lautlos, ausgerechnet weil er nichts gemessen hat. `nan` besteht keinen Vergleich, und
    `cmd_run` bricht darauf laut ab. (Das V-Measure meldet im selben Fall 0.0 = Totalversagen;
    zwei Metriken mit entgegengesetzter Bedeutung fuer dieselbe Eingabe waeren die Falle.)
    """
    import math
    assert math.isnan(de.fehlerquote({1: "X"}, {2: "A"}, {1: 1.0}))
    assert math.isnan(de.fehlerquote({}, {}, {}))
```

- [ ] **Step 3: Tests laufen lassen, Fehlschlag bestätigen**

Run: `.venv/Scripts/python.exe -m pytest webtool/test_diar_eval.py -q`
Expected: FAIL — `tools/diar_eval.py` existiert nicht.

- [ ] **Step 4: Die Metriken schreiben**

`tools/diar_eval.py`, Kopf und Metrikteil:

```python
"""Messwerkzeug fuer die Sprechertrennung — freeze / run / vergleich.

KEIN Teil des Produkts: der Server importiert das hier nie. Es liest Marcus' echtes Material
und schreibt AUSSCHLIESSLICH nach eval/ (gitignoriert) — insbesondere ruft es
`diarize.diarize_file` direkt und NIE `correct.cmd_diarize`, das Sidecars in echte Projekte
schreiben wuerde.

Drei Zahlen je Datei, ihre Wahl ist begruendet in
docs/superpowers/specs/2026-08-17-transkribor-diarisierung-verbessern-design.md:
  Sprecherzahl  — die Zaehlung (laut #264 der einzige Knopf, der exakt trifft)
  V-Measure     — die Trennung, symmetrisch gegen Ueber- und Unterclustering
  Fehlerquote   — zeitgewichtet, das was der Nutzer merkt

Die Fehlerquote ist KEIN DER: es fehlen der VAD- und der Overlap-Term, und die Aufloesung ist
das Whisper-Segment statt des Rahmens. Sie wird deshalb nirgends so genannt. Die Aufloesung ist
Absicht — sie ist die Grenze, an der das Ergebnis den Nutzer erreicht.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _gemeinsam(vorhersage: dict, referenz: dict) -> list:
    """IDs, die BEIDE Seiten kennen. Einseitige fallen aus der Rechnung — sonst misst man die
    Vollstaendigkeit der Referenz statt die Guete des Laufs."""
    return sorted(i for i in referenz if i in vorhersage and referenz[i])


def sprecherzahl(zuordnung: dict) -> int:
    return len({v for v in zuordnung.values() if v})


def v_measure(vorhersage: dict, referenz: dict) -> tuple:
    """(Homogenitaet, Vollstaendigkeit, V-Measure). Alle drei einzeln, weil sie verschiedene
    Fehler benennen: niedrige Homogenitaet = Cluster mischt Personen, niedrige
    Vollstaendigkeit = eine Person auf mehrere Cluster verteilt (genau #267)."""
    from sklearn.metrics import homogeneity_completeness_v_measure
    ids = _gemeinsam(vorhersage, referenz)
    if not ids:
        return (0.0, 0.0, 0.0)
    return tuple(homogeneity_completeness_v_measure([referenz[i] for i in ids],
                                                    [vorhersage[i] for i in ids]))


def fehlerquote(vorhersage: dict, referenz: dict, dauer: dict) -> float:
    """Anteil der Redezeit, die einem falschen Sprecher zugeordnet wurde (0.0 = perfekt).

    Die beste Cluster->Sprecher-Zuordnung wird ueber die ungarische Methode auf der
    ZEITgewichteten Kontingenztabelle bestimmt: Cluster-Etiketten sind willkuerlich, verglichen
    wird die Partition. Gewichtet wird nach Dauer, nicht nach Segmentzahl — ein falsch
    zugeordneter 30-Sekunden-Block wiegt schwerer als ein 'Mhm'.
    """
    import numpy as np
    from scipy.optimize import linear_sum_assignment
    ids = _gemeinsam(vorhersage, referenz)
    gesamt = sum(dauer.get(i, 0.0) for i in ids)
    if not ids or gesamt <= 0:
        # NICHT 0.0 — das hiesse „fehlerfrei" und liesse einen Lauf, der gar nichts vergleichen
        # konnte, die Abnahme lautlos bestehen. `nan` besteht keinen Groessenvergleich.
        return float("nan")
    cs = sorted({vorhersage[i] for i in ids})
    ns = sorted({referenz[i] for i in ids})
    m = np.zeros((len(cs), len(ns)))
    ci = {c: k for k, c in enumerate(cs)}
    ni = {n: k for k, n in enumerate(ns)}
    for i in ids:
        m[ci[vorhersage[i]], ni[referenz[i]]] += dauer.get(i, 0.0)
    zeile, spalte = linear_sum_assignment(-m)
    return 1.0 - float(m[zeile, spalte].sum()) / gesamt
```

- [ ] **Step 5: Tests laufen lassen, Erfolg bestätigen**

Run: `.venv/Scripts/python.exe -m pytest webtool/test_diar_eval.py -q`
Expected: PASS, alle fünf.

- [ ] **Step 6: Mutationsprobe**

In `fehlerquote` **beide** Vorkommen von `dauer.get(i, 0.0)` durch `1.0` ersetzen ⇒ `test_fehlerquote_gewichtet_nach_ZEIT_nicht_nach_anzahl` rot. **Beide, nicht eines:** der Ausdruck steht zweimal (in `gesamt` und in der Kontingenztabelle); nur das zweite zu ersetzen macht **zwei** Tests rot und misst damit etwas anderes als die Zeitgewichtung — im Review gemessen, und es ist die Repo-Lektion „Mutationsanker muss EINDEUTIG sein".

`linear_sum_assignment` durch eine feste Identitätszuordnung ersetzen ⇒ `test_fehlerquote_ist_unabhaengig_von_den_etiketten` rot. `float("nan")` zurück auf `0.0` ⇒ `test_gar_keine_gemeinsamen_segmente_ist_KEIN_bestwert` rot. Alles zurückspielen, `__pycache__` leeren.

- [ ] **Step 7: Die CI in die Lage versetzen, das zu prüfen**

Ohne diesen Schritt fällt der CI-Job um (`ModuleNotFoundError`, beide Matrix-Beine). In `.github/workflows/test.yml` die Installationszeile erweitern und die Ausnahme **begründen**, weil der schlanke Stand dort ein Wächter ist:

```yaml
      # scipy/scikit-learn kommen fuer tools/diar_eval.py dazu (Metriken der
      # Sprechertrennungs-Messung). Sie brechen den Waechter oben NICHT: er zielt auf
      # torch/pyannote/whisper — die bleiben draussen, ein Modulebenen-Import davon laesst
      # den Job weiterhin umfallen. ~60 MB, kein GB-Sprung.
      - run: pip install fastapi python-multipart pytest httpx scipy scikit-learn
```

Prüfen, dass der Wächter wirklich scharf bleibt: `grep -n "^import torch\|^from torch\|^import pyannote" webtool/*.py tools/*.py` muss leer bleiben.

- [ ] **Step 8: Commit**

```bash
git add tools/diar_eval.py webtool/test_diar_eval.py .gitignore .github/workflows/test.yml
git commit -m "feat(eval): Metriken fuer die Sprechertrennungs-Messung (synthetisch getestet)"
```

---

## Task 7: `freeze`, `run` und `vergleich`

**Files:**
- Modify: `tools/diar_eval.py`

**Interfaces:**
- Consumes: `sprecherzahl`, `v_measure`, `fehlerquote` aus Task 6
- Produces: `eval/referenz.json` mit `{"projekte": str, "dateien": {"<projekt>/<base>": {"projekt", "base", "sprecher_wahr": int, "segmente": [{"id", "start", "end", "sprecher"}]}}}` und `eval/laeufe/<name>.json` mit `{"name", "einstellungen", "dateien": {"<schluessel>": {"sprecherzahl", "cluster_roh", "sprecher_wahr", "dauer_s", "homogenitaet", "vollstaendigkeit", "v", "fehlerquote"}}}`
- Liest: `eval/referenzsatz.txt` (eine Zeile `<Projekt>/<Base>`, `#` = Kommentar)

- [ ] **Step 1: `freeze` schreiben**

```python
def cmd_freeze(args) -> int:
    """Die AUSDRUECKLICH benannten, handkorrigierten edit.json -> eval/referenz.json.

    Das Einfrieren ist nicht Komfort: ohne es wandert das Ziel bei jeder spaeteren Korrektur
    mit, und zwei Messlaeufe waeren nicht vergleichbar.

    **Die Liste ist Pflicht, kein Komfort.** Ein blosser `human_edited`-Filter naehme jede
    Datei, die je im Editor gespeichert wurde — und `human_edited=true` setzt `save_file` bei
    JEDEM PUT, der Editor speichert 800 ms nach jeder Aenderung von selbst. Die Flagge sagt
    „ein Mensch hat gespeichert", NICHT „ein Mensch hat die Sprecherzuordnung geprueft". Genau
    an diesem Unterschied haengt der ganze Plan (Spec 1.4). Im Bestand liegen bereits drei
    handbearbeitete Dateien AUSSERHALB des Referenzsatzes; ungefiltert waeren sie mitgekommen,
    ohne je unter der Anweisung „einzelne Namen, nie ein Sammel-Etikett" durchgesehen worden
    zu sein — der Fehler aus Spec 1.3d ueber einen neuen Weg zurueck.

    `human_edited` wird trotzdem geprueft, aber als NOTWENDIGE Bedingung: fehlt sie bei einer
    gelisteten Datei, hat Marcus sie schlicht noch nicht bearbeitet, und das ist ein Abbruch
    und keine stille Auslassung.
    """
    with open(args.liste, encoding="utf-8") as f:
        gewuenscht = [z.strip() for z in f if z.strip() and not z.startswith("#")]
    dateien, fehlend = {}, []
    for schluessel in gewuenscht:
        proj, base = schluessel.rsplit("/", 1)
        pfad = os.path.join(args.projekte, proj, "transkripte", base + ".edit.json")
        try:
            with open(pfad, encoding="utf-8") as f:
                ed = json.load(f)
        except (OSError, ValueError) as e:        # ValueError deckt auch UnicodeDecodeError
            fehlend.append(f"{schluessel} ({type(e).__name__})")
            continue
        if not ed.get("human_edited"):
            fehlend.append(f"{schluessel} (noch nicht handkorrigiert)")
            continue
        segmente = [{"id": s.get("id"), "start": s.get("start"), "end": s.get("end"),
                     "sprecher": s.get("speaker")}
                    for s in ed.get("segments", []) if s.get("speaker")]
        if not segmente:
            fehlend.append(f"{schluessel} (keine Sprecher)")
            continue
        namen = sorted({s["sprecher"] for s in segmente})
        dateien[schluessel] = {"projekt": proj, "base": base, "sprecher_wahr": len(namen),
                               "segmente": segmente}
        # Die NAMEN mitdrucken, nicht nur die Anzahl: ein Sammel-Etikett („Team Ikotec")
        # faellt genau hier auf und nirgends sonst — die Anzahl saehe unauffaellig aus.
        print(f"  {schluessel}: {len(segmente)} Segmente, {len(namen)} Sprecher — "
              + ", ".join(namen))
    if fehlend:
        print("\nFEHLT:\n  " + "\n  ".join(fehlend))
        print("\nAbbruch: ein unvollstaendiger Referenzsatz wuerde als Nullpunkt eingefroren "
              "und alle spaeteren Vergleiche verschieben.")
        return 1
    if os.path.dirname(args.ziel):        # `--ziel referenz.json` -> dirname "" -> makedirs wirft
        os.makedirs(os.path.dirname(args.ziel), exist_ok=True)
    with open(args.ziel, "w", encoding="utf-8") as f:
        json.dump({"projekte": args.projekte, "dateien": dateien}, f, indent=1,
                  ensure_ascii=False)
    print(f"\n{len(dateien)} Datei(en) -> {args.ziel}")
    return 0
```

`eval/referenzsatz.txt` (die Liste, ebenfalls gitignoriert) enthält eine Zeile je Datei im Format `<Projekt>/<Base>`; `#` leitet einen Kommentar ein. Sie wird in Task 8 Step 1 aus der Tabelle des Referenzsatzes erzeugt.

- [ ] **Step 2: `run` schreiben**

```python
def cmd_run(args) -> int:
    """Diarisiert den Referenzsatz mit einer Konfiguration und schreibt die drei Zahlen.

    `--config` zeigt auf eine alternative pyannote-config.yaml (fuer Block C: getauschte
    Einbettung, andere Clustering-Parameter). Umgehaengt wird ueber `diarize.DIAR_MODEL` plus
    Ruecksetzen des Pipeline-Singletons — ein Eingriff, den sich nur dieses Werkzeug erlauben
    darf, weil es kein Produktionscode ist.

    `--sprecher-aus-referenz` gibt pyannote die WAHRE Sprecherzahl vor. Das misst nicht die
    Pipeline, sondern beantwortet die in der Spec offengebliebene Frage (1.3a): waere die
    Trennung gut, wenn die Zaehlung stimmte?
    """
    from webtool import diarize
    with open(args.referenz, encoding="utf-8") as f:
        ref = json.load(f)
    if args.config:
        diarize.DIAR_MODEL = os.path.abspath(args.config)
        diarize._PIPELINE = None
    wurzel = args.projekte or ref["projekte"]
    ergebnis = {}
    for schluessel, eintrag in sorted(ref["dateien"].items()):
        audio = _audio(wurzel, eintrag["projekt"], eintrag["base"])
        roh = os.path.join(wurzel, eintrag["projekt"], "transkripte", eintrag["base"] + ".json")
        if not audio or not os.path.exists(roh):
            print(f"  SKIP {schluessel} (Audio oder Roh-JSON fehlt)")
            continue
        with open(roh, encoding="utf-8") as f:
            raw = json.load(f)
        k = eintrag["sprecher_wahr"] if args.sprecher_aus_referenz else args.num_speakers
        grenzen = {"num_speakers": k} if k else {"min_speakers": args.min_speakers}
        turns = diarize.diarize_file(audio, **grenzen)
        vorhersage = diarize.assign_clusters(raw, turns)
        referenz = {s["id"]: s["sprecher"] for s in eintrag["segmente"]}
        dauer = {s["id"]: (s["end"] or 0) - (s["start"] or 0) for s in eintrag["segmente"]}
        quote = fehlerquote(vorhersage, referenz, dauer)
        if quote != quote:                     # nan: keine gemeinsamen Segment-IDs
            raise SystemExit(
                f"{schluessel}: kein einziges Segment ist beiden bekannt. Die Referenz passt "
                f"nicht zu diesem Material (neu transkribiert? falscher --projekte-Pfad?). "
                f"Abbruch — ein Lauf, der nichts vergleichen kann, darf keine Zahl liefern.")
        h, c, v = v_measure(vorhersage, referenz)
        ergebnis[schluessel] = {
            # ZWEI Zahlen, nicht eine: `sprecherzahl` zaehlt die Etiketten NACH
            # `assign_clusters` — ein Cluster, der bei keinem Segment den groessten Overlap
            # gewinnt (kurze Rueckkanaele), taucht dort nicht auf. #264 hat aber die
            # Clusterzahl von pyannote gemessen, und bei C1 (min_speakers 1 gegen 2) ist genau
            # das der interessante Unterschied.
            "sprecherzahl": sprecherzahl(vorhersage), "cluster_roh": len({t["cluster"] for t in turns}),
            "sprecher_wahr": eintrag["sprecher_wahr"],
            # Gesamtdauer je Datei: ohne sie kann `_summe` die Fehlerquote nicht ueber den Satz
            # ZEITgewichtet mitteln, sondern nur ueber Dateien — und ein 40-Sekunden-Schnipsel
            # waege dann so viel wie ein 5-Minuten-Interview (Abnahmekriterium 1 haengt daran).
            "dauer_s": round(sum(dauer.get(i, 0.0) for i in referenz if i in vorhersage), 2),
            "homogenitaet": round(h, 4), "vollstaendigkeit": round(c, 4), "v": round(v, 4),
            "fehlerquote": round(quote, 4)}
        e = ergebnis[schluessel]
        print(f"  {schluessel:<44} {e['sprecherzahl']}({e['cluster_roh']})/{e['sprecher_wahr']} "
              f"Sprecher | V {e['v']:.3f} | Fehler {e['fehlerquote']*100:5.1f}%", flush=True)
    ziel = os.path.join("eval", "laeufe", args.name + ".json")
    os.makedirs(os.path.dirname(ziel), exist_ok=True)
    # Die Einstellungen EINZELN, nicht `vars(args)`: darin steckt ueber `set_defaults` die
    # Funktion `fn`, und `json.dump` stirbt daran mit TypeError — nach dem Rechnen, also nach
    # allen GPU-Minuten des Laufs.
    with open(ziel, "w", encoding="utf-8") as f:
        json.dump({"name": args.name, "dateien": ergebnis,
                   "einstellungen": {"min_speakers": args.min_speakers,
                                     "num_speakers": args.num_speakers,
                                     "sprecher_aus_referenz": args.sprecher_aus_referenz,
                                     "config": args.config}}, f, indent=1, ensure_ascii=False)
    _summe(args.name, ergebnis)
    return 0


def _audio(wurzel: str, projekt: str, base: str):
    # Die Endungen kommen aus `correct.AUDIO_EXT` — eine zweite Liste liefe beim naechsten
    # Format auseinander, und dann faende das Messwerkzeug still eine Datei nicht, die die
    # Pipeline sehr wohl verarbeitet. Dieselbe Regel wie bei `sprachen.py` und `_lockziel()`.
    from webtool.correct import AUDIO_EXT
    for ext in AUDIO_EXT:
        p = os.path.join(wurzel, projekt, "audio", base + ext)
        if os.path.exists(p):
            return p
    return None


def _summe(name: str, ergebnis: dict) -> dict:
    """Die Kennzahlen ueber den ganzen Satz.

    Die Fehlerquote wird NACH REDEZEIT gewichtet, nicht ueber Dateien gemittelt: sonst wiegt
    ein 40-Sekunden-Schnipsel so viel wie ein 5-Minuten-Interview, und ein Kandidat koennte die
    Abnahme bestehen, indem er die kurzen Dateien verbessert und das lange Material
    verschlechtert — die Summe stiege, der Nutzer merkte das Gegenteil. Das V-Measure bleibt
    ein schlichtes Mittel ueber Dateien: es ist eine Struktur-, keine Mengenaussage, und eine
    Zeitgewichtung waere dort nicht definiert. Beide Zahlen tragen deshalb verschiedene Namen.
    """
    n = len(ergebnis) or 1
    treffer = sum(1 for e in ergebnis.values() if e["sprecherzahl"] == e["sprecher_wahr"])
    zeit = sum(e["dauer_s"] for e in ergebnis.values()) or 1.0
    summe = {"dateien": len(ergebnis), "zahl_getroffen": treffer,
             "v_mittel_je_datei": round(sum(e["v"] for e in ergebnis.values()) / n, 4),
             "fehler_zeitgewichtet": round(
                 sum(e["fehlerquote"] * e["dauer_s"] for e in ergebnis.values()) / zeit, 4)}
    print(f"\n[{name}] {summe['dateien']} Dateien, {zeit/60:.1f} Min | Sprecherzahl getroffen: "
          f"{treffer}/{summe['dateien']} | V {summe['v_mittel_je_datei']:.3f} | "
          f"Fehler {summe['fehler_zeitgewichtet']*100:.1f}%")
    return summe
```

- [ ] **Step 3: `vergleich` und die Kommandozeile schreiben**

```python
def cmd_vergleich(args) -> int:
    """Zwei Laeufe nebeneinander, je Datei und in der Summe.

    Zeigt bewusst JEDE Datei, nicht nur die Summe: eine Aenderung, die den schweren Fall
    rettet und den leichten opfert, ist keine Verbesserung (Abnahmekriterium 2 der Spec) —
    und in der Summe waere genau das unsichtbar.
    """
    laeufe = []
    for name in (args.a, args.b):
        with open(os.path.join("eval", "laeufe", name + ".json"), encoding="utf-8") as f:
            laeufe.append(json.load(f))
    a, b = laeufe
    print(f"{'Datei':<44} {'Zahl a/b/wahr':>14} {'V a->b':>16} {'Fehler a->b':>18}")
    for schluessel in sorted(set(a["dateien"]) | set(b["dateien"])):
        ea, eb = a["dateien"].get(schluessel), b["dateien"].get(schluessel)
        if not ea or not eb:
            print(f"{schluessel:<44} nur in einem Lauf")
            continue
        pfeil = "+" if eb["fehlerquote"] < ea["fehlerquote"] else (
            "-" if eb["fehlerquote"] > ea["fehlerquote"] else "=")
        print(f"{schluessel:<44} {ea['sprecherzahl']}/{eb['sprecherzahl']}/"
              f"{ea['sprecher_wahr']:>3}   {ea['v']:.3f}->{eb['v']:.3f}   "
              f"{ea['fehlerquote']*100:5.1f}%->{eb['fehlerquote']*100:5.1f}%  {pfeil}")
    print()
    _summe(a["name"], a["dateien"])
    _summe(b["name"], b["dateien"])
    return 0


def _lauf_name(wert: str) -> str:
    """Laufnamen gehen ungeprueft in einen Dateipfad. `run ../../projekte/...` schriebe genau
    dorthin, wo der wichtigste Constraint dieses Plans es verbietet — der darf nicht bloss
    durch Disziplin gesichert sein. Dieselbe Haltung wie `paths.safe_name`."""
    if not wert or not all(c.isalnum() or c in "-_." for c in wert) or wert.startswith("."):
        raise argparse.ArgumentTypeError(
            "nur Buchstaben, Ziffern, '-', '_' und '.', nicht mit '.' beginnend")
    return wert


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="befehl", required=True)

    f = sub.add_parser("freeze", help="handkorrigierte edit.json -> eval/referenz.json")
    f.add_argument("--projekte", required=True, help="Wurzel der Projektordner")
    f.add_argument("--liste", default=os.path.join("eval", "referenzsatz.txt"),
                   help="eine Zeile <Projekt>/<Base> je Datei; '#' ist Kommentar")
    f.add_argument("--ziel", default=os.path.join("eval", "referenz.json"))
    f.set_defaults(fn=cmd_freeze)

    r = sub.add_parser("run", help="Referenzsatz mit einer Konfiguration durchmessen")
    r.add_argument("name", type=_lauf_name, help="Name des Laufs (-> eval/laeufe/<name>.json)")
    r.add_argument("--referenz", default=os.path.join("eval", "referenz.json"))
    r.add_argument("--projekte", default=None, help="ueberschreibt die Wurzel aus der Referenz")
    r.add_argument("--min-speakers", type=int, default=2)
    r.add_argument("--num-speakers", type=int, default=None)
    r.add_argument("--sprecher-aus-referenz", action="store_true",
                   help="die WAHRE Sprecherzahl vorgeben (beantwortet Spec 1.3a)")
    r.add_argument("--config", default=None, help="alternative pyannote-config.yaml")
    r.set_defaults(fn=cmd_run)

    v = sub.add_parser("vergleich", help="zwei Laeufe gegenueberstellen")
    v.add_argument("a")
    v.add_argument("b")
    v.set_defaults(fn=cmd_vergleich)

    args = p.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: Rauchprobe gegen die HEUTIGEN handkorrigierten Dateien**

Es gibt bereits vier (`Rhyathlon/00097495`, `US Car Treff/Fuhat Aras`, `US Car Treff/Güldi Milo`, `US Car Treff/Swiss Deuce Day Ruethi Amerikanische Autos im Rheintal`). Damit lässt sich das Werkzeug prüfen, bevor Marcus' Arbeit vorliegt — **drei davon gehören nicht zum späteren Referenzsatz**, für die Rauchprobe ist das egal:

```bash
mkdir -p eval
cat > eval/rauchprobe.txt <<'EOF'
Rhyathlon/00097495
US Car Treff Rthi/Fuhat Aras
US Car Treff Rthi/Güldi Milo
EOF
.venv/Scripts/python.exe tools/diar_eval.py freeze \
  --projekte "C:/Users/marcu/AppData/Roaming/Transkribor/projekte" \
  --liste eval/rauchprobe.txt --ziel eval/rauchprobe.json
.venv/Scripts/python.exe tools/diar_eval.py run rauchprobe --referenz eval/rauchprobe.json
```
Expected: drei Dateien mit **ausgeschriebenen Sprechernamen** in der Ausgabe (daran fällt ein Sammel-Etikett auf, an der blossen Anzahl nicht), danach ein Lauf mit den Kennzahlen je Datei und `eval/laeufe/rauchprobe.json`.

Zusätzlich die Abbruchpfade einmal auslösen, sie sind die eigentlichen Wächter:
- eine nicht existierende Zeile in die Liste ⇒ `FEHLT:` und Rückgabewert 1
- `run … --projekte <leerer Ordner>` ⇒ `SKIP` je Datei, kein stiller Nullpunkt

- [ ] **Step 5: Prüfen, dass nichts nach `projekte\` geschrieben wurde**

Run: `git -C "C:/Users/marcu/AppData/Roaming/Transkribor" status 2>/dev/null; ls -la "C:/Users/marcu/AppData/Roaming/Transkribor/projekte/Rhyathlon/transkripte/" | head`
Expected: keine neuen oder veränderten Zeitstempel an `.diar.json`/`.edit.json`. **Diese Prüfung ist nicht Zierde** — sie ist die einzige, die den wichtigsten Constraint dieses Plans übt.

- [ ] **Step 6: Commit**

```bash
git add tools/diar_eval.py
git commit -m "feat(eval): freeze/run/vergleich fuer die Sprechertrennungs-Messung"
```

- [ ] **Step 7: PR 2 aufmachen**

Reviewkette nach den Global Constraints.

---

## Task 8: Referenzsatz und Nullpunkt

**Blockiert durch Marcus' Referenzarbeit.** Erst starten, wenn die Dateien korrigiert sind.

- [ ] **Step 1: Marcus die Anweisung geben**

Zu korrigieren im Editor (setzt `human_edited=true`):

| Datei(en) | Segmente | deckt ab |
|---|---|---|
| alle 10 `Rhyathlon/*` | 512 | Kameramikrofon, Unterschätzung, Gruppen |
| `US Car Treff/Roger Meili` | 116 | Ansteckmikrofon, sauber — Positivkontrolle |
| `test/Behind the Scenes … FX5` | 71 | englischer Monolog, heute richtig — Gegenprobe |
| `test/I Built DaVinci …` | 298 | Einzelsprecher, heute auf 2 Cluster gespreizt |

**Die eine Anweisung, an der alles hängt:** Gruppenmitglieder brauchen **einzelne** Namen („Ikotec 1", „Ikotec 2"), nie ein Sammel-Etikett. Genau daran ist `00111679` als Messgrundlage gescheitert.

- [ ] **Step 2: Die Liste anlegen und einfrieren**

`eval/referenzsatz.txt` mit genau den **13** Dateien aus der Tabelle (10 × Rhyathlon, `US Car Treff Rthi/Roger Meili`, `test/Behind the Scenes of Masha shot on FX5, with Cinematographer Ula Pontikos, BSC`, `test/I Built DaVinci Resolve's Missing Piece With Claude Code`).

**Die Liste ist nicht Bürokratie:** im Bestand liegen bereits drei weitere handbearbeitete Dateien (`US Car Treff Rthi/Fuhat Aras`, `Güldi Milo`, `Swiss Deuce Day …`). Ein blosser `human_edited`-Filter nähme sie mit — nie durchgesehen unter der Anweisung „einzelne Namen", also genau der Fehler aus Spec 1.3d über einen neuen Weg, und er wanderte unbemerkt in Nullpunkt und Abnahme.

Run: `.venv/Scripts/python.exe tools/diar_eval.py freeze --projekte "C:/Users/marcu/AppData/Roaming/Transkribor/projekte"`
Expected: **13** Dateien, kein `FEHLT:`-Block. Die Ausgabe druckt je Datei die **Namen** — dort auf Sammel-Etiketten sehen („Team Ikotec"), nicht nur auf die Anzahl. Weicht eine Sprecherzahl von Marcus' Angabe ab, zuerst die Ursache klären, nicht die Zahl anpassen.

- [ ] **Step 3: Nullpunkt messen**

Run: `.venv/Scripts/python.exe tools/diar_eval.py run nullpunkt`
Expected: ein vollständiger Lauf. **Diese Zahlen sind ab jetzt die Messlatte.**

- [ ] **Step 4: Die offene Frage aus Spec 1.3a beantworten**

Run: `.venv/Scripts/python.exe tools/diar_eval.py run wahre-zahl --sprecher-aus-referenz`
und `.venv/Scripts/python.exe tools/diar_eval.py vergleich nullpunkt wahre-zahl`

Das ist die entscheidende Messung des ganzen Vorhabens: **schliesst die richtige Sprecherzahl die Lücke, oder bleibt ein grosser Rest?** Sie bestimmt, ob Phase 3 (Sprecherzahl automatisch) gebaut wird oder ob der Engpass in den Einbettungen liegt.

- [ ] **Step 5: Ergebnis berichten, bevor irgendetwas geändert wird**

Beide Tabellen an Marcus, mit der Einschränkung aus Spec 3.1 (die Referenz ist nicht unabhängig erhoben — der Editor zeigt beim Korrigieren den LLM-Vorschlag vor).

---

# Block C — Kandidaten (PR 3 …, je Gewinner einer)

## Task 9: Die Kandidaten durchmessen

Für **jeden** Kandidaten derselbe Ablauf. Kein Kandidat wird übernommen, bevor er die Abnahme besteht.

- [ ] **Step 1: Kandidat konfigurieren**

| # | Kandidat | wie gemessen |
|---|---|---|
| C1 | `min_speakers` 2 → 1 | `run c1-min1 --min-speakers 1` |
| C2 | Clustering `Fa`/`Fb`/`threshold` | **ganzen Modellordner** kopieren (s. u.), yaml darin ändern, `run c2-fa07 --config …`. **`Fa` ist ungeprüft** — #264 testete nur `threshold` und `Fb`, und ohne Metrik |
| C3 | Einbettungs-Modell tauschen | `embedding:` in der Ordner-Kopie auf das Alternativmodell, `run c3-<name> --config …` |
| C4 | `min_duration_off`, `embedding_exclude_overlap` | wie C2 |
| C5 | Enthallen/Entrauschen vor `_load_waveform` | **braucht eigenen Code** — siehe unten |
| C6 | NeMo kaskadiert | **braucht eigenen Code** — siehe unten |

**Eine Kopie der `config.yaml` allein reicht NICHT** — das ist der Fallstrick, an dem C2/C3/C4 sonst gleich beim ersten Lauf scheitern. pyannote löst `$model/embedding` gegen das **Verzeichnis der config.yaml** auf (`pyannote/audio/core/pipeline.py:209`: `model_id = Path(checkpoint).parent`, dazu `expand_subfolders`), und die Gewichte liegen in `segmentation/`, `embedding/`, `plda/` daneben. Eine einzelne yaml in `eval/configs/` zeigt also auf ein Verzeichnis ohne Gewichte. Es ist dieselbe Eigenschaft, die die Wurzel-CLAUDE.md als Vorteil führt („der Ordner ist unverändert verschiebbar") — hier wird sie zur Falle:

```bash
cp -r models/speaker-diarization-community-1 eval/configs/c2-fa07
#   ... eval/configs/c2-fa07/config.yaml anpassen ...
.venv/Scripts/python.exe tools/diar_eval.py run c2-fa07 --config eval/configs/c2-fa07/config.yaml
```

**Je Variante 31 MB** unter `eval/` — bei einem Dutzend Varianten rund 400 MB. `eval/` ist gitignoriert, das ist Plattenplatz und kein Repo-Wachstum, aber es gehört gewusst.

**C1–C4 sind reine Konfiguration** und in diesem Plan vollständig: eine Ordner-Kopie bzw. ein Kommandozeilen-Schalter, ein `run`, ein `vergleich`. Kein neuer Code, keine neue Abhängigkeit.

**C5 und C6 sind es nicht**, und sie hier auszuformulieren wäre ein Platzhalter mit Code-Optik:
beide brauchen eine neue Abhängigkeit, damit die drei Prüfungen aus den Global Constraints
(Lizenz, Apple Silicon, 2-GB-Grenze), und C6 zusätzlich einen zweiten Diarisierungspfad samt
Rückfall. Sie bekommen **je einen eigenen kleinen Plan**, und zwar erst, wenn C1–C4 gemessen
sind — dann steht fest, wie gross die Restlücke überhaupt ist, die sie schliessen müssten.
Vorher Aufwand hineinzustecken hiesse, für eine Entscheidung zu planen, die eine Messung in
Kürze trifft.

- [ ] **Step 2: Gegen den Nullpunkt vergleichen**

Run: `.venv/Scripts/python.exe tools/diar_eval.py vergleich nullpunkt <kandidat>`

- [ ] **Step 3: Abnahme prüfen — alle drei Punkte, nicht nur der erste**

1. `fehler_zeitgewichtet` über den Satz sinkt.
2. Die **Positivkontrollen** verschlechtern sich nicht (`Roger Meili`, `Behind the Scenes … FX5`). Eine Änderung, die den schweren Fall rettet und den leichten opfert, ist keine Verbesserung.
3. Die **Sprecherzahl** wird auf nicht weniger Dateien getroffen als vorher.
4. **Keine einzelne Datei verschlechtert sich um mehr als 10 Punkte Fehlerquote**, auch keine der zehn Rhyathlon-Dateien. Punkt 2 deckt nur die zwei benannten Kontrollen; ohne Punkt 4 könnte ein Kandidat gewinnen, indem er die Hälfte des Korpus opfert — und die zeitgewichtete Summe verbergt das, solange die verbesserte Hälfte länger ist. Deshalb zeigt `vergleich` **jede** Datei einzeln.

- [ ] **Step 4: Verlierer dokumentieren, nicht wegwerfen**

Jeder gescheiterte Kandidat kommt mit seiner Zahl in `webtool/CLAUDE.md` bzw. die Wurzel-`CLAUDE.md` — genau so, wie #264 `threshold` und `Fb` festgehalten hat, damit sie niemand ein zweites Mal probiert.

---

## Task 10: Einen Gewinner übernehmen — mit Konfigurations-Fingerabdruck

Erst ausführen, wenn Task 9 einen Kandidaten mit bestandener Abnahme geliefert hat.

**Files:**
- Modify: `webtool/diarize.py`, `webtool/correct.py` (Skip-Entscheidung in `cmd_diarize`)
- Test: `webtool/test_correct.py`

**Interfaces:**
- Produces: `diarize.konfig_fingerabdruck() -> str` — kurzer, stabiler Hash über Modellpfad und wirksame Parameter. `cmd_diarize` schreibt ihn als `konfig` ins Sidecar und vergleicht ihn beim Skip.

- [ ] **Step 1: Den fehlschlagenden Test schreiben**

In `webtool/test_correct.py`, hinter `test_cmd_diarize_idempotent_skip`:

```python
def test_geaenderte_konfiguration_macht_ein_sidecar_ungueltig(project, monkeypatch):
    """Was die erste wirksame Aenderung NEU aufmacht: `cmd_diarize` ueberspringt ein Sidecar
    anhand von mtime UND Sprecherzahl (#264). Beide bleiben gleich, wenn sich Modell oder
    Parameter aendern — bestehende Projekte behielten die alte Clusterung, lautlos, mit
    Erfolgsmeldung. Das ist exakt der tote Schalter aus #264 ueber einen neuen Weg.
    """
    _root, t = project
    monkeypatch.setenv("TRANSKRIBOR_DIARIZE", "1")
    import webtool.diarize as diar
    monkeypatch.setattr(diar, "konfig_fingerabdruck", lambda _min: "neu")
    # Sidecar frischer als die Roh-JSON UND mit derselben Sprecherzahl: mtime und Zahl koennen
    # den Neulauf beide nicht ausloesen. Nur der Fingerabdruck unterscheidet sich.
    (t / "S1.diar.json").write_text(json.dumps(
        {"segments": [{"id": 0, "speaker": "Sprecher 1"}], "sprecher": None, "konfig": "alt"}),
        encoding="utf-8")
    j = (t / "S1.json").stat().st_mtime
    os.utime(t / "S1.diar.json", (j + 10, j + 10))
    gerechnet = []
    monkeypatch.setattr(diar, "diarize_file",
                        lambda audio, min_speakers=2, num_speakers=None:
                        gerechnet.append(audio) or _fake_turns())
    assert correct.cmd_diarize("Demo") == 1
    assert len(gerechnet) == 1
    assert json.loads((t / "S1.diar.json").read_text(encoding="utf-8"))["konfig"] == "neu"


def test_gleiche_konfiguration_laesst_den_skip_greifen(project, monkeypatch):
    """Gegenprobe, ohne die „immer neu rechnen" gruen bliebe — und dann zahlte JEDER Lauf die
    GPU-Minuten erneut. Dieselbe Doppelrichtung wie beim Sidecar-Sprecherwert in #264.
    """
    _root, t = project
    monkeypatch.setenv("TRANSKRIBOR_DIARIZE", "1")
    import webtool.diarize as diar
    monkeypatch.setattr(diar, "konfig_fingerabdruck", lambda _min: "gleich")
    (t / "S1.diar.json").write_text(json.dumps(
        {"segments": [{"id": 0, "speaker": "Sprecher 1"}], "sprecher": None,
         "konfig": "gleich"}), encoding="utf-8")
    j = (t / "S1.json").stat().st_mtime
    os.utime(t / "S1.diar.json", (j + 10, j + 10))
    gerechnet = []
    monkeypatch.setattr(diar, "diarize_file", lambda *a, **k: gerechnet.append(1) or [])
    assert correct.cmd_diarize("Demo") == 0
    assert gerechnet == []
```

`project`, `_fake_turns` und das `os.utime`-Muster stammen aus den bestehenden
`cmd_diarize`-Tests derselben Datei (ab `test_cmd_diarize_writes_sidecar`).

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `.venv/Scripts/python.exe -m pytest webtool/test_correct.py -k fingerab -q`
Expected: FAIL

- [ ] **Step 3: Fingerabdruck einbauen**

```python
# Alles ausserhalb der config.yaml, was das Clustering-Ergebnis bestimmt. Ohne diese Liste
# waere der Fingerabdruck bei ausgerechnet dem billigsten Kandidaten wirkungslos: C1 aendert
# `correct.DIARIZE_MIN_SPEAKERS`, C5 den Code in `_load_waveform` — beides steht nicht in der
# yaml, alle Sidecars blieben „frisch", und der tote Schalter aus #264 waere ueber einen
# neuen Weg zurueck. Wer hier etwas aendert, das die Cluster bewegt, zaehlt `CODE_STAND` hoch.
CODE_STAND = 1


def konfig_fingerabdruck(min_speakers: int) -> str:
    """Kurzer Hash ueber das, was das Clustering-Ergebnis bestimmt: Inhalt der config.yaml
    (Modell + Parameter), `min_speakers` und `CODE_STAND`. Steht im Sidecar, damit ein
    Modell-, Parameter- oder Code-Wechsel bestehende Sidecars ungueltig macht — mtime und
    Sprecherzahl aendern sich dabei NICHT.

    NICHT den Modell-PFAD: er sagt nichts ueber das Ergebnis, macht den Hash aber vom Ort
    abhaengig. Die gepackte App liest DIAR_MODEL unter `resources/py/…`, das Checkout unter
    `E:\\Git\\…` — zeigen beide auf denselben Projektordner (genau Marcus' Aufbau ueber
    TRANSKRIBOR_PROJEKTE), entwerteten sie sich gegenseitig die Sidecars, bei jedem Wechsel,
    dauerhaft.

    `blake2b`, nicht `sha1`: letzteres geht durch OpenSSL und wirft unter einem FIPS-Provider
    (dieselbe Regel wie in ytdlp_update). Werfen darf die Funktion nirgends — sie sitzt in der
    Skip-Entscheidung eines Batch-Laufs.
    """
    import hashlib
    h = hashlib.blake2b(digest_size=8)
    h.update(f"{CODE_STAND}|{min_speakers}|".encode("utf-8"))
    try:
        with open(DIAR_MODEL, "rb") as f:
            h.update(f.read())
    except OSError:
        h.update(b"<config nicht lesbar>")   # der Lauf scheitert gleich ohnehin, hier nicht werfen
    return h.hexdigest()
```

In `correct.cmd_diarize` die Skip-Bedingung um `and _sidecar_konfig(dpath) == fingerabdruck` erweitern und den Wert beim Schreiben mit ablegen. **`_sidecar_konfig` liefert bei fehlendem Schlüssel `None`** (gleiche Form wie `_sidecar_sprecher`, wirft nie) — ein Sidecar aus der Zeit vor diesem Feld gilt damit als „alte Konfiguration" und wird einmal neu gerechnet.

**Der Import wandert dafür VOR die Schleife**, zusammen mit einer einmaligen Berechnung:

```python
    from . import diarize                    # leicht: torch/pyannote liegen in den Funktionen
    fingerabdruck = diarize.konfig_fingerabdruck(DIARIZE_MIN_SPEAKERS)   # EINMAL, nicht je Datei
```

Der bisherige Kommentar an dieser Stelle („lazy: zieht torch/pyannote erst hier") **stimmt nicht** — `webtool/diarize.py` importiert am Modulkopf nur `os` (steht so in seinem eigenen Docstring). Das Hochziehen kostet **0,79 ms**, im Review gemessen; ein fehlendes pyannote schlägt weiterhin erst in `diarize_file` zu, innerhalb des bestehenden `try`.

**Und jetzt der Teil, den man nicht aus dem Diff liest — was diese Reparatur NEU aufmacht.** `cmd_diarize` löscht ein überholtes Sidecar **vor** dem Rechnen (die #264-Zeile). Wirft `diarize_file` danach (GPU-OOM, pyannote fehlt), wird `atomic_write` nie erreicht: das alte ist weg, ein neues gibt es nicht, und `cmd_prep` webt gar kein `(Sprecher N)`-Präfix mehr ein. Vor diesem Fix war das unerreichbar, solange die Sprecherzahl gleich blieb. **Mit dem Fingerabdruck trifft es beim ersten Lauf nach dem Update jede Datei jedes bestehenden Projekts gleichzeitig** — im Review gemessen (`AssertionError: ALTES SIDECAR WURDE GELOESCHT`).

Deshalb wird nach dem **Grund** der Ungleichheit unterschieden:

```python
            # Das Vorloeschen aus #264 gilt der ZAHL-Ungleichheit: dort ist das alte Sidecar
            # nachweislich falsch (es wurde mit einer anderen Sprecherzahl gerechnet), und ein
            # Fehlschlag danach fuehrt in den dokumentierten "kein Sidecar"-Zustand.
            # Bei blosser KONFIGURATIONS-Ungleichheit ist es nur ALT, nicht falsch — und alt
            # schlaegt weg. `atomic_write` ersetzt es unten ohnehin atomar, wenn es klappt.
            if os.path.exists(dpath) and _sidecar_sprecher(dpath) != sprecher:
                with contextlib.suppress(OSError):
                    os.remove(dpath)
```

- [ ] **Step 3b: Den bestehenden Wächter anpassen, statt ihn im Lauf umfallen zu lassen**

`test_cmd_diarize_idempotent_skip` (`webtool/test_correct.py:509-523`) legt ein Sidecar **ohne** `konfig`-Schlüssel vor. Mit dem Fingerabdruck fällt sein Skip aus und der Test wird rot — im Review gemessen (`assert 1 == 0`). Das ist kein Zufallsschaden, sondern die gewollte neue Regel; der Test bekommt den Fingerabdruck ins Sidecar:

```python
    import webtool.diarize as diar
    monkeypatch.setattr(diar, "konfig_fingerabdruck", lambda _min: "fest")
    (t / "S1.diar.json").write_text(json.dumps(
        {"segments": [{"id": 0, "speaker": "Sprecher 1"}], "konfig": "fest"}), encoding="utf-8")
```

Die neue Gegenprobe `test_gleiche_konfiguration_laesst_den_skip_greifen` prüft dieselbe Eigenschaft schärfer; der alte Test bleibt trotzdem stehen, weil er die **mtime**-Hälfte übt, die die neue nicht abdeckt.

- [ ] **Step 3c: Den Verlustweg mit einem Test schliessen**

```python
def test_konfigwechsel_laesst_das_alte_sidecar_stehen_wenn_die_diarisierung_wirft(project, monkeypatch):
    """Was der Fingerabdruck NEU aufmacht: bei einem Fehlschlag nach dem Vorloeschen ist die
    alte Clusterung weg und keine neue da — und das traefe beim ersten Lauf nach dem Update
    JEDE Datei JEDES Projekts gleichzeitig. Bei Zahl-Ungleichheit ist das Vorloeschen richtig
    (#264: das alte Sidecar ist dann nachweislich falsch), bei Konfigurations-Ungleichheit
    nicht — dort ist es nur alt.
    """
    _root, t = project
    monkeypatch.setenv("TRANSKRIBOR_DIARIZE", "1")
    import webtool.diarize as diar
    monkeypatch.setattr(diar, "konfig_fingerabdruck", lambda _min: "neu")
    (t / "S1.diar.json").write_text(json.dumps(
        {"segments": [{"id": 0, "speaker": "Sprecher 1"}], "sprecher": None,
         "konfig": "alt"}), encoding="utf-8")
    j = (t / "S1.json").stat().st_mtime
    os.utime(t / "S1.diar.json", (j + 10, j + 10))

    def boom(*a, **k):
        raise RuntimeError("GPU voll")
    monkeypatch.setattr(diar, "diarize_file", boom)
    assert correct.cmd_diarize("Demo") == 0
    assert (t / "S1.diar.json").exists(), "die alte Clusterung darf nicht verloren gehen"
    assert json.loads((t / "S1.diar.json").read_text(encoding="utf-8"))["konfig"] == "alt"
```

- [ ] **Step 4: Test laufen lassen, Erfolg bestätigen**

Run: `.venv/Scripts/python.exe -m pytest webtool/test_correct.py -q`

- [ ] **Step 5: Mutationsprobe**

Die Fingerabdruck-Bedingung aus der Skip-Zeile entfernen ⇒ erste Zusicherung rot. `_sidecar_konfig` fest auf den eigenen Wert ⇒ ebenfalls rot. Das `!= sprecher` im Vorlösch-Zweig auf `True` setzen (also wieder immer löschen) ⇒ der Verlustweg-Test aus Step 3c rot. `min_speakers` aus `konfig_fingerabdruck` nehmen ⇒ ein Fingerabdruck-Test muss rot werden; **wird er es nicht, ist der Hash für C1 blind** und das ist genau der Fehler, gegen den `CODE_STAND` steht. Alles zurückspielen, `__pycache__` leeren.

- [ ] **Step 6: Den Kandidaten selbst übernehmen**

Die gemessene Änderung einbauen:

| Gewinner | zu ändern | Fingerabdruck erfasst ihn über |
|---|---|---|
| C1 | `correct.DIARIZE_MIN_SPEAKERS` | den Parameter `min_speakers` |
| C2 / C4 | `models/…/config.yaml` | den Dateiinhalt |
| C3 | `models/…/config.yaml` + neues Modell in `models/` + Zeile in `LICENSE-MODELLE.md` | den Dateiinhalt |
| C5 | Code in `diarize.py` | **nur `CODE_STAND`** — hochzählen, sonst bleibt der Hash gleich |

Die letzte Zeile ist der Grund, warum `CODE_STAND` überhaupt existiert: eine Code-Änderung, die die Cluster bewegt, ist von aussen nicht hashbar. Wer sie einbaut und die Zahl vergisst, hat den toten Schalter aus #264 zurück.

- [ ] **Step 7: Lokaler Funktionstest**

Wegwerf-Projekt, echte Datei, `python -m webtool.correct run`. Prüfen: das alte Sidecar wird neu gerechnet, das neue trägt den Fingerabdruck, das Ergebnis entspricht dem Messlauf. Danach löschen.

- [ ] **Step 8: README nachziehen**

Ändert sich für den Nutzer die Trennqualität sichtbar, gehört das in den Abschnitt „Es hat zu wenige Sprecher erkannt" — in seinen Worten („erkennt jetzt zuverlässiger, wie viele Personen sprechen"), nicht als Changelog.

- [ ] **Step 9: Commit + PR**

Reviewkette nach den Global Constraints. Die Messtabelle (Nullpunkt gegen Kandidat, **je Datei**) gehört in den PR-Text — sie ist der Beleg, ohne den die Änderung eine Behauptung wäre.

---

# Nicht in diesem Plan

**Phase 3 (Sprecherzahl automatisch schätzen)** und **Phase 4 (Hybrid-Grenze verschieben)** aus der Spec sind hier bewusst **nicht** ausgearbeitet. Beide hängen am Ergebnis von Task 8 Step 4: schliesst die wahre Sprecherzahl die Lücke, ist Phase 3 der nächste Schritt; bleibt ein grosser Rest, liegt der Engpass in den Einbettungen und Phase 4 wird interessanter. Sie jetzt zu planen hiesse, den Aufwand für eine Entscheidung zu treiben, die eine Messung in Kürze trifft. Sie bekommen einen eigenen Plan, sobald die Zahlen vorliegen.

**Offene Punkte, die vor Abschluss Issues werden:**

- Die Referenz ist **nicht unabhängig erhoben** (Spec 3.1) — der Editor zeigt beim Korrigieren den LLM-Vorschlag vor.
- Ob `00111679` nach der Handkorrektur überhaupt messbar wird (Gruppe, die einander ins Wort fällt). Falls nicht: mit Begründung aus dem Referenzsatz nehmen, nicht stillschweigend.
- Der Referenzsatz existiert **nur auf Marcus' Rechner**; kein CI-Lauf reproduziert die Messungen.
- **`diarisierung_aktiv` beantwortet nur den Kill-Switch, nicht die Verfügbarkeit von pyannote.** Fehlt das Paket oder ist die GPU voll, meldet der Endpunkt `true`, das Feld bleibt bedienbar und tut nichts — #266 über den zweiten Weg. Dieselbe Klasse wie „Installiert ≠ angemeldet" bei `llm.available()`. Bewusst nicht in Block A gebaut: eine echte Verfügbarkeitsprüfung hiesse, pyannote im Request-Pfad zu importieren (torch, Sekunden) oder einen Subprozess zu starten.
- **`CODE_STAND` ist ein von Hand gepflegter Zähler.** Wer `diarize.py` so ändert, dass sich die Cluster bewegen, und die Zahl vergisst, bekommt den toten Schalter aus #264 zurück. Ein Test kann das nicht fangen — das gehört als Issue festgehalten, nicht als gelöst behauptet.
