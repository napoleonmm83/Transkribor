# Projekt-Galerie für hunderte Projekte — Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die Startseite trägt hunderte Projekte — auffindbar über Suche und `Ctrl+K`, sortiert nach zuletzt geändert, und der Poll überträgt nur noch, was die Seite anzeigt.

**Architecture:** `GET /api/projects` liefert je Projekt eine Zusammenfassung (Name, zwei Zahlen, mtime, laufende Jobs) statt aller Dateien; die Dateiliste zieht auf `GET /api/projects/{project}`, das nur Arbeitsfläche und Editor rufen. Die Galerie zeigt laufende Projekte als Karten und den Rest als dichte Zeilen mit Sofortsuche. Die Reihenfolge der Tasks ist so gewählt, dass die App **nach jeder Task lauffähig** bleibt: erst der neue Endpunkt (bricht nichts), dann die Verbraucher darauf umstellen, dann den alten schlank machen.

**Tech Stack:** FastAPI + `os.scandir`, React 19 + Vite + TypeScript + Tailwind v4 + shadcn/ui, `cmdk` (bereits vorhanden), vitest + `node --test`, pytest.

## Global Constraints

- **`geaendert` ist `max(Datei-mtime)`, nie die mtime eines Ordners.** Gemessen: Verzeichnis-mtime bewegt sich nicht, wenn eine vorhandene Datei überschrieben wird — und genau das tut der Editor mit `<base>.edit.json`. Rückfall auf die Ordner-mtime nur, wenn ein Projekt **gar keine** Datei hat.
- **`DirEntry.stat()` benutzen, nicht `os.stat(pfad)`** — auf Windows kommt es aus dem Verzeichnislisting und kostet keinen zusätzlichen Zugriff (gemessen: 301 Zugriffe mit wie ohne).
- **Keine neue Abhängigkeit.** `cmdk` und `radix-ui` liegen bereits im Frontend; `react-window` und ein Datenlade-Framework sind ausdrücklich nicht Teil dieser Arbeit.
- **Akzent hell `#4F46E5`, dunkel `#818CF8`. Bernstein und Rot bleiben frei** (sie markieren im Editor unsichere Wörter). Radius 8 px, keine Schatten.
- **Barrierefreiheit ist Anforderung:** Suchfeld mit echtem Label (`sr-only` genügt, kein blosser Platzhalter), Zeilen tastaturerreichbar mit `focus-visible:ring-2 focus-visible:ring-ring`, Zeilenhöhe **44 px**, Trefferzahl über `aria-live="polite"`.
- Schweizer Rechtschreibung: **„ss" statt „ß"**. Kommentare auf Deutsch, Commit-Botschaften ohne Umlaute („ue"/„ae"/„oe").
- Python-Tests laufen mit `.venv/Scripts/python.exe -m pytest webtool build -q` — **nie** `pytest` ohne Pfade (`build` steht in pytests `norecursedirs`). Frontend: `npm --prefix webtool/frontend run test`. Node: `npm run test:electron`.

---

### Task 1: Endpunkt für ein einzelnes Projekt

**Files:**
- Modify: `webtool/app.py` (neue Route neben `list_projects`)
- Modify: `webtool/test_api.py` (oder die Testdatei, in der die Projekt-Endpunkte liegen — vorher suchen)

**Interfaces:**
- Produces: `GET /api/projects/{project}` → `{"name": str, "files": [{base, has_audio, has_raw, has_edit, has_md}]}` — **exakt die Form, die `list_projects()` heute je Projekt liefert**, damit die Verbraucher in Task 2 nichts umbauen müssen.
- Consumes: die vorhandenen Helfer `_bases`, `_audio_bases`, `_raw_path`, `_edit_path`, `_md_path`, `_validate`.

Diese Task **bricht nichts**: sie fügt nur hinzu.

- [ ] **Schritt 1: Die vorhandenen API-Tests finden**

Run: `ls webtool/test_*.py && grep -ln "api/projects" webtool/test_*.py`
Damit steht fest, wohin der neue Test gehört und welchen Stil er hat (TestClient, Fixtures, `TRANSKRIBOR_PROJEKTE`-Umgebung).

- [ ] **Schritt 2: Den fehlschlagenden Test schreiben**

In die gefundene Testdatei, im dortigen Stil. Er muss prüfen:
1. Ein Projekt mit zwei Aufnahmen liefert beide Basisnamen.
2. Die Flags stimmen (eine Datei nur roh, eine mit `edit.json`).
3. Ein unbekanntes Projekt gibt **404**, kein 500.
4. Ein Name mit `..` wird abgewiesen (die vorhandene `_validate`-Prüfung greift).

Die Punkte 3 und 4 sind die eigentlichen Randfälle — der Rest folgt aus der Form.

- [ ] **Schritt 3: Test laufen lassen, Fehlschlag bestätigen**

Run: `.venv/Scripts/python.exe -m pytest webtool -q -k projekt_einzeln`
Expected: FAIL mit 404 (Route existiert nicht).

- [ ] **Schritt 4: Die Route bauen**

In `webtool/app.py`, direkt **nach** `list_projects`. Die Schleife über die Basen ist derselbe Block wie heute in `list_projects` — zieh ihn in eine Hilfsfunktion `_projekt_dateien(name)` heraus und ruf sie aus **beiden** Stellen auf, damit die Form nicht auseinanderläuft:

```python
def _projekt_dateien(project: str):
    """Die Dateiliste eines Projekts. Steht hier einmal, weil sie in Task 3 aus
    list_projects verschwindet und dann nur noch dieser Endpunkt sie liefert."""
    audio = _audio_bases(project)
    return [
        {
            "base": base,
            "has_audio": base in audio,
            "has_raw": os.path.exists(_raw_path(project, base)),
            "has_edit": os.path.exists(_edit_path(project, base)),
            "has_md": os.path.exists(_md_path(project, base)),
        }
        for base in sorted(set(_bases(project)) | audio)
    ]


@app.get("/api/projects/{project}")
def get_project(project: str):
    _validate(project)
    if not os.path.isdir(os.path.join(paths.projekte_root(), project)):
        raise HTTPException(status_code=404, detail="Projekt nicht gefunden")
    return {"name": project, "files": _projekt_dateien(project)}
```

`list_projects` benutzt ab sofort ebenfalls `_projekt_dateien(name)`.

**Achtung Routen-Reihenfolge:** `/api/projects/{project}` darf die bestehenden spezifischeren Routen (`/api/projects/{project}/files/{base}`, `/audio/{base}`, `/correct`, …) nicht verschatten. FastAPI wählt die zuerst passende Route in Definitionsreihenfolge — prüf, dass die neue Route **vor** keiner davon steht, die sie schlucken könnte, und lass die bestehenden Tests laufen.

- [ ] **Schritt 5: Tests laufen lassen**

Run: `.venv/Scripts/python.exe -m pytest webtool build -q`
Expected: alle grün, inklusive der bestehenden Endpunkt-Tests (Beleg, dass keine Route verschattet wurde).

- [ ] **Schritt 6: Committen**

```bash
git add webtool/app.py webtool/test_*.py
git commit -m "feat(api): Endpunkt fuer die Dateien eines einzelnen Projekts"
```

---

### Task 2: Arbeitsfläche und Editor holen ihre Dateien selbst

**Files:**
- Create: `webtool/frontend/src/hooks/useProjectFiles.ts`
- Modify: `webtool/frontend/src/lib/api.ts`
- Modify: `webtool/frontend/src/pages/ProjectWorkspace.tsx`, `webtool/frontend/src/pages/EditorView.tsx`
- Modify: Tests der beiden Seiten

**Interfaces:**
- Consumes: `GET /api/projects/{project}` aus Task 1.
- Produces: `useProjectFiles(project: string) → { files: ProjectFile[], loading: boolean, refresh: () => void }`, wobei `ProjectFile` der vorhandene Typ aus `api.ts` ist.

Nach dieser Task benutzen Arbeitsfläche und Editor `p.files` **nicht mehr** aus `useProjects` — Voraussetzung dafür, dass Task 3 das Feld entfernen kann.

- [ ] **Schritt 1: Lesen, wie die beiden Seiten heute an die Dateien kommen**

Run: `grep -n "useProjects\|\.files\|projects.find" webtool/frontend/src/pages/ProjectWorkspace.tsx webtool/frontend/src/pages/EditorView.tsx webtool/frontend/src/components/Sidebar.tsx`

`Sidebar` bekommt die Dateien als Prop — prüf, von wem, und ändere **nur** die Quelle, nicht die Prop-Form.

- [ ] **Schritt 2: Den fehlschlagenden Test schreiben**

In `webtool/frontend/src/hooks/useProjectFiles.test.ts` (Stil von `useProjects.test.ts` übernehmen, falls vorhanden — sonst von einem anderen Hook-Test):
1. Ruft `GET /api/projects/<name>` und gibt die Dateien zurück.
2. Ein Fehler lässt `files` leer und wirft nicht.
3. `refresh()` ruft erneut.

- [ ] **Schritt 3: Test laufen lassen, Fehlschlag bestätigen**

Run: `npm --prefix webtool/frontend run test -- useProjectFiles`
Expected: FAIL — Modul existiert nicht.

- [ ] **Schritt 4: Hook und API-Funktion bauen**

`api.ts` bekommt eine Funktion neben den vorhandenen (dortigen Stil übernehmen — `get`/`post`-Helfer benutzen, nicht `fetch` von Hand):

```typescript
export function getProjectFiles(project: string): Promise<{ name: string; files: ProjectFile[] }> {
  return get(`/api/projects/${encodeURIComponent(project)}`)
}
```

`useProjectFiles.ts` lädt beim Wechsel von `project` und stellt `refresh` bereit. **Kein Poll** — die Arbeitsfläche erfährt Änderungen über den Job-Status aus `useProjects`, und ein zweiter Poll auf derselben Seite wäre genau die Verdopplung, die diese Arbeit abschafft. `refresh` wird gerufen, wenn ein Job endet.

- [ ] **Schritt 5: Die beiden Seiten umstellen**

`ProjectWorkspace` und `EditorView` benutzen `useProjectFiles(project)` statt `projects.find(...)?.files`. `useProjects` bleibt dort, wo Jobstatus gebraucht wird.

**Der Punkt, an dem es sonst still bricht:** Bisher aktualisierte der 4-Sekunden-Poll die Dateiliste nebenbei — eine neu transkribierte Datei erschien von selbst. Ohne Poll muss `refresh()` gerufen werden, wenn ein Job seinen Endzustand erreicht. Such die Stelle, an der die Seite heute auf Jobende reagiert, und häng es dort an.

- [ ] **Schritt 6: Tests laufen lassen**

Run: `npm --prefix webtool/frontend run test`
Expected: alle grün. Schlagen Seitentests fehl, weil sie `projects[].files` vorgaukelten, stell die Attrappe auf den neuen Endpunkt um — **nicht** den Hook zurückbauen.

- [ ] **Schritt 7: Committen**

```bash
git add webtool/frontend/src
git commit -m "refactor(frontend): Arbeitsflaeche und Editor holen ihre Dateien je Projekt"
```

---

### Task 3: `GET /api/projects` liefert die Zusammenfassung

**Files:**
- Modify: `webtool/app.py` (`list_projects`)
- Modify: `webtool/frontend/src/lib/api.ts` (Typ `Project`)
- Modify: `webtool/frontend/src/pages/HomeGallery.tsx` (nur die zwei Zahlen, noch kein Redesign)
- Modify: Tests auf beiden Seiten

**Interfaces:**
- Produces: `GET /api/projects` → `{"projects": [{name, dateien, fertig, geaendert, active_jobs}]}`.
  `dateien` = Zahl der Basisnamen, `fertig` = Zahl mit `.edit.json`, `geaendert` = float (Unix-Zeit).

- [ ] **Schritt 1: Den fehlschlagenden Test schreiben**

Zwei Tests. Der erste ist die **Gegenprobe aus der Spec** und der eigentliche Wert:

```python
def test_zusammenfassung_zaehlt_dasselbe_wie_die_dateiliste(tmp_path, monkeypatch):
    """Die Zusammenfassung darf nicht anders zaehlen als der Einzelendpunkt.
    Genau diese Gegenprobe hat bei der Messung belegt, dass der schlanke Weg
    dasselbe misst (3963 == 3963)."""
    # Projekt mit gemischtem Bestand anlegen: nur-Audio, nur-roh, fertig
    ...
    zusammenfassung = {p["name"]: p for p in list_projects()["projects"]}
    for name, p in zusammenfassung.items():
        dateien = get_project(name)["files"]
        assert p["dateien"] == len(dateien)
        assert p["fertig"] == sum(1 for f in dateien if f["has_edit"])
```

Der zweite prüft `geaendert` an dem Verhalten, das die Spec gemessen hat:

```python
def test_geaendert_folgt_dem_ueberschreiben_einer_datei(tmp_path, monkeypatch):
    """Verzeichnis-mtime bewegt sich NICHT, wenn eine vorhandene Datei ueberschrieben
    wird — der Editor tut aber genau das mit <base>.edit.json. Deshalb max(Datei-mtime)."""
    # Projekt anlegen, geaendert merken, kurz warten, edit.json ueberschreiben
    # -> geaendert muss groesser geworden sein
```

- [ ] **Schritt 2: Tests laufen lassen, Fehlschlag bestätigen**

Run: `.venv/Scripts/python.exe -m pytest webtool -q -k "zusammenfassung or geaendert"`
Expected: FAIL — `KeyError: 'dateien'`.

- [ ] **Schritt 3: `list_projects` umbauen**

```python
@app.get("/api/projects")
def list_projects():
    """Nur die Zusammenfassung: die Galerie zeigt zwei Zahlen je Projekt, die
    Dateiliste holt sich, wer sie braucht, ueber /api/projects/{project}.
    Gemessen an 300 Projekten: 310 -> 68 ms, 13691 -> 602 Zugriffe, 394 -> 33 KB.
    """
    root = paths.projekte_root()
    out = []
    if not os.path.isdir(root):
        return {"projects": out}
    for eintrag in os.scandir(root):
        if not eintrag.is_dir():
            continue
        try:
            _validate(eintrag.name)
        except (ValueError, HTTPException):
            continue          # un-nennbaren Ordner ueberspringen, nicht die Liste 500en
        # edit_basen separat sammeln statt fertig direkt hochzuzaehlen: eine verwaiste
        # <base>.edit.json (Rohtranskript geloescht, Editordatei stehengeblieben) darf nicht in
        # fertig zaehlen, ohne auch in dateien mitzuzaehlen -- sonst fertig > dateien. Erst nach
        # beiden Durchlaeufen die Schnittmenge mit basen bilden.
        basen, edit_basen, neuste = set(), set(), 0.0
        try:
            for f in os.scandir(paths.transkripte_dir(eintrag.name)):
                # DirEntry.stat() kommt auf Windows aus dem Verzeichnislisting und
                # kostet keinen zusaetzlichen Zugriff (gemessen: 301 mit wie ohne).
                neuste = max(neuste, f.stat().st_mtime)
                n = f.name
                if n.startswith("_") or not n.endswith(".json"):
                    continue
                if n.endswith(".edit.json"):
                    edit_basen.add(n[:-len(".edit.json")])
                    continue
                if n.endswith((".correction.json", ".diar.json")):
                    continue
                basen.add(n[:-len(".json")])
        except FileNotFoundError:
            pass
        try:
            for f in os.scandir(paths.audio_dir(eintrag.name)):
                neuste = max(neuste, f.stat().st_mtime)
                stamm, ext = os.path.splitext(f.name)
                if ext.lower() in AUDIO_EXT:
                    basen.add(stamm)
        except FileNotFoundError:
            pass
        out.append({
            "name": eintrag.name,
            "dateien": len(basen),
            "fertig": len(edit_basen & basen),
            # Ordner-mtime nur als Rueckfall: sie bewegt sich NICHT, wenn eine
            # vorhandene Datei ueberschrieben wird (gemessen) — und genau das tut
            # der Editor. Fuer ein leeres Projekt ist sie aber das Einzige, was es gibt.
            "geaendert": neuste or eintrag.stat().st_mtime,
            "active_jobs": jobs.active_for(eintrag.name),
        })
    return {"projects": out}
```

**Die Basisnamen-Regel oben ist `paths.transcript_bases` nachgebildet und die Stelle, an der man sich schneidet:** Basis ist `<base>.json`, aber `a.edit.json` endet ebenfalls auf `.json` — ein naives `endswith(".json")` erzeugt daraus den Basisnamen `a.edit`. Ausgeschlossen sind deshalb `.edit.json`, `.correction.json`, `.diar.json` und alles, was mit `_` beginnt (`_glossar.json` aus Stufe 2b). Die Gegenprobe aus Schritt 1 fängt genau diesen Fehler.

Falls sich `transcript_bases` je ändert, laufen beide auseinander — dagegen steht der Test, nicht der Kommentar.

- [ ] **Schritt 4: Frontend an die neue Form**

`api.ts`: Typ `Project` bekommt `dateien: number`, `fertig: number`, `geaendert: number`; `files` fällt weg.
`HomeGallery.tsx`: `p.files.length` → `p.dateien`, `done` → `p.fertig`. **Nur das** — das Redesign ist Task 4.

- [ ] **Schritt 5: Alle Tests**

Run: `.venv/Scripts/python.exe -m pytest webtool build -q && npm --prefix webtool/frontend run test`
Expected: alle grün.

- [ ] **Schritt 6: Committen**

```bash
git add webtool/app.py webtool/test_*.py webtool/frontend/src
git commit -m "perf(api): Projektliste liefert nur noch die Zusammenfassung"
```

---

### Task 4: Die Galerie für hunderte Projekte

**Files:**
- Modify: `webtool/frontend/src/pages/HomeGallery.tsx`
- Modify: `webtool/frontend/src/pages/HomeGallery.test.tsx`

**Interfaces:**
- Consumes: `Project` mit `{name, dateien, fertig, geaendert, active_jobs}` aus Task 3.

- [ ] **Schritt 1: Die Tests schreiben**

An `HomeGallery.test.tsx` anhängen (dortigen Stil übernehmen):
1. **Suche filtert sofort** — tippen, ohne Enter, Liste kürzer.
2. **Leere Trefferliste ist ein eigener Zustand** — Text nennt den Suchbegriff, und es gibt einen Weg zurück.
3. **Laufende Projekte stehen oben** und erscheinen **nicht** zusätzlich in der Zeilenliste.
4. **Standardsortierung ist „zuletzt geändert"** — bei drei Projekten mit verschiedenen `geaendert` steht das jüngste zuerst.
5. **Das Suchfeld hat ein zugängliches Label** (`getByLabelText`, nicht `getByPlaceholderText`) — das ist der Test, der die Barrierefreiheitsregel festnagelt.

- [ ] **Schritt 2: Tests laufen lassen, Fehlschlag bestätigen**

Run: `npm --prefix webtool/frontend run test -- HomeGallery`
Expected: die fünf neuen FAIL.

- [ ] **Schritt 3: Die Seite bauen**

Aufbau von oben nach unten:

```
PageHeader „Projekte"                                    [+ Neues Projekt]
Suchfeld (klebend, sr-only-Label, Ctrl+K-Hinweis rechts)
── LÄUFT GERADE · n ──   (nur wenn n > 0)   Karten wie heute, Fortschrittsbalken
── ALLE · n ──           Sortierung: Zuletzt geändert ▾ | Name
Zeilen: Name · „14 Dateien · 14 fertig" · relative Zeit (rechts)
```

Regeln aus dem Designsystem, die hier scharf sind:
- Fläche ist `.blatt`, Radius über Tokens (`rounded-md`/`rounded-lg`), nie das blanke `rounded`.
- Abschnittsüberschriften sind `<h2 className="rubrik">`.
- Seitenbreite bleibt `max-w-5xl`, Polster `p-6 sm:p-8`.
- Nie ein Zeichen als Symbol — immer lucide.
- `truncate` in einem Flex-Container braucht `min-w-0`, sonst verdrängt der lange Projektname die Zahlen rechts, statt zu kürzen.
- Zahlen nicht in eine eigene `<span>` wickeln (zerlegt den Textknoten und bricht `getByText`); `tabular-nums` ans Elternelement.

Zeilenhöhe **44 px**, Hover `hover:bg-muted/60`, Fokus `focus-visible:ring-2 focus-visible:ring-ring`. Die Trefferzahl in der Überschrift bekommt `aria-live="polite"`.

Die relative Zeit („heute", „gestern", „vor 3 Tagen", darüber Datum) mit `Intl.RelativeTimeFormat` bzw. `Intl.DateTimeFormat` — **keine** neue Bibliothek.

- [ ] **Schritt 4: Tests laufen lassen**

Run: `npm --prefix webtool/frontend run test`
Expected: alle grün.

- [ ] **Schritt 5: Im Browser ansehen**

`npm --prefix webtool/frontend run build`, dann `.venv/Scripts/python.exe -m uvicorn webtool.app:app --port 8123` und `http://127.0.0.1:8123` öffnen. Hell **und** dunkel prüfen (Entwicklerwerkzeuge → Rendering → *Emulate CSS prefers-color-scheme*). Danach den Server wieder beenden.

Steht kein Browser zur Verfügung, sag das im Bericht, statt die Prüfung zu behaupten.

- [ ] **Schritt 6: Committen**

```bash
git add webtool/frontend/src/pages
git commit -m "feat(galerie): Suche, laufende Projekte oben, dichte Zeilen, zuletzt geaendert"
```

---

### Task 5: `Ctrl+K` — Projekte von überall

**Files:**
- Create: `webtool/frontend/src/components/ProjektPalette.tsx` + Test
- Modify: die Stelle, an der die App ihre Routen rahmt (`App.tsx` o. ä. — vorher suchen)

**Interfaces:**
- Consumes: `useProjects()`; `useNavigate` aus `react-router-dom`.

- [ ] **Schritt 1: Prüfen, was schon da ist**

Run: `ls webtool/frontend/src/components/ui/ | grep -i command; grep -rn "cmdk" webtool/frontend/src`

Liegt `components/ui/command.tsx` (shadcn) schon vor, **benutz es**. Fehlt es, leg es nach shadcn-Vorlage an — `cmdk` ist als Abhängigkeit vorhanden, es kommt keine neue dazu.

- [ ] **Schritt 2: Den fehlschlagenden Test schreiben**

`ProjektPalette.test.tsx`:
1. `Ctrl+K` öffnet, `Escape` schliesst.
2. Tippen filtert; Enter auf einem Treffer navigiert nach `/p/<name>`.
3. **Das Kürzel greift nicht, während in einem Textfeld getippt wird** — dieselbe Regel wie bei den Audio-Kürzeln im Editor, wo `Ctrl+←→` ausserhalb von Eingaben gilt. Sonst kapert die Palette das Tippen im Suchfeld.

- [ ] **Schritt 3: Test laufen lassen, Fehlschlag bestätigen**

Run: `npm --prefix webtool/frontend run test -- ProjektPalette`

- [ ] **Schritt 4: Bauen**

`CommandDialog` mit `CommandInput`, `CommandEmpty` („Keine Projekte gefunden"), `CommandGroup heading="Läuft gerade"` (nur wenn es welche gibt) und `CommandGroup heading="Projekte"`. Gruppieren ist die ausdrückliche shadcn-Empfehlung für Paletten und trennt hier das Zeitkritische vom Rest.

Einhängen an der obersten Stelle, an der der Router rahmt, damit `Ctrl+K` **auch im Editor** greift — das ist der Grund für die Palette neben dem Suchfeld der Galerie.

- [ ] **Schritt 5: Tests und Blick in den Browser**

Run: `npm --prefix webtool/frontend run test`
Danach wie in Task 4 bauen, starten, `Ctrl+K` im Editor und in der Galerie drücken.

- [ ] **Schritt 6: Committen**

```bash
git add webtool/frontend/src
git commit -m "feat(galerie): Ctrl+K oeffnet die Projektsuche von ueberall"
```

---

### Task 6: Messung wiederholen und dokumentieren

**Files:**
- Modify: `CLAUDE.md` (der Absatz über den Web-Editor / die Endpunkte)

- [ ] **Schritt 1: Die Messung gegen den echten Code wiederholen**

Das Messskript der Spec legt 300 Attrappen an, setzt `TRANSKRIBOR_PROJEKTE` darauf und ruft `list_projects()` direkt. Bau es aus der Spec nach (Tabelle „Messung") und lass es gegen den **jetzigen** Code laufen — der Entwurf von damals ist inzwischen die Umsetzung.

Erwartet wird die Grössenordnung der Spec (~68 ms, ~600 Zugriffe, ~33 KB). **Weicht es stark ab, ist das ein Fund**, kein Rundungsfehler: dann misst der gebaute Code etwas anderes als der Entwurf.

- [ ] **Schritt 2: CLAUDE.md nachziehen**

Im Abschnitt zum Web-Editor ergänzen: `GET /api/projects` liefert die Zusammenfassung, `GET /api/projects/{project}` die Dateien; warum (die gemessenen Zahlen); und dass `geaendert` `max(Datei-mtime)` ist, weil Verzeichnis-mtime das Überschreiben einer Datei nicht sieht.

- [ ] **Schritt 3: Committen und PR stellen**

```bash
git add CLAUDE.md
git commit -m "docs: Galerie-Endpunkte und die Messung dahinter"
```
