# Material-Dialog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Der Bereich „Material hinzufügen" auf der Arbeitsfläche wird ein modaler Dialog mit drei waagrechten Schritten, in dem jede Aufnahme ihre eigene Sprache und Sprecherzahl bekommt und vor dem Start angehört werden kann.

**Architecture:** Ein neuer `MaterialDialog` hält den gesamten Zustand (Schritt, Zeilen, Lauf-Nummer) und komponiert vier reine Bauteile: `Ablageflaeche` (Drop-Ziel), `MaterialZeile` (eine Aufnahme), `HoerBalken` (Abspieler über dem bestehenden `Waveform`) und ein Textfeld für Links. Die Zeilen-Logik (Ergänzen mit Dublettenschutz, Zusammenfassungstexte) liegt als reine Funktionen in `lib/materialZeilen.ts` und ist ohne DOM testbar. Backend-seitig wird `sprache` in `fetch_urls` von einem String zu einer index-parallelen Liste — dieselbe Form, die `sprecher` seit #297 hat.

**Tech Stack:** React 19 · TypeScript · Tailwind v4 · shadcn/ui · vitest + @testing-library/react · FastAPI · pytest · `@wavesurfer/react`

**Spec:** `docs/superpowers/specs/2026-08-20-transkribor-material-dialog-design.md`

## Global Constraints

Diese gelten für **jede** Task. Werte wörtlich aus der Spec.

- **`type="text"` + `inputMode="numeric"` für die Sprecherzahl, NIE `type="number"`** (#264): ein Zahlenfeld liefert bei ungültiger Zwischeneingabe einen leeren `value` und zeigt den getippten Text trotzdem an — leer heisst hier „automatisch", die Zahl verschwände still.
- **Die Gültigkeitsregel steht EINMAL:** `lib/sprecher.ts` → `sprecherWahl(text, max)`. Drei Zustände: `null` = automatisch, `undefined` = ungültig, sonst die Zahl. Nicht nachbauen.
- **Die Obergrenze kommt vom Server** (`sprecher_max` aus `GET …/files/{base}/einstellungen` bzw. dem Projekt-Endpunkt), Rückfall `20`. `sprachen.SPRECHER_MAX` darf kein zweites Mal im Frontend stehen.
- **Eine ungültige Zeile sperrt den ganzen Weiter-/Start-Knopf**, nicht nur ihre Zeile.
- **`auto` ist wählbar, aber nirgends Vorgabe.** Vorgabe ist immer der Projektwert.
- **Der Marker am Wellenanfang heisst „erstes Geräusch", nicht „erste Sprache".** Ein Pegelschwellwert findet Applaus genauso.
- **`URL.revokeObjectURL` erst NACH dem Zerstören der Wavesurfer-Instanz**, nie davor.
- **Aufbewahrter Dialogzustand ist projektgebunden** und wird beim Projektwechsel verworfen, nicht versteckt.
- **Jeder Test wird mutationsgeprüft:** Logik raus → genau dieser Test rot → sauber zurückspielen. Vorher committen (`git checkout` reisst sonst den Fix mit).
- **Nach jeder Mutationsserie `__pycache__` leeren:** `find webtool -name __pycache__ -type d -exec rm -rf {} +`
- **Testläufe nie über eine Pipe in einen `&&`-Vertrag hängen** — der Exitcode wäre der von `tail`.
- **Tests, die den Lifespan betreten oder `fetch.main` fahren, setzen `TRANSKRIBOR_YTDLP_UPDATE=0`** bzw. fälschen `ytdlp_update.beim_start` — sonst startet echtes pip gegen die Entwickler-venv.
- **Tests setzen `TRANSKRIBOR_SETTINGS`** — sonst entscheidet die echte Einstellungsdatei über den KI-Anbieter.

**PR-Grenzen:** Task 1–2 sind ein eigener, unabhängig mergebarer PR (reines Backend). Task 3–8 der zweite. Task 9 gehört in den zweiten PR, nicht in einen dritten — die README-Pflicht gilt im selben PR wie die sichtbare Änderung.

---

## File Structure

| Datei | Verantwortung |
|---|---|
| `webtool/fetch.py` | **ändern** — `_sprache_aus_env(roh, i)`, `download_one(…, sprache=None)` |
| `webtool/app.py` | **ändern** — `FetchBody.sprache` als Liste, Längenprüfung beider Listen, Expansion, dreifach-paarweise Filterung, Env-Schlüssel unbedingt setzen |
| `webtool/test_fetch.py` | **ändern** — Parser + Durchreichung je Index |
| `webtool/test_api.py` | **ändern** — 400 statt 500, Expansion, Altlast-Neutralisierung |
| `webtool/frontend/src/lib/materialZeilen.ts` | **neu** — Zeilentyp + reine Funktionen (ergänzen, zusammenfassen) |
| `webtool/frontend/src/components/MaterialZeile.tsx` | **neu** — eine Zeile, reine Darstellung |
| `webtool/frontend/src/components/Ablageflaeche.tsx` | **neu** — Drop-Ziel, reine Darstellung |
| `webtool/frontend/src/components/HoerBalken.tsx` | **neu** — Abspieler + Blob-Lebenszyklus |
| `webtool/frontend/src/components/MaterialDialog.tsx` | **neu** — Schritte, Zustand, Upload-/Fetch-Orchestrierung |
| `webtool/frontend/src/pages/ProjectWorkspace.tsx` | **ändern** — Bereich raus, Knopf + Drop-Overlay rein |
| `webtool/frontend/src/lib/api.ts` | **ändern** — `fetchUrls`: `sprache` als Liste |
| `webtool/frontend/src/components/UploadDropzone.tsx` | **löschen** (geht in `Ablageflaeche` + Dialog auf) |
| `webtool/frontend/src/components/UrlFetch.tsx` | **löschen** (das Textfeld zieht in den Dialog) |
| `webtool/frontend/src/components/MaterialVorschau.tsx` | **löschen** (geht in `MaterialZeile` + Dialog auf) |
| `README.md`, `CLAUDE.md`, `webtool/frontend/CLAUDE.md` | **ändern** — sichtbare Änderung, Pflicht im selben PR |

---

### Task 1: `fetch.py` — Sprache je Index aus der Umgebung

**Files:**
- Modify: `webtool/fetch.py` (`_sprache_aus_env` neu; `download_one` Signatur; `main`-Schleife)
- Test: `webtool/test_fetch.py`

**Interfaces:**
- Consumes: `sprachen.pruef_fehler(sprache=…)` — die EINE Gültigkeitsquelle
- Produces:
  - `fetch._sprache_aus_env(roh: str | None, i: int) -> str | None`
  - `fetch.download_one(project: str, url: str, sprecher=None, sprache=None) -> str`

- [ ] **Step 1: Den fehlschlagenden Test schreiben**

In `webtool/test_fetch.py` ans Ende:

```python
def test_sprache_aus_env_ist_positionsbasiert_und_wirft_nie():
    """Spiegelbild von `_sprecher_aus_env`: dieselbe Positionslogik, dieselbe sichere
    Richtung. Ein unsinniger Wert heisst „Projekt-Standard", nicht „Absturz im Subprozess
    NACH dem Download" (#185)."""
    assert fetch._sprache_aus_env("ch,en,fr", 0) == "ch"
    assert fetch._sprache_aus_env("ch,en,fr", 2) == "fr"
    # Ein EINZELNER Wert gilt fuer alle — die Rueckwaertskompatibilitaet der bisherigen
    # Variable, die genau einen Sprach-Code trug.
    assert fetch._sprache_aus_env("en", 0) == "en"
    assert fetch._sprache_aus_env("en", 7) == "en"
    # Leerer Eintrag = kein Override fuer DIESE URL, waehrend die Nachbarn einen haben.
    assert fetch._sprache_aus_env("ch,,en", 1) is None
    # Ausserhalb, unbekannt, gar nicht gesetzt -> None, nie ein Wurf.
    assert fetch._sprache_aus_env("ch,en", 5) is None
    assert fetch._sprache_aus_env("klingonisch", 0) is None
    assert fetch._sprache_aus_env(None, 0) is None
    assert fetch._sprache_aus_env("", 0) is None
```

- [ ] **Step 2: Lauf zur Bestätigung, dass er fehlschlägt**

Run: `.venv/Scripts/python.exe -m pytest webtool/test_fetch.py::test_sprache_aus_env_ist_positionsbasiert_und_wirft_nie -v`
Expected: FAIL — `AttributeError: module 'webtool.fetch' has no attribute '_sprache_aus_env'`

- [ ] **Step 3: `_sprache_aus_env` schreiben**

In `webtool/fetch.py` direkt unter `_sprecher_aus_env`:

```python
def _sprache_aus_env(roh, i: int):
    """Die Sprache der i-ten URL aus der Komma-Liste, oder None (= Projekt-Standard).

    Zwilling von `_sprecher_aus_env`, mit einem Unterschied: **ein einzelner Wert ohne
    Komma gilt fuer ALLE URLs.** Die Variable trug bisher genau einen Sprach-Code fuer den
    ganzen Auftrag; wer sie von Hand setzt, meint weiterhin das. Sprach-ids enthalten kein
    Komma (`ch/de/en/fr/it/auto`), die Trennung ist also eindeutig.

    Wirft NIE (#185): ein unbekannter Wert heisst „Projekt-Standard", nicht „Absturz im
    Subprozess NACH dem Download". Gueltigkeit ueber `sprachen.pruef_fehler` — dieselbe
    Quelle wie im HTTP-Weg.
    """
    if not roh:
        return None
    teile = roh.split(",")
    wert = teile[0] if len(teile) == 1 else (teile[i] if 0 <= i < len(teile) else "")
    wert = wert.strip()
    if not wert:
        return None
    return None if sprachen.pruef_fehler(sprache=wert) else wert
```

- [ ] **Step 4: Lauf zur Bestätigung, dass er besteht**

Run: `.venv/Scripts/python.exe -m pytest webtool/test_fetch.py::test_sprache_aus_env_ist_positionsbasiert_und_wirft_nie -v`
Expected: PASS

- [ ] **Step 5: Test für die Durchreichung je Index**

```python
def test_main_reicht_jeder_url_ihre_eigene_sprache_durch(projekt, monkeypatch):
    """Der Index kommt aus der Schleife, nicht aus einem Erfolgszaehler — sonst verschoebe
    ein fehlgeschlagener Download jede folgende Zuordnung."""
    gesehen = []

    def merken(project, url, sprecher=None, sprache=None):
        gesehen.append((url, sprache))
        return f"base{len(gesehen)}"

    monkeypatch.setattr(fetch, "download_one", merken)
    monkeypatch.setenv("TRANSKRIBOR_YTDLP_UPDATE", "0")
    monkeypatch.setenv("TRANSKRIBOR_FETCH_SPRACHE", "ch,en")
    fetch.main(["--download-only", "Demo",
                "https://youtu.be/aaa", "https://youtu.be/bbb"])
    assert gesehen == [("https://youtu.be/aaa", "ch"), ("https://youtu.be/bbb", "en")]
```

- [ ] **Step 6: Lauf — muss fehlschlagen**

Run: `.venv/Scripts/python.exe -m pytest webtool/test_fetch.py::test_main_reicht_jeder_url_ihre_eigene_sprache_durch -v`
Expected: FAIL — `download_one` bekommt kein `sprache`-Argument

- [ ] **Step 7: `download_one` und `main` anpassen**

`download_one`-Signatur ändern (`webtool/fetch.py`):

```python
def download_one(project: str, url: str, sprecher=None, sprache=None) -> str:
```

Im Rumpf die Zeile `sprache = os.environ.get("TRANSKRIBOR_FETCH_SPRACHE")` **ersatzlos
streichen** — die Sprache kommt jetzt als Parameter. Der `setze_datei`-Aufruf bleibt
unverändert (`sprache=sprache or None` behält seine Null-Richtung).

In `main`, neben dem bestehenden `sprecher_roh`:

```python
    # EINMAL gelesen, nicht je URL — wie sprecher_roh daneben.
    sprache_roh = os.environ.get("TRANSKRIBOR_FETCH_SPRACHE")
```

und in der Schleife:

```python
        sprecher = _sprecher_aus_env(sprecher_roh, i)
        sprache = _sprache_aus_env(sprache_roh, i)
        base, fehler = _lade(args.project, url, sprecher, sprache)
```

`_lade` bekommt den Parameter durchgereicht — **an BEIDEN Aufrufstellen** (`fetch.py:465`
und `:481`, die zweite ist der Versuch nach der Selbstheilung; ohne sie verliert genau der
Download seine Sprache, der erst nach einer yt-dlp-Aktualisierung klappt — derselbe Fehler,
den `test_wiederholung_nach_der_selbstheilung_traegt_die_zahl_AUCH_ein` für die
Sprecherzahl festhält).

- [ ] **Step 8: Beide Tests laufen lassen**

Run: `.venv/Scripts/python.exe -m pytest webtool/test_fetch.py -q`
Expected: PASS, keine Regression in den bestehenden Tests

- [ ] **Step 9: Committen**

```bash
git add webtool/fetch.py webtool/test_fetch.py
git commit -m "feat(fetch): Sprache je URL aus der Umgebung, wie schon die Sprecherzahl"
```

- [ ] **Step 10: Mutationsprobe**

Drei Mutationen, je einzeln, jeweils `pytest webtool/test_fetch.py -q` und danach zurück:

| # | Mutation | erwartet rot |
|---|---|---|
| M1 | in `_sprache_aus_env` `teile[i]` → `teile[0]` | Positionstest |
| M2 | `sprachen.pruef_fehler(...)`-Zeile → `return wert` | „klingonisch"-Zusicherung |
| M3 | in `main` die zweite `_lade`-Aufrufstelle ohne `sprache` | Selbstheilungs-Test (nach Analogie zu ergänzen) |

Bleibt eine grün, ist der Test Dekoration — nachbessern, nicht durchwinken.
Danach: `find webtool -name __pycache__ -type d -exec rm -rf {} +`

---

### Task 2: `fetch_urls` nimmt eine Sprachliste

**Files:**
- Modify: `webtool/app.py:927-936` (`FetchBody`), `:940-980` (`fetch_urls`)
- Test: `webtool/test_api.py`

**Interfaces:**
- Consumes: `fetch._sprache_aus_env` aus Task 1 (nur mittelbar, über die Env-Variable)
- Produces: `POST /api/projects/{project}/fetch` akzeptiert `sprache: str | list[str] | None`

- [ ] **Step 1: Die drei fehlschlagenden Tests schreiben**

In `webtool/test_api.py`:

```python
def test_fetch_nimmt_eine_sprache_je_url(client, tmp_projekte, monkeypatch):
    """Gemischtsprachige Projekte sind vorgesehen (projekt.json haelt `sprache` je Base) —
    bisher konnte der URL-Weg als einziger nur EINEN Wert fuer den ganzen Auftrag."""
    gesehen = {}
    monkeypatch.setattr(app_mod.jobs, "start",
                        lambda *a, env=None, **k: gesehen.update(env or {}) or "job1")
    r = client.post("/api/projects/Demo/fetch", json={
        "urls": ["https://youtu.be/aaa", "https://youtu.be/bbb"],
        "sprache": ["ch", "en"]})
    assert r.status_code == 200
    assert gesehen["TRANSKRIBOR_FETCH_SPRACHE"] == "ch,en"


def test_fetch_weist_eine_falsch_lange_sprachliste_mit_400_ab(client, tmp_projekte):
    """400, nicht 500. Ohne eigene Laengenpruefung feuert `zip(..., strict=True)` einen
    rohen ValueError — ausgerechnet an der Stelle, deren Zweck eine saubere Meldung ist."""
    r = client.post("/api/projects/Demo/fetch", json={
        "urls": ["https://youtu.be/aaa", "https://youtu.be/bbb"], "sprache": ["ch"]})
    assert r.status_code == 400
    assert "sprache" in r.json()["detail"]


def test_fetch_setzt_den_sprach_schluessel_IMMER(client, tmp_projekte, monkeypatch):
    """#298: `jobs._run_proc` baut {**os.environ, **job_env(), **env} — das explizite `env`
    gewinnt. Der Durchschlag entsteht durch das BEDINGTE Setzen: fehlt der Schluessel,
    ueberlebt ein Altwert aus der `.env`. Mit der Liste kollabierte er ALLE
    Datei-Entscheidungen auf einen Wert."""
    gesehen = {}
    monkeypatch.setattr(app_mod.jobs, "start",
                        lambda *a, env=None, **k: gesehen.update(env or {}) or "job1")
    monkeypatch.setenv("TRANSKRIBOR_FETCH_SPRACHE", "en")     # Altlast
    r = client.post("/api/projects/Demo/fetch", json={"urls": ["https://youtu.be/aaa"]})
    assert r.status_code == 200
    assert gesehen["TRANSKRIBOR_FETCH_SPRACHE"] == "", \
        "der Schluessel muss gesetzt sein, sonst gewinnt die Altlast aus os.environ"
```

- [ ] **Step 2: Lauf — alle drei müssen fehlschlagen**

Run: `.venv/Scripts/python.exe -m pytest webtool/test_api.py -k "fetch_nimmt_eine_sprache or falsch_lange_sprachliste or sprach_schluessel_IMMER" -v`
Expected: 3 FAIL

- [ ] **Step 3: `FetchBody` erweitern**

`webtool/app.py`, in `class FetchBody`:

```python
    # Index-parallel zu `urls`, wie `sprecher`. Ein EINZELNER String gilt fuer alle URLs und
    # behaelt damit die bisherige Bedeutung — die Variable trug frueher genau einen Code.
    sprache: str | list[str | None] | None = None
```

- [ ] **Step 4: `fetch_urls` umbauen**

Direkt nach der bestehenden `sprecher_roh`-Zeile, **vor** dem `zip`:

```python
    # Erst EXPANDIEREN, dann filtern. Andersherum braeche `strict=True`, und ohne `strict`
    # waere es schlimmer: still gekuerzt heisst hier verschobene Zuordnung.
    if isinstance(body.sprache, list):
        sprache_roh = body.sprache
    else:
        sprache_roh = [body.sprache] * len(body.urls)
    if len(sprache_roh) != len(body.urls):
        raise HTTPException(status_code=400,
                            detail="sprache muss so viele Eintraege haben wie urls")
```

Die paarweise Filterung nimmt die dritte Liste auf:

```python
    drillinge = [(u.strip(), s, l) for u, s, l
                 in zip(body.urls, sprecher_roh, sprache_roh, strict=True) if u.strip()]
    urls = [u for u, _, _ in drillinge]
    sprecher = [s for _, s, _ in drillinge]
    sprachen_liste = [l for _, _, l in drillinge]
```

Die Gültigkeitsprüfung deckt jetzt jeden Eintrag — und die **alte Zeile muss WEG**:

```python
    # ENTFERNEN (app.py:968):
    #   fehler = _sprachen.pruef_fehler(sprache=body.sprache)
    # Mit einer Liste macht `sprache not in SPRACHEN` (sprachen.py:114) einen dict-Lookup
    # mit einer Liste -> `TypeError: unhashable type: 'list'` -> 500 statt 400, ausgerechnet
    # an der Stelle, deren Zweck eine saubere Meldung ist. Bleibt sie stehen, ist die
    # Schleife darunter unerreichbar.
    fehler = None
    for l in sprachen_liste:
        fehler = fehler or _sprachen.pruef_fehler(sprache=l)
    for s in sprecher:
        fehler = fehler or _sprachen.pruef_fehler(sprecher=s)
```

Ein eigener Test dafür, weil ein `TypeError` anders aussieht als ein Validierungsfehler:

```python
def test_fetch_gibt_400_statt_500_wenn_eine_sprache_in_der_liste_unbekannt_ist(client, tmp_projekte):
    """Die alte Einzelpruefung mit `body.sprache` wuerde bei einer Liste WERFEN, nicht
    melden — ein 500 an der Stelle, deren Zweck eine saubere Meldung ist. Gefunden vom
    Faktenpruefer-Subagenten, dessen Bericht aus dem Transkript geborgen wurde."""
    r = client.post("/api/projects/Demo/fetch", json={
        "urls": ["https://youtu.be/a", "https://youtu.be/b"],
        "sprache": ["ch", "klingonisch"]})
    assert r.status_code == 400
    assert "klingonisch" in r.json()["detail"]
```

Und der Env-Aufbau — **unbedingt setzen**:

```python
    # IMMER setzen, auch leer (#298). Fehlt der Schluessel, ueberlebt ein Altwert aus der
    # `.env` in os.environ und kollabiert alle Datei-Entscheidungen auf einen Wert.
    # `_sprache_aus_env("")` liest ihn sauber als „nicht gesetzt" zurueck.
    env_sprache = {"TRANSKRIBOR_FETCH_SPRACHE":
                   ",".join(l or "" for l in sprachen_liste)}
```

**Nicht** dasselbe blind für `TRANSKRIBOR_FETCH_MEHRSPRACHIG` tun: `_mehrsprachig_aus_env("")`
liefert laut #298 `False`, nicht `None` — dort schriebe ein leerer Wert einen echten
Datei-Override fest (die Falle aus #166). Das bleibt für #298 liegen und wird hier **nicht**
angefasst.

- [ ] **Step 5: Lauf zur Bestätigung**

Run: `.venv/Scripts/python.exe -m pytest webtool/test_api.py -q`
Expected: PASS

- [ ] **Step 6: Committen**

```bash
git add webtool/app.py webtool/test_api.py
git commit -m "feat(api): fetch_urls nimmt eine Sprache je URL; Schluessel immer setzen (#298)"
```

- [ ] **Step 7: Mutationsprobe**

| # | Mutation | erwartet rot |
|---|---|---|
| M4 | Längenprüfung für `sprache` entfernen | 400-Test (wird 500) |
| M5 | `env_sprache` wieder bedingt setzen (`if any(sprachen_liste)`) | Altlast-Test |
| M6 | Expansion nach dem `zip` statt davor | Einzelwert-Fall |

Danach `__pycache__` leeren. **Ende PR 1.**

---

### Task 3: `lib/materialZeilen.ts` — die Zeilen-Logik ohne DOM

**Files:**
- Create: `webtool/frontend/src/lib/materialZeilen.ts`
- Test: `webtool/frontend/src/lib/materialZeilen.test.ts`

**Interfaces:**
- Consumes: `sprecherWahl` aus `lib/sprecher.ts`
- Produces:
  - `type Aufnahme = { schluessel: string; anzeige: string; sprecherText: string; sprache: string; datei?: File }`
  - `ergaenzen(alt: Aufnahme[], neu: Aufnahme[]): Aufnahme[]`
  - `sprecherText(zeilen: Aufnahme[], max: number): string`
  - `sprachText(zeilen: Aufnahme[], labels: Record<string, string>): string`
  - `alleGueltig(zeilen: Aufnahme[], max: number): boolean`

**Der Typ heisst `Aufnahme`, NICHT `MaterialZeile`.** `components/MaterialZeile.tsx`
exportiert eine Funktion dieses Namens (Task 4); beide in `MaterialDialog` zu importieren
wäre eine Namenskollision. Ein Alias am Importort wäre die schlechtere Lösung — er stünde
nur an einer Stelle, und die nächste Importstelle machte den Fehler neu.

- [ ] **Step 1: Den fehlschlagenden Test schreiben**

```ts
import { describe, expect, it } from 'vitest'
import { ergaenzen, sprecherText, sprachText, alleGueltig,
         type Aufnahme } from './materialZeilen'

const z = (s: string, extra: Partial<Aufnahme> = {}): Aufnahme =>
  ({ schluessel: s, anzeige: s, sprecherText: '', sprache: 'ch', ...extra })

describe('ergaenzen', () => {
  it('haengt an, statt zu ersetzen — sonst ist „ich habe eine vergessen" Datenverlust', () => {
    expect(ergaenzen([z('a')], [z('b')]).map(x => x.schluessel)).toEqual(['a', 'b'])
  })

  it('erkennt Dubletten auch INNERHALB einer Auswahl', () => {
    /* Zwei gleichnamige Dateien aus verschiedenen Ordnern: ohne mitwachsendes Set
       entstuenden zwei Zeilen mit demselben key — React-Kollision, onAendern traefe
       beide, und der Server kollidierte mit 409. Eine der beiden waere verloren. */
    expect(ergaenzen([], [z('a'), z('a'), z('b')]).map(x => x.schluessel)).toEqual(['a', 'b'])
  })

  it('behaelt die getippte Zahl der schon vorhandenen Zeile', () => {
    const vorher = [z('a', { sprecherText: '5' })]
    expect(ergaenzen(vorher, [z('a')])[0].sprecherText).toBe('5')
  })
})

describe('Zusammenfassung', () => {
  it('zaehlt automatisch und von Hand getrennt', () => {
    expect(sprecherText([z('a'), z('b')], 20)).toBe('2× automatisch')
    expect(sprecherText([z('a', { sprecherText: '3' }), z('b')], 20)).toBe('1 von 2 gesetzt')
  })

  it('fasst eine einheitliche Sprache zu einem Satz zusammen', () => {
    const labels = { ch: 'Schweizerdeutsch', en: 'Englisch' }
    expect(sprachText([z('a'), z('b')], labels)).toBe('Schweizerdeutsch für alle')
    expect(sprachText([z('a'), z('b', { sprache: 'en' })], labels))
      .toBe('1× Schweizerdeutsch, 1× Englisch')
  })
})

describe('alleGueltig', () => {
  it('sperrt bei EINER ungueltigen Zeile — sonst ginge sie als „automatisch" durch', () => {
    expect(alleGueltig([z('a', { sprecherText: '2' }), z('b', { sprecherText: 'x' })], 20))
      .toBe(false)
    expect(alleGueltig([z('a', { sprecherText: '2' }), z('b')], 20)).toBe(true)
  })
})
```

- [ ] **Step 2: Lauf — muss fehlschlagen**

Run: `npm --prefix webtool/frontend run test -- materialZeilen`
Expected: FAIL — Modul existiert nicht

- [ ] **Step 3: Das Modul schreiben**

```ts
import { sprecherWahl } from '@/lib/sprecher'

/** Eine Aufnahme in der Auswahl. `datei` fehlt beim URL-Import — dort gibt es noch nichts. */
export type Aufnahme = {
  schluessel: string      // Dateiname bzw. URL — Dublettenschutz und React-key
  anzeige: string
  sprecherText: string
  sprache: string
  datei?: File
}

/** ERGAENZT die Auswahl; Dubletten am Schluessel fallen weg, die alte Zeile gewinnt.
 *
 *  `bekannt` waechst WAEHREND des Filterns mit — sonst deckt der Schutz nur gegen fruehere
 *  Zeilen und nicht gegen Dubletten in DERSELBEN Auswahl.
 */
export function ergaenzen(alt: Aufnahme[], neu: Aufnahme[]): Aufnahme[] {
  const bekannt = new Set(alt.map(z => z.schluessel))
  const raus: Aufnahme[] = []
  for (const z of neu) {
    if (bekannt.has(z.schluessel)) continue
    bekannt.add(z.schluessel)
    raus.push(z)
  }
  return [...alt, ...raus]
}

export function alleGueltig(zeilen: Aufnahme[], max: number): boolean {
  return zeilen.every(z => sprecherWahl(z.sprecherText, max) !== undefined)
}

export function sprecherText(zeilen: Aufnahme[], max: number): string {
  if (!zeilen.length) return '—'
  const gesetzt = zeilen.filter(z => sprecherWahl(z.sprecherText, max) != null).length
  if (!gesetzt) return `${zeilen.length}× automatisch`
  if (gesetzt === zeilen.length) return `${zeilen.length}× von Hand`
  return `${gesetzt} von ${zeilen.length} gesetzt`
}

export function sprachText(zeilen: Aufnahme[], labels: Record<string, string>): string {
  if (!zeilen.length) return '—'
  const zahl: Record<string, number> = {}
  for (const z of zeilen) zahl[z.sprache] = (zahl[z.sprache] ?? 0) + 1
  const teile = Object.entries(zahl).sort((a, b) => b[1] - a[1])
  if (teile.length === 1) return `${labels[teile[0][0]] ?? teile[0][0]} für alle`
  return teile.map(([id, n]) => `${n}× ${labels[id] ?? id}`).join(', ')
}
```

- [ ] **Step 4: Lauf zur Bestätigung**

Run: `npm --prefix webtool/frontend run test -- materialZeilen`
Expected: PASS

- [ ] **Step 5: Committen**

```bash
git add webtool/frontend/src/lib/materialZeilen.ts webtool/frontend/src/lib/materialZeilen.test.ts
git commit -m "feat(frontend): Zeilen-Logik des Material-Dialogs als reine Funktionen"
```

- [ ] **Step 6: Mutationsprobe**

| # | Mutation | erwartet rot |
|---|---|---|
| M7 | `bekannt.add(z.schluessel)` in der Schleife entfernen | Dubletten-innerhalb-Test |
| M8 | `ergaenzen` → `return neu` | Anhängen-Test |
| M9 | `alleGueltig` → `.some(...)` statt `.every(...)` | Sperr-Test |

---

### Task 4: `MaterialZeile.tsx` — eine Aufnahme, reine Darstellung

**Files:**
- Create: `webtool/frontend/src/components/MaterialZeile.tsx`
- Test: `webtool/frontend/src/components/MaterialZeile.test.tsx`

**Interfaces:**
- Consumes: `Aufnahme` aus `lib/materialZeilen.ts`, `sprecherWahl` aus `lib/sprecher.ts`
- Produces:
```ts
export function MaterialZeile(props: {
  zeile: Aufnahme
  sprachChoices: { id: string; label: string; hint?: string }[]
  sprecherMax: number
  hoerbar: boolean          // false beim URL-Import: noch nichts heruntergeladen
  klingt: boolean
  gesperrt?: boolean
  onSprecher: (schluessel: string, text: string) => void
  onSprache: (schluessel: string, id: string) => void
  onHoeren: (schluessel: string) => void
}): JSX.Element
```

- [ ] **Step 1: Den fehlschlagenden Test schreiben**

```tsx
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MaterialZeile } from './MaterialZeile'

const basis = {
  zeile: { schluessel: 'a', anzeige: 'interview.mp3', sprecherText: '', sprache: 'ch' },
  sprachChoices: [{ id: 'ch', label: 'Schweizerdeutsch' }, { id: 'en', label: 'Englisch' }],
  sprecherMax: 20, hoerbar: true, klingt: false,
  onSprecher: () => {}, onSprache: () => {}, onHoeren: () => {},
}

describe('MaterialZeile', () => {
  it('beschriftet das Sprecherfeld AM Feld, nicht darunter (S1)', () => {
    /* Vorher stand „automatisch" als Platzhalter im Feld und „Anzahl Sprecher" als Zeile
       DARUNTER — der Hinweis kam nach dem Element, das er erklaert. */
    render(<MaterialZeile {...basis} />)
    expect(screen.getByRole('textbox', { name: /Anzahl Sprecher für interview\.mp3/ }))
      .toBeInTheDocument()
  })

  it('ist ein Textfeld, KEIN Zahlenfeld (#264)', () => {
    /* jsdom bildet `badInput` nicht nach — im Browser gemessen: ein Zahlenfeld liefert bei
       „5e" value:"" und zeigt den Text trotzdem. Leer heisst hier „automatisch", die Zahl
       verschwaende also still. Der Unit-Test prueft deshalb den TYP. */
    render(<MaterialZeile {...basis} />)
    const feld = screen.getByRole('textbox', { name: /Anzahl Sprecher/ })
    expect(feld).toHaveAttribute('type', 'text')
    expect(feld).toHaveAttribute('inputmode', 'numeric')
  })

  it('markiert eine ungueltige Eingabe und nennt die Grenze', () => {
    render(<MaterialZeile {...basis}
      zeile={{ ...basis.zeile, sprecherText: '99' }} />)
    const feld = screen.getByRole('textbox', { name: /Anzahl Sprecher/ })
    expect(feld).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText(/1 bis 20/)).toBeInTheDocument()
  })

  it('sperrt den Hoerknopf beim URL-Import und sagt WARUM', () => {
    /* Das Video ist an dieser Stelle nur ein Link — es gibt nichts abzuspielen. Ein still
       toter Knopf waere schlimmer als ein gesperrter mit Begruendung. */
    render(<MaterialZeile {...basis} hoerbar={false} />)
    const knopf = screen.getByRole('button', { name: /interview\.mp3/ })
    expect(knopf).toBeDisabled()
    expect(knopf).toHaveAccessibleName(/heruntergeladen/i)
  })

  it('meldet Sprach- und Sprecheraenderung mit ihrem Schluessel nach oben', () => {
    const onSprecher = vi.fn(); const onSprache = vi.fn()
    render(<MaterialZeile {...basis} onSprecher={onSprecher} onSprache={onSprache} />)
    fireEvent.change(screen.getByRole('textbox', { name: /Anzahl Sprecher/ }),
                     { target: { value: '3' } })
    expect(onSprecher).toHaveBeenCalledWith('a', '3')
    fireEvent.change(screen.getByRole('combobox', { name: /Sprache für interview\.mp3/ }),
                     { target: { value: 'en' } })
    expect(onSprache).toHaveBeenCalledWith('a', 'en')
  })
})
```

- [ ] **Step 2: Lauf — muss fehlschlagen**

Run: `npm --prefix webtool/frontend run test -- MaterialZeile`
Expected: FAIL — Komponente existiert nicht

- [ ] **Step 3: Die Komponente schreiben**

Kern-Anforderungen (das Markup folgt den bestehenden Klassen aus `MaterialVorschau.tsx`):
- Hörknopf links: `<button>` mit `aria-label={hoerbar ? \`Reinhören: ${anzeige}\` : \`${anzeige} — erst nach dem Herunterladen hörbar\`}`, `disabled={!hoerbar}`, `aria-pressed={klingt}`.
- Name mittig, `truncate`, `title={anzeige}`.
- Sprachwähler: natives `<select>` mit `aria-label={\`Sprache für ${anzeige}\`}`. **Nicht shadcn-`Select`** — es rendert ein `<button>`, und eine Zeile mit zehn Radix-Portalen in einer Scrollfläche ist teurer als ein natives Feld. Entspricht dem Vorgehen bei `MehrsprachigKasten` (natives `<input type="checkbox">` statt neuer Abhängigkeit).
- Sprecherfeld als S1-Gruppe: ein Rahmen um `<span class="tag">👤 Sprecher</span>` + `<input type="text" inputMode="numeric">`.
- `const w = sprecherWahl(zeile.sprecherText, sprecherMax)`; bei `w === undefined`: `aria-invalid="true"`, `aria-describedby={hilfeId}` und darunter `<p id={hilfeId}>Bitte eine ganze Zahl von 1 bis {sprecherMax} — oder leer lassen.</p>`
- **`hilfeId` aus `useId()`, NICHT aus dem Schlüssel:** `aria-describedby` ist eine durch Leerzeichen getrennte Liste, und „Interview Mueller.mp3" zerfiele darin in zwei tote Referenzen (#244).
- Die Id nur vergeben, wenn der Text auch da ist — ein `aria-describedby` auf eine nicht existierende Id ist stumm.

Das Gerüst:

```tsx
export function MaterialZeile({ zeile, sprachChoices, sprecherMax, hoerbar, klingt,
                                gesperrt, onSprecher, onSprache, onHoeren }: Props) {
  const hilfeId = useId()
  const w = sprecherWahl(zeile.sprecherText, sprecherMax)
  return (
    <li className="flex min-h-9 items-center gap-2.5">
      <button type="button" disabled={!hoerbar} aria-pressed={klingt}
        aria-label={hoerbar ? `Reinhören: ${zeile.anzeige}`
                            : `${zeile.anzeige} — erst nach dem Herunterladen hörbar`}
        onClick={() => onHoeren(zeile.schluessel)}
        className="flex size-8 shrink-0 items-center justify-center rounded-md border
                   border-input disabled:opacity-40">
        {klingt ? <Pause className="size-3" /> : <Play className="size-3" />}
      </button>

      <span className="min-w-0 flex-1 truncate text-sm" title={zeile.anzeige}>{zeile.anzeige}</span>

      {/* Natives <select>, NICHT shadcn-Select: das rendert ein <button> plus Radix-Portal,
          und zehn davon in einer Scrollflaeche sind teurer als zehn native Felder. Dieselbe
          Abwaegung wie beim Kaestchen in MehrsprachigKasten. */}
      <select value={zeile.sprache} disabled={gesperrt} className="h-9 w-40 shrink-0 rounded-md border border-input bg-transparent px-2 text-sm"
        aria-label={`Sprache für ${zeile.anzeige}`}
        onChange={e => onSprache(zeile.schluessel, e.target.value)}>
        {sprachChoices.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
      </select>

      <div className="w-48 shrink-0">
        <span className="flex h-9 items-center overflow-hidden rounded-md border border-input
                         focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
          <span className="flex h-full shrink-0 items-center gap-1.5 border-r border-input
                           bg-muted px-2 text-xs text-muted-foreground">
            <Users className="size-3.5" aria-hidden="true" /> Sprecher
          </span>
          {/* type="text", NIE type="number" (#264) */}
          <input type="text" inputMode="numeric" value={zeile.sprecherText} disabled={gesperrt}
            placeholder="automatisch"
            aria-label={`Anzahl Sprecher für ${zeile.anzeige}`}
            aria-invalid={w === undefined || undefined}
            aria-describedby={w === undefined ? hilfeId : undefined}
            onChange={e => onSprecher(zeile.schluessel, e.target.value)}
            className="h-full min-w-0 flex-1 bg-transparent px-2.5 text-sm outline-none" />
        </span>
        {w === undefined && (
          <p id={hilfeId} className="mt-1 text-xs text-destructive">
            Bitte eine ganze Zahl von 1 bis {sprecherMax} — oder leer lassen.
          </p>
        )}
      </div>
    </li>
  )
}
```

- [ ] **Step 4: Lauf zur Bestätigung**

Run: `npm --prefix webtool/frontend run test -- MaterialZeile`
Expected: PASS (5 Tests)

- [ ] **Step 5: Committen**

```bash
git add webtool/frontend/src/components/MaterialZeile.tsx webtool/frontend/src/components/MaterialZeile.test.tsx
git commit -m "feat(frontend): MaterialZeile — Sprecherfeld mit Praefix, Sprache je Zeile"
```

- [ ] **Step 6: Mutationsprobe**

| # | Mutation | erwartet rot |
|---|---|---|
| M10 | `type="text"` → `type="number"` | Feldtyp-Test |
| M11 | `hilfeId` aus `useId()` → aus `zeile.schluessel` | (kein Test — **im Browser prüfen**, jsdom sieht die tote Referenz nicht) |
| M12 | `disabled={!hoerbar}` entfernen | URL-Import-Test |
| M13 | `aria-invalid` fest auf `undefined` | Ungültig-Test |

M11 ist bewusst ohne Test: jsdom löst `aria-describedby` nicht auf. Stattdessen im Browser
mit einer Datei namens `Interview Mueller.mp3` prüfen, dass die Beschreibung vorgelesen wird.

---

### Task 5: `HoerBalken.tsx` — Abspieler mit sauberem Lebenszyklus

**Files:**
- Create: `webtool/frontend/src/components/HoerBalken.tsx`
- Test: `webtool/frontend/src/components/HoerBalken.test.tsx`

**Interfaces:**
- Consumes: `Waveform` aus `components/Waveform.tsx` (`{ url: string; onTime: (t: number) => void }`, Handle mit `toggle`/`stop`/`skip`)
- Produces:
```ts
export function HoerBalken(props: {
  datei: File | null        // null = geschlossen, nichts klingt
  anzeige: string
  onSchliessen: () => void
}): JSX.Element | null

export function ersteStelle(peaks: Float32Array, dauer: number): number
```

- [ ] **Step 1: Den fehlschlagenden Test schreiben**

```tsx
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { HoerBalken, ersteStelle } from './HoerBalken'

vi.mock('@/components/Waveform', () => ({
  Waveform: ({ url }: { url: string }) => <div data-testid="welle" data-url={url} />,
}))

const datei = (name: string) => new File(['x'], name, { type: 'audio/mpeg' })

describe('HoerBalken', () => {
  let erzeugt: string[]; let freigegeben: string[]
  beforeEach(() => {
    erzeugt = []; freigegeben = []
    let n = 0
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => { const u = `blob:${++n}`; erzeugt.push(u); return u },
      revokeObjectURL: (u: string) => { freigegeben.push(u) },
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('zeigt nichts, solange keine Datei klingt', () => {
    const { container } = render(<HoerBalken datei={null} anzeige="" onSchliessen={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('gibt die alte Blob-URL frei, wenn eine andere Datei klingt', () => {
    /* Wavesurfer dekodiert die GANZE Datei. Zehn Interviews a 30 Minuten waeren zehn
       Dekodierungen — es klingt deshalb nie mehr als eine, und die vorige wird freigegeben. */
    const { rerender } = render(
      <HoerBalken datei={datei('a.mp3')} anzeige="a.mp3" onSchliessen={() => {}} />)
    rerender(<HoerBalken datei={datei('b.mp3')} anzeige="b.mp3" onSchliessen={() => {}} />)
    expect(freigegeben).toEqual([erzeugt[0]])
    expect(screen.getByTestId('welle')).toHaveAttribute('data-url', erzeugt[1])
  })

  it('gibt die Blob-URL frei, wenn der Balken verschwindet', () => {
    /* Das ist der Ausgang, den die Spec zuerst vergessen hatte: Dialog geschlossen,
       Schrittwechsel, Projektwechsel — und der Fall, dass die klingende Zeile nach einem
       Teil-Fehlschlag aus der Liste faellt. Alle enden hier. */
    const { rerender } = render(
      <HoerBalken datei={datei('a.mp3')} anzeige="a.mp3" onSchliessen={() => {}} />)
    rerender(<HoerBalken datei={null} anzeige="" onSchliessen={() => {}} />)
    expect(freigegeben).toEqual([erzeugt[0]])
  })

  it('nennt den Marker „erstes Geraeusch", nicht „erste Sprache"', () => {
    /* Ein Pegelschwellwert findet Geraeusch. Applaus, Wind und eine zuschlagende Autotuer
       setzen ihn genauso — die Beschriftung darf nicht mehr behaupten als die Messung. */
    render(<HoerBalken datei={datei('a.mp3')} anzeige="a.mp3" onSchliessen={() => {}} />)
    expect(screen.getByText(/erstes Geräusch/i)).toBeInTheDocument()
    expect(screen.queryByText(/erste Sprache/i)).not.toBeInTheDocument()
  })
})

describe('ersteStelle', () => {
  it('findet die erste Stelle ueber der Pegelschwelle, mit Vorlauf', () => {
    /* Der eigentliche Zweck des Balkens: bei Aufnahmen mit langer Stille am Anfang soll
       Play nicht bei 0:00 einsetzen. Reine Funktion, damit sie ohne Audio pruefbar ist. */
    const peaks = new Float32Array([0.002, 0.003, 0.002, 0.9, 0.8, 0.7])
    expect(ersteStelle(peaks, 60)).toBeCloseTo(60 * 3 / 6 - 0.25, 2)
  })

  it('bleibt bei 0, wenn durchgehend gesprochen wird', () => {
    expect(ersteStelle(new Float32Array([0.8, 0.9, 0.85]), 30)).toBe(0)
  })

  it('bleibt bei 0, wenn die Datei stumm ist — statt ans Ende zu springen', () => {
    /* Ohne diesen Zweig setzte die Schleife nie und `erste` bliebe auf einem Initialwert,
       den niemand geprueft hat. Eine stumme Datei ist selten, aber sie ist der Fall, in dem
       eine Sprunghilfe am meisten Schaden anrichten koennte. */
    expect(ersteStelle(new Float32Array([0, 0, 0]), 30)).toBe(0)
  })
})
```

- [ ] **Step 2: Lauf — muss fehlschlagen**

Run: `npm --prefix webtool/frontend run test -- HoerBalken`
Expected: FAIL

- [ ] **Step 3: Die Komponente schreiben**

Kern:

```tsx
export function HoerBalken({ datei, anzeige, onSchliessen }: {...}) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!datei) { setUrl(null); return }
    const u = URL.createObjectURL(datei)
    setUrl(u)
    // Die Aufraeumfunktion deckt ALLE Ausgaenge in einem: Dateiwechsel, Schliessen,
    // Schrittwechsel, Projektwechsel und das Verschwinden der klingenden Zeile nach einem
    // Teil-Fehlschlag. Sie laeuft NACH dem Abbau des Kindes — und genau in dieser
    // Reihenfolge muss es sein: `revokeObjectURL` vor dem Zerstoeren der
    // Wavesurfer-Instanz braeche die laufende Wiedergabe.
    return () => { URL.revokeObjectURL(u) }
  }, [datei])
  if (!datei || !url) return null
  return (/* Kopf mit Play/Pause, Stop (ruft onSchliessen), Name, mm:ss / mm:ss;
             darunter <Waveform url={url} onTime={...} /> und der Marker
             „erstes Geräusch" */)
}
```

Der Balken **rendert `null`, wenn nichts klingt** — dadurch ist „Balken weg" und „Blob frei"
derselbe Vorgang und kann nicht auseinanderlaufen.

Dazu die Sprunghilfe als **reine, exportierte Funktion** (damit sie ohne Audio testbar ist):

```ts
/** Sekunde der ersten Stelle ueber der Pegelschwelle, mit 0,25 s Vorlauf.
 *
 *  Findet GERAEUSCH, nicht Sprache — Applaus und Wind setzen sie genauso. Deshalb heisst
 *  der Marker „erstes Geräusch" und die Funktion verspricht nichts anderes.
 *  Rueckgabe 0 heisst „von vorn": durchgehend laut ODER durchgehend still. Beides ist der
 *  richtige Ausgang — ans Ende einer stummen Datei zu springen waere der Schaden, den eine
 *  Sprunghilfe anrichten kann.
 */
export function ersteStelle(peaks: Float32Array, dauer: number): number {
  let max = 0
  for (const p of peaks) max = Math.max(max, p)
  if (max <= 0) return 0
  const schwelle = max * 0.22
  for (let k = 0; k < peaks.length; k++) {
    if (peaks[k] > schwelle) return Math.max(0, (k / peaks.length) * dauer - 0.25)
  }
  return 0
}
```

Die Peaks liefert `wavesurfer.exportPeaks()`, sobald `ready` gefeuert hat; vorher gibt es
nichts zu springen. Der Sprung setzt einmal je Datei — nicht bei jedem Play, sonst käme man
nach einem bewussten Klick an den Anfang nie dorthin zurück.

- [ ] **Step 4: Lauf zur Bestätigung**

Run: `npm --prefix webtool/frontend run test -- HoerBalken`
Expected: PASS (4 Tests)

- [ ] **Step 5: Committen**

```bash
git add webtool/frontend/src/components/HoerBalken.tsx webtool/frontend/src/components/HoerBalken.test.tsx
git commit -m "feat(frontend): HoerBalken — eine Welle, ein Blob, alle Ausgaenge geben frei"
```

- [ ] **Step 6: Mutationsprobe**

| # | Mutation | erwartet rot |
|---|---|---|
| M14 | `return () => URL.revokeObjectURL(u)` entfernen | beide Freigabe-Tests |
| M15 | Marker-Text → „erste Sprache" | Marker-Test |
| M16 | `if (!datei) return null` entfernen | Leer-Test |
| M17 | `if (max <= 0) return 0` entfernen | Stumm-Test |
| M18 | Schwelle `0.22` → `0` | erster `ersteStelle`-Test |

**Ab hier verschieben sich die Mutationsnummern der Folge-Tasks um zwei** — die Tabellen
unten sind bereits entsprechend nummeriert.

---

### Task 6: `MaterialDialog.tsx` — Schritte, Zustand, Orchestrierung

**Files:**
- Create: `webtool/frontend/src/components/MaterialDialog.tsx`
- Create: `webtool/frontend/src/components/Ablageflaeche.tsx` (Drop-Ziel, ~30 Zeilen, gehört zum Deliverable dieser Task)
- Test: `webtool/frontend/src/components/MaterialDialog.test.tsx`

**Interfaces:**
- Consumes: `ergaenzen`/`alleGueltig`/`sprecherText`/`sprachText` (Task 3), `MaterialZeile` (Task 4), `HoerBalken` (Task 5), `uploadAudio`/`fetchUrls` aus `lib/api.ts`
- Produces:
```ts
export function MaterialDialog(props: {
  project: string
  offen: boolean
  vorbelegteDateien?: File[]        // aus dem Drop-Overlay
  sprachChoices: { id: string; label: string; hint?: string }[]
  projektSprache: string
  sprecherMax: number
  onSchliessen: () => void
  onFertig: (job?: StartJob, art?: 'transcribe' | 'fetch') => void
}): JSX.Element | null
```

- [ ] **Step 0: `api.ts` — `fetchUrls` nimmt die Sprache als Liste**

Ohne diesen Schritt hat Task 2 kein Gegenstück im Frontend, und der Dialog kann die
Datei-Sprachen nicht schicken. Der Parameter bleibt an **Position 3** und wird nur im Typ
breiter:

```ts
export async function fetchUrls(project: string, urls: string[],
                                sprache?: string | (string | null)[],
                                mehrsprachig?: boolean,
                                sprecher?: (number | null)[]): Promise<StartJob> {
  return jn(await fetch(`/api/projects/${enc(project)}/fetch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    // `sprache` faellt nur weg, wenn sie gar nicht gesetzt ist. Eine LEERE Liste waere ein
    // gueltiger Wert und darf nicht als „nicht gesetzt" durchgehen — deshalb `!== undefined`
    // und nicht `sprache ?`, wie es hier bisher stand.
    body: JSON.stringify({ urls, ...(sprache === undefined ? {} : { sprache }),
                           ...(mehrsprachig === undefined ? {} : { mehrsprachig }),
                           ...(sprecher === undefined ? {} : { sprecher }) }),
  }))
}
```

Run: `npm --prefix webtool/frontend exec tsc -- -b` → Expected: keine Fehler bei den
bestehenden Aufrufern (der neue Typ ist eine Erweiterung, keine Verengung).

- [ ] **Step 1: Die fehlschlagenden Tests schreiben**

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MaterialDialog } from './MaterialDialog'
import * as api from '@/lib/api'

vi.mock('@/lib/api')
vi.mock('@/components/HoerBalken', () => ({ HoerBalken: () => null }))

const basis = {
  project: 'Demo', offen: true,
  sprachChoices: [{ id: 'ch', label: 'Schweizerdeutsch' }, { id: 'en', label: 'Englisch' }],
  projektSprache: 'ch', sprecherMax: 20,
  onSchliessen: () => {}, onFertig: () => {},
}
const datei = (n: string) => new File(['x'], n, { type: 'audio/mpeg' })

beforeEach(() => {
  vi.clearAllMocks()   // OHNE das zaehlt jede not.toHaveBeenCalled-Zusicherung fremde Aufrufe
  vi.mocked(api.uploadAudio).mockResolvedValue({ base: 'a', file: 'a.mp3', job_id: 'j', started: true })
  vi.mocked(api.fetchUrls).mockResolvedValue({ job_id: 'j', started: true })
})

describe('MaterialDialog', () => {
  it('schickt je Datei ihre EIGENE Sprache und Sprecherzahl', async () => {
    render(<MaterialDialog {...basis} vorbelegteDateien={[datei('a.mp3'), datei('b.mp3')]} />)
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.change(screen.getByRole('textbox', { name: /Anzahl Sprecher für a\.mp3/ }),
                     { target: { value: '2' } })
    fireEvent.change(screen.getByRole('combobox', { name: /Sprache für b\.mp3/ }),
                     { target: { value: 'en' } })
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.click(screen.getByRole('button', { name: /Los geht/ }))
    await waitFor(() => expect(api.uploadAudio).toHaveBeenCalledTimes(2))
    expect(api.uploadAudio).toHaveBeenNthCalledWith(1, 'Demo', expect.any(File), '', undefined, 2)
    expect(api.uploadAudio).toHaveBeenNthCalledWith(2, 'Demo', expect.any(File), 'en', undefined, undefined)
  })

  it('ein Schrittwechsel verliert NICHTS', async () => {
    /* Die Bedingung, unter der der waagrechte Ablauf ueberhaupt vertretbar ist. */
    render(<MaterialDialog {...basis} vorbelegteDateien={[datei('a.mp3')]} />)
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.change(screen.getByRole('textbox', { name: /Anzahl Sprecher/ }),
                     { target: { value: '7' } })
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.click(screen.getByRole('button', { name: /Zurück/ }))
    expect(screen.getByRole('textbox', { name: /Anzahl Sprecher/ })).toHaveValue('7')
  })

  it('sperrt Weiter, solange EINE Zeile ungueltig ist', () => {
    render(<MaterialDialog {...basis} vorbelegteDateien={[datei('a.mp3'), datei('b.mp3')]} />)
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.change(screen.getByRole('textbox', { name: /Anzahl Sprecher für a/ }),
                     { target: { value: '99' } })
    expect(screen.getByRole('button', { name: /Weiter/ })).toBeDisabled()
  })

  it('traegt die Auswahl eines Projekts NICHT ins naechste', () => {
    /* React Router baut die Seite beim Parameterwechsel nicht neu auf — ohne Reset landeten
       Projekt As Dateien samt Zahl in Projekt B, still und mit Erfolgsmeldung. */
    const { rerender } = render(
      <MaterialDialog {...basis} vorbelegteDateien={[datei('a.mp3')]} />)
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    rerender(<MaterialDialog {...basis} project="Anderes" />)
    expect(screen.queryByText('a.mp3')).not.toBeInTheDocument()
  })

  it('schickt beim URL-Import eine index-parallele Sprachliste', async () => {
    render(<MaterialDialog {...basis} />)
    fireEvent.click(screen.getByRole('tab', { name: /Links/ }))
    fireEvent.change(screen.getByRole('textbox', { name: /Video-URLs/ }),
                     { target: { value: 'https://youtu.be/a\nhttps://youtu.be/b' } })
    fireEvent.click(screen.getByRole('button', { name: /Holen/ }))
    fireEvent.change(screen.getByRole('combobox', { name: /Sprache für https:\/\/youtu\.be\/b/ }),
                     { target: { value: 'en' } })
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.click(screen.getByRole('button', { name: /Los geht/ }))
    await waitFor(() => expect(api.fetchUrls).toHaveBeenCalled())
    // Index 2 = `sprache`. Sie behaelt ihren Platz in der Signatur und wird nur im TYP
    // breiter — ein Umsortieren der Parameter waere eine stille Bruchstelle fuer jeden
    // bestehenden Aufrufer.
    expect(vi.mocked(api.fetchUrls).mock.calls[0][2]).toEqual(['ch', 'en'])
  })

  it('behaelt nach einem Teil-Fehlschlag NUR die gescheiterten Zeilen', async () => {
    vi.mocked(api.uploadAudio)
      .mockResolvedValueOnce({ base: 'a', file: 'a.mp3' })
      .mockRejectedValueOnce(new Error('Netz weg'))
    render(<MaterialDialog {...basis} vorbelegteDateien={[datei('a.mp3'), datei('b.mp3')]} />)
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.click(screen.getByRole('button', { name: /Los geht/ }))
    await waitFor(() => expect(screen.queryByText('a.mp3')).not.toBeInTheDocument())
    expect(screen.getByText('b.mp3')).toBeInTheDocument()
  })

  it('nennt in Schritt 3 den Projekt-Standard, wenn „Automatisch" dabei ist', () => {
    /* Spec 10.1 — die alte Fassung dieses Tests erwartete eine WARNUNG („du verlierst die
       Dialekt-Glaettung"). Sie ist widerlegt: `auto` liefert Schweizerdeutsch nicht von sich
       aus, aber der Projekt-Standard tut es — erkennt Whisper `de` und das Projekt steht auf
       `ch`, gilt `ch` samt Glaettung. Die Warnung stuende also genau fuer die Konstellation
       da, die 10.1 repariert, und schoebe den Nutzer von `auto` weg, wo `auto` richtig ist.
       Der Hinweis steht in der Zusammenfassung, weil die Entscheidung dort noch umkehrbar
       ist. */
    render(<MaterialDialog {...basis} projektSprache="ch"
      sprachChoices={[...basis.sprachChoices, { id: 'auto', label: 'Automatisch' }]}
      vorbelegteDateien={[datei('a.mp3')]} />)
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    expect(screen.queryByText(/Projekt-Standard/i)).not.toBeInTheDocument()  // nicht gewaehlt
    fireEvent.change(screen.getByRole('combobox', { name: /Sprache für a\.mp3/ }),
                     { target: { value: 'auto' } })
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    expect(screen.getByText(/Projekt-Standard/i)).toBeInTheDocument()
    expect(screen.queryByText(/verlier|ohne Dialekt/i)).not.toBeInTheDocument()
  })

  it('nennt den Standard NICHT, wenn er selbst „Automatisch" ist', () => {
    /* Die BEDINGUNG aus 10.1: der zweite Satz nur, wenn der Whisper-Code des Standards nicht
       `None` ist. Bei `projektSprache='auto'` gibt es nichts, was gewinnen koennte — der Satz
       waere eine Zusage ohne Gegenstand. Ohne diesen Test ist die Bedingung Dekoration: der
       Test darueber bliebe auch dann gruen, wenn der Satz IMMER erschiene. */
    render(<MaterialDialog {...basis} projektSprache="auto"
      sprachChoices={[...basis.sprachChoices, { id: 'auto', label: 'Automatisch' }]}
      vorbelegteDateien={[datei('a.mp3')]} />)
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.change(screen.getByRole('combobox', { name: /Sprache für a\.mp3/ }),
                     { target: { value: 'auto' } })
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    expect(screen.queryByText(/Projekt-Standard/i)).not.toBeInTheDocument()
  })

  it('gibt eine aufbewahrte Auswahl nur im SELBEN Projekt zurueck', () => {
    /* Annahme 3 der Spec — und sie widerspraeche §6.1, waere sie nicht projektgebunden:
       getippte Zahlen sind Arbeit, aber As Dateien duerfen nie in B auftauchen. */
    const { rerender } = render(
      <MaterialDialog {...basis} vorbelegteDateien={[datei('a.mp3')]} />)
    fireEvent.click(screen.getByRole('button', { name: /Weiter/ }))
    fireEvent.change(screen.getByRole('textbox', { name: /Anzahl Sprecher/ }),
                     { target: { value: '4' } })
    rerender(<MaterialDialog {...basis} offen={false} />)          // geschlossen
    rerender(<MaterialDialog {...basis} offen />)                  // wieder auf: alles da
    expect(screen.getByRole('textbox', { name: /Anzahl Sprecher/ })).toHaveValue('4')
    rerender(<MaterialDialog {...basis} project="Anderes" offen />) // anderes Projekt: leer
    expect(screen.queryByText('a.mp3')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Lauf — muss fehlschlagen**

Run: `npm --prefix webtool/frontend run test -- MaterialDialog`
Expected: FAIL

- [ ] **Step 3: `Ablageflaeche.tsx` schreiben**

Reine Darstellung, aus `UploadDropzone` herausgelöst — `div role="button"`, `tabIndex={0}`,
`aria-disabled`, Klick und **Enter/Leertaste** öffnen den Dateidialog, `onDrop`/`onDragOver`.
**Die Tastatur bekommt dieselbe Sperre wie die Maus** (PR #297): sonst öffnet Enter den
Dialog, der Nutzer wählt aus, und die Auswahl wird still verworfen — ein toter Weg, der
ausgerechnet die Tastaturbedienung trifft.

- [ ] **Step 4: `MaterialDialog.tsx` schreiben**

Zustand und die Regeln, die nicht verhandelbar sind:

```tsx
const [schritt, setSchritt] = useState(1)
const [zeilen, setZeilen] = useState<Aufnahme[]>([])
const [urlText, setUrlText] = useState('')
const [quelle, setQuelle] = useState<'datei' | 'link'>('datei')
const [laeuft, setLaeuft] = useState(false)
const [klingt, setKlingt] = useState<string | null>(null)
const laufNr = useRef(0)

// Projektwechsel verwirft ALLES — auch den Schritt und den Abspieler. React Router baut
// dieses Element beim Parameterwechsel nicht neu auf. `laufNr.current++` gehoert HIERHER
// und nicht nur ins Abbrechen: sonst schreibt der laufende Upload aus Projekt A sein
// Ergebnis in den Dialog von Projekt B.
useEffect(() => {
  laufNr.current++
  setSchritt(1); setZeilen([]); setUrlText(''); setKlingt(null); setLaeuft(false)
}, [project])
```

Der Start (Schritt 3 → „Los geht's"):

```tsx
const starten = async () => {
  const meiner = ++laufNr.current
  setLaeuft(true); setKlingt(null)          // Ton hoert auf, bevor Zeilen verschwinden
  if (quelle === 'link') {
    // `sprache` bleibt an Position 3 der Signatur und wird nur im Typ breiter.
    const res = await fetchUrls(project, zeilen.map(z => z.schluessel),
                                zeilen.map(z => z.sprache), undefined,
                                zeilen.map(z => sprecherWahl(z.sprecherText, sprecherMax) ?? null))
    if (meiner === laufNr.current) { setLaeuft(false); if (res.started) setZeilen([]) }
    onFertig(res, 'fetch'); return
  }
  const gescheitert: Aufnahme[] = []
  let job: StartJob | undefined
  for (const z of zeilen) {
    try {
      // `?? undefined`, NICHT `?? null`: leer heisst „Feld weglassen" (automatisch).
      const wahl = sprecherWahl(z.sprecherText, sprecherMax) ?? undefined
      const spr = z.sprache === projektSprache ? '' : z.sprache   // kein unnoetiger Override
      const r = await uploadAudio(project, z.datei!, spr, undefined, wahl)
      if (r.job_id) job = { job_id: r.job_id, started: !!r.started }
    } catch (e) {
      if (!/existiert bereits/.test((e as Error).message)) gescheitert.push(z)
    }
  }
  // Nur die GESCHEITERTEN bleiben stehen: „existiert bereits" ist kein Fehlschlag zum
  // Wiederholen, alles Stehenlassen liefe beim naechsten Klick in lauter 409er.
  if (meiner === laufNr.current) { setLaeuft(false); setZeilen(gescheitert) }
  onFertig(job, 'transcribe')      // laeuft IMMER — der Workspace muss seine Liste nachziehen
}
```

Weitere Regeln:
- **`sprache` geht nur mit, wenn sie vom Projektwert ABWEICHT** (`spr` oben). Ein
  mitgeschickter Wert, der ohnehin dem Projekt entspricht, macht daraus einen echten
  Override, und die Datei zieht bei einer späteren Änderung des Projekt-Standards nicht mehr
  mit (#234/#166).
- **Beim URL-Weg wird die volle Liste geschickt**, auch wenn alle gleich sind — sie ist
  index-parallel und muss ihre Plätze halten.
- **Abbrechen ist während des Laufs NICHT gesperrt** — es ist der einzige Rückweg;
  `uploadAudio`/`fetchUrls` haben kein Zeitlimit (#299).
- Weiter ist gesperrt bei `!alleGueltig(zeilen, sprecherMax)` oder `!zeilen.length`.
- Der aufbewahrte Zustand nach dem Schliessen hängt am `project` — beim Wechsel verworfen.

- [ ] **Step 5: Lauf zur Bestätigung**

Run: `npm --prefix webtool/frontend run test -- MaterialDialog`
Expected: PASS (6 Tests)

- [ ] **Step 6: Committen**

```bash
git add webtool/frontend/src/components/MaterialDialog.tsx webtool/frontend/src/components/Ablageflaeche.tsx webtool/frontend/src/components/MaterialDialog.test.tsx
git commit -m "feat(frontend): MaterialDialog — drei Schritte, Sprache und Sprecher je Aufnahme"
```

- [ ] **Step 7: Mutationsprobe**

| # | Mutation | erwartet rot |
|---|---|---|
| M19 | `useEffect([project])`-Reset entfernen | Projektwechsel-Test |
| M20 | `setZeilen(gescheitert)` → `setZeilen([])` | Teil-Fehlschlag-Test |
| M21 | `spr` fest auf `z.sprache` | erster Test (erwartet `''` für die Projektsprache) |
| M22 | Weiter-Sperre entfernen | Gültigkeits-Test |
| M23 | `laufNr`-Vergleich entfernen | (kein Test — **im Browser prüfen**, Rennen) |
| M23a | den Projekt-Standard-Hinweis UNBEDINGT zeigen (Bedingung „Whisper-Code ≠ `None`" raus) | zweiter `auto`-Test (`projektSprache='auto'`) |

---

### Task 7: `ProjectWorkspace` — Bereich raus, Knopf und Overlay rein

**Files:**
- Modify: `webtool/frontend/src/pages/ProjectWorkspace.tsx`
- Test: `webtool/frontend/src/pages/ProjectWorkspace.test.tsx`

**Interfaces:**
- Consumes: `MaterialDialog` (Task 6)
- Produces: keine neuen Exporte

- [ ] **Step 1: Die fehlschlagenden Tests schreiben**

```tsx
it('zeigt den Bereich „Material hinzufügen" nicht mehr auf der Seite', async () => {
  /* B2 der Spec: bei zehn Aufnahmen ist Hinzufuegen ein Randfall und belegte trotzdem den
     ganzen ersten Bildschirm. */
  render(<Workspace />)
  await screen.findByRole('button', { name: /Material/ })
  expect(screen.queryByLabelText('Sprache')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('Video-URLs')).not.toBeInTheDocument()
})

it('sagt es, wenn beim Ablegen keine Audiodatei dabei war', async () => {
  /* Neu durch das seitenweite Overlay: `waehlen` filtert per AUDIO_RE und kehrt bei leerer
     Menge STILL zurueck — bisher nur, wenn man die Ablageflaeche absichtlich traf. */
  render(<Workspace />)
  const flaeche = await screen.findByTestId('drop-overlay-ziel')
  fireEvent.drop(flaeche, { dataTransfer: { files: [new File(['x'], 'brief.pdf')] } })
  expect(await screen.findByText(/keine Audiodatei/i)).toBeInTheDocument()
})
```

- [ ] **Step 2: Lauf — muss fehlschlagen**

Run: `npm --prefix webtool/frontend run test -- ProjectWorkspace`
Expected: FAIL

- [ ] **Step 3: Umbauen**

- Den ganzen `<section className="mb-8">`-Block „Material hinzufügen" entfernen, samt
  `sprachWert`/`mehrWert` und ihren 34 Kommentarzeilen (`ProjectWorkspace.tsx:95-142`) —
  die Entscheidung „Override oder nicht" liegt jetzt im Dialog.
- `sprache`/`mehrsprachig`-State bleibt für das Badge und wird an den Dialog gereicht.
- Im `PageHeader` vor „Transkribieren": `<Button onClick={() => setDialogOffen(true)}>+ Material</Button>`
- Drop-Overlay: `onDragOver` am Seitencontainer setzt `zieht=true`, `onDrop` filtert per
  `AUDIO_RE`; bei leerer Menge `toast.info('Keine Audiodatei dabei — es passiert nichts.')`,
  sonst `setVorbelegt(audio); setDialogOffen(true)`.
- `<MaterialDialog … />` am Ende rendern.

```tsx
const AUDIO_RE = /\.(mp3|wav|m4a|aac|flac|ogg|opus|wma|mp4)$/i
const [dialogOffen, setDialogOffen] = useState(false)
const [vorbelegt, setVorbelegt] = useState<File[]>([])
const [zieht, setZieht] = useState(false)

// Das Overlay liegt ueber der GANZEN Arbeitsflaeche — es faengt damit Drops, die vorher an
// der Ablageflaeche vorbeigingen. Ein PDF irgendwo fallen zu lassen darf deshalb nicht
// still nichts tun: `waehlen` filterte frueher und kehrte wortlos zurueck, was in Ordnung
// war, solange man die Zone absichtlich treffen musste.
<div className="p-6 sm:p-8" data-testid="drop-overlay-ziel"
  onDragOver={e => { e.preventDefault(); setZieht(true) }}
  onDragLeave={() => setZieht(false)}
  onDrop={e => {
    e.preventDefault(); setZieht(false)
    const audio = Array.from(e.dataTransfer.files).filter(f => AUDIO_RE.test(f.name))
    if (!audio.length) { toast.info('Keine Audiodatei dabei — es passiert nichts.'); return }
    setVorbelegt(audio); setDialogOffen(true)
  }}>
  {zieht && (
    <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center
                    border-2 border-dashed border-primary bg-background/80">
      <p className="text-sm font-medium">Zum Hinzufügen loslassen</p>
    </div>
  )}
  {/* … Kopf, Job-Leisten, Dateiliste … */}
  <MaterialDialog project={project!} offen={dialogOffen} vorbelegteDateien={vorbelegt}
    sprachChoices={einstellungen?.sprach_choices ?? []}
    projektSprache={einstellungen?.sprache ?? ''} sprecherMax={sprecherMax}
    onSchliessen={() => { setDialogOffen(false); setVorbelegt([]) }}
    onFertig={(job, art) => {
      refresh(); refreshFiles()
      if (job?.started) { adopt(job.job_id, project!, art ?? 'transcribe'); toast.success('Gestartet') }
      else if (job) toast.info('Läuft schon — die neuen Dateien kommen danach dran.')
    }} />
</div>
```

**`pointer-events-none` am Overlay ist Pflicht**, nicht Kosmetik: ohne es fängt die
Fläche das `drop`-Ereignis selbst ab, und der Handler am Container darunter feuert nie.

- [ ] **Step 4: Lauf zur Bestätigung**

Run: `npm --prefix webtool/frontend run test -- ProjectWorkspace`
Expected: PASS

- [ ] **Step 5: Committen**

```bash
git add webtool/frontend/src/pages/ProjectWorkspace.tsx webtool/frontend/src/pages/ProjectWorkspace.test.tsx
git commit -m "feat(frontend): Arbeitsflaeche zeigt die Dateiliste, Material kommt per Dialog"
```

- [ ] **Step 6: Mutationsprobe**

| # | Mutation | erwartet rot |
|---|---|---|
| M24 | Nicht-Audio-Meldung entfernen | PDF-Test |
| M25 | Den alten Bereich wieder einblenden | erster Test |

---

### Task 8: Altlasten entfernen

**Files:**
- Delete: `webtool/frontend/src/components/UploadDropzone.tsx` + `.test.tsx`
- Delete: `webtool/frontend/src/components/UrlFetch.tsx` + `.test.tsx`
- Delete: `webtool/frontend/src/components/MaterialVorschau.tsx` + `.test.tsx`

- [ ] **Step 1: Prüfen, dass niemand mehr importiert**

Run: `grep -rn "UploadDropzone\|UrlFetch\|MaterialVorschau" webtool/frontend/src/ --include=*.tsx --include=*.ts`
Expected: keine Treffer ausser in den zu löschenden Dateien selbst.

- [ ] **Step 2: Zusicherungen retten, die kein Nachfolger hat**

Vor dem Löschen jede der drei Testdateien durchgehen: jede Zusicherung, die in Task 3–7
**keinen** Nachfolger hat, dort ergänzen. Erwartete Kandidaten: das Tastatur-Schloss der
Ablagefläche, „existiert bereits ist kein Fehlschlag", die `useId`-Regel. **Eine gelöschte
Zusicherung ohne Nachfolger ist eine stille Abdeckungslücke** — sie fällt in keinem roten
Lauf auf, weil die Datei mit ihr verschwindet.

- [ ] **Step 3: Löschen**

```bash
git rm webtool/frontend/src/components/UploadDropzone.tsx webtool/frontend/src/components/UploadDropzone.test.tsx \
       webtool/frontend/src/components/UrlFetch.tsx webtool/frontend/src/components/UrlFetch.test.tsx \
       webtool/frontend/src/components/MaterialVorschau.tsx webtool/frontend/src/components/MaterialVorschau.test.tsx
```

- [ ] **Step 4: Voller Lauf, Typprüfung und Build — jeweils EINZELN**

```bash
npm --prefix webtool/frontend run test
npm --prefix webtool/frontend exec tsc -- -b
npm --prefix webtool/frontend run build
```

**Die Gesamtzahl der Tests notieren und mit dem Stand vor Task 3 vergleichen.** Eine
unparsebare Testdatei läuft **still gar nicht** und fällt nur an der Zahl auf, nicht an einem
roten Lauf — genau so verschwanden in PR #297 zwölf Tests unbemerkt.

- [ ] **Step 5: Committen**

```bash
git commit -m "refactor(frontend): UploadDropzone, UrlFetch und MaterialVorschau entfallen"
```

---

### Task 9: README und Anleitungen nachziehen

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `webtool/frontend/CLAUDE.md`

Die README-Pflicht gilt **im selben PR** wie die sichtbare Änderung — sie ist das Einzige,
was ein neuer Nutzer je liest, und sie beschreibt den Stand des letzten **Releases**.

- [ ] **Step 1: README — im Ton einer Anleitung, nicht eines Changelogs**

Unter dem passenden Abschnitt, in Nutzerworten: dass Aufnahmen jetzt über einen Knopf
„+ Material" hinzugefügt werden, dass man **pro Aufnahme** Sprache und Sprecherzahl setzt,
und dass man vor dem Start **kurz reinhören** kann. Kein `?sprecher=`-Jargon, keine
Dateinamen. Falls seit dem letzten Release noch nicht veröffentlicht: den
Inline-Versionshinweis setzen („ab der nächsten Fassung").

- [ ] **Step 2: `webtool/frontend/CLAUDE.md`** — den Abschnitt „Die Sprecherzahl wird beim
HINFÜGEN abgefragt" durch den Dialog ersetzen. Aufnehmen: die Blob-Freigabe-Reihenfolge,
warum der Sprachwähler nativ ist, warum `sprache` nur bei Abweichung mitgeht, und dass das
Modal den Abbrechen-Knopf laufender Jobs verdeckt.

- [ ] **Step 3: Wurzel-`CLAUDE.md`** — bei den Env-Variablen ergänzen, dass
`TRANSKRIBOR_FETCH_SPRACHE` jetzt eine **Komma-Liste** sein darf (ein Einzelwert gilt für
alle) und **immer** gesetzt wird.

- [ ] **Step 4: Committen**

```bash
git add README.md CLAUDE.md webtool/frontend/CLAUDE.md
git commit -m "docs: Material-Dialog in README und Anleitungen"
```

**Achtung:** `CLAUDE.md` ist gitignoriert (#110) — sie muss mit `git add -f` hinzugefügt
werden **oder** sie bleibt bewusst aussen vor. Vor einem Rebase aus Index/Stash nehmen.
Niemals `git add -A`.

---

## Vor dem PR

- [ ] **Lokaler Funktionstest im Browser**, auf einem **Wegwerf-Projekt**, nie auf
  `projekte\`-Daten: zehn Dateien hinzufügen, Sprachen mischen, reinhören, scrubben, durch
  alle drei Schritte, „Los geht's". Screenshot als Beleg.
- [ ] **Die drei ausstehenden Messungen aus Spec §7** durchführen und das Ergebnis in die
  Spec nachtragen: `.mp4`-Dekodierung, Dekodierkosten bei 30 Minuten, die feste Rahmenhöhe.
  Dazu die vierte: erscheinen Sonner-Toasts über dem Dialog?
- [ ] **`superpowers:requesting-code-review`**, dann CodeRabbit CLI, dann Bot — in dieser
  Reihenfolge. Die Spec-Reviewstufe ist ausgefallen (beide Subagenten lieferten nichts) und
  wird hier nachgeholt; im PR-Text als das benennen.
- [ ] **Offene Punkte als Issues anlegen**, bevor der PR als fertig gilt.
