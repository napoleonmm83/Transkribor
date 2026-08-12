# Sprache pro Datei nachträglich wählbar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sprache und Korrektur-Tiefe nachträglich pro bereits liegender Datei änderbar machen — Sprache-Wechsel triggert Neu-Transkription, Tiefe-Wechsel Neu-Korrektur, über einen neuen Datei-Einstellungsdialog im ⋯-Menü.

**Architecture:** Datei-Pendant des bestehenden Projekt-Einstellungs-Endpunkts (`GET/PUT …/files/{base}/einstellungen`) als reiner Schreibpfad; das Frontend entscheidet nach dem Speichern anhand der Änderung, welchen bestehenden Job-Endpunkt (`…/transcribe` bzw. `…/correct`) es anstößt — beide bringen ihre eigene 409-Sperre, Job-Adoption und Editor-Logik mit. Datenmodell (`projekt.setze_datei`) und Job-Endpunkte stehen bereits; diese Planung fügt nur die HTTP-Schicht, den Dialog und die Verkabelung hinzu.

**Tech Stack:** Python/FastAPI (Backend), React 19 + TypeScript + Vite + shadcn/ui + vitest + testing-library (Frontend), pytest (Backend).

**Spec:** `docs/superpowers/specs/2026-08-12-transkribor-datei-sprache-nachtraeglich-design.md`

## Global Constraints

- **Sprache-IDs / Tiefe-IDs** kommen ausschließlich aus `webtool/sprachen.py` (`SPRACHEN`/`TIEFEN`); nie hardcoden. Default `sprache="ch"`, `korrektur="auto"` (`SPRACH_DEFAULT`/`TIEFE_DEFAULT`).
- **Projektname/Base validieren** über `_validate(project, base)` (`paths.safe_name`), sonst 400 — wie jeder File-Endpunkt.
- **Trust-Boundary:** der `PUT …/einstellungen` ist ein **reiner Schreibpfad ohne 409-Sperre** (wie `upload_audio`, das auch `setze_datei` während eines Laufs ruft). Trigger laufen über die **bestehenden** `…/transcribe`/`…/correct`-Endpunkte, die ihrerseits `_keine_jobs` prüfen.
- **Keine neue Abhängigkeit.** `Languages`-Icon ist in `lucide-react` bereits vorhanden (verifiziert).
- **`projekt.json`-Race = Issue #134** (offen, vorbestehend). #135 nutzt denselben `setze_datei`-Pfad und wird NICHT hier behoben.
- **README + CLAUDE.md** werden im selben PR nachgezogen (Projektregel: nutzer­sichtbare Änderung → README).
- **Backend-Tests** müssen `TRANSKRIBOR_SETTINGS` setzen (die `client`-Fixture tut das); sonst entscheidet die echte Einstellungsdatei des Entwicklers über den KI-Anbieter. Die `client`-Fixture in `webtool/test_api.py:8` liefert das Demo-Projekt mit `S1` (Roh-JSON + `S1.mp3`-Audio).
- **Commit-Style:** Conventional Commits (`feat(backend): …`, `feat(frontend): …`, `docs: …`), deutscher Haupttext, `Co-Authored-By: Claude <noreply@anthropic.com>` am Ende. Branch: `feat/datei-sprache-nachtraeglich` (bereits erstellt).

## File Structure

- **`webtool/app.py`** (modify) — zwei neue Endpunkte `GET/PUT /api/projects/{project}/files/{base}/einstellungen`. Kein neues Modul: sie sind das direkte Datei-Pendant der Projekt-Endpunkte bei Zeile 234–247 und nutzen vorhandene Helfer (`_validate`, `find_audio`, `_raw_path`, `_projekt`, `_sprachen`) plus die vorhandene `EinstellungenBody`-Klasse.
- **`webtool/test_api.py`** (modify) — Backend-Tests für die beiden Endpunkte, angelehnt an den Block „Projekteinstellungen" ab Zeile 960.
- **`webtool/frontend/src/lib/api.ts`** (modify) — `getFileEinstellungen`/`saveFileEinstellungen`, Zwillinge der Projekt-Funktionen. Typ `ProjectEinstellungen` aus `types.ts` passt unverändert (Shape identisch).
- **`webtool/frontend/src/lib/api.test.ts`** (modify) — Unit-Tests für die beiden neuen Funktionen.
- **`webtool/frontend/src/components/DateiEinstellungenDialog.tsx`** (create) — Dialog, spiegelt `ProjektEinstellungenDialog.tsx`, ergänzt kontext-abhängigen Hinweis + dynamischen Knopf-Text. Schreibt nur den Override; meldet Änderung via `onGespeichert` zurück (Trigger entscheidet der Aufrufer).
- **`webtool/frontend/src/components/DateiEinstellungenDialog.test.tsx`** (create) — Hinweis je Szenario, Knopf deaktiviert bei nichts-geändert, `onGespeichert`-Flags.
- **`webtool/frontend/src/components/DateiMenue.tsx`** (modify) — Menüeintrag „Sprache & Korrektur-Tiefe", Dialog-Instanz, `einstellungenGespeichert`-Handler (Trigger-Verzweigung, wiederverwendet `jobStarten`/`korrekturFertig`/`editorVergessen`/`wegVomEditor`).
- **`webtool/frontend/src/components/DateiMenue.test.tsx`** (modify) — Trigger-Verkabelung: Sprache-Änderung → retranscribe, nur-Tiefe → correct(force=true).
- **`README.md`** (modify) — Nutzer-Hinweis im Sprachauswahl-Abschnitt.
- **`CLAUDE.md`** (modify) — Architektur-Fakt im Stil der bestehenden Sprachauswahl-Einträge. **Achtung:** CLAUDE.md ist gitignored (#110) — nicht mit `git add -A` einsammeln; separat hinzufügen und committen, siehe [[gitignorierte-datei-ueberlebt-rebase-nicht]].

---

### Task 1: Backend — Datei-Einstellungs-Endpunkte (GET/PUT)

**Files:**
- Modify: `webtool/app.py` (Einfügen nach `projekteinstellungen_speichern`, Zeile ~247 — das Datei-Pendant direkt beim Projekt-Zwilling)
- Test: `webtool/test_api.py` (neuer Block am Ende des „Projekteinstellungen"-Bereichs, Zeile ~981)

**Interfaces:**
- Consumes: `_validate(project, base)`, `find_audio(project, base)`, `_raw_path(project, base)`, `_projekt.datei_sprache/datei_korrektur/setze_datei`, `_sprachen.fuer_frontend()`/`_sprachen.TIEFEN`, `EinstellungenBody` (alle vorhanden).
- Produces:
  - `GET /api/projects/{project}/files/{base}/einstellungen` → `{sprache: str, korrektur: str, sprach_choices: [...], tiefen: [...]}` (effektive Werte via `datei_sprache`/`datei_korrektur`); 404, wenn weder Audio noch Roh-JSON liegen; 400 bei ungültigem Namen.
  - `PUT …/einstellungen` mit `EinstellungenBody {sprache?, korrektur?}` → `{sprache, korrektur}` (nach `setze_datei`); 400 bei ungültigem Namen; keine 409-Sperre.

- [ ] **Step 1: Schreibe die fehlschlagenden Backend-Tests**

Ans Ende von `webtool/test_api.py` anfügen (nach dem Block ab Zeile 960, der mit `test_upload_schreibt_datei_sprache` endet):

```python
# --- Datei-Einstellungen: Sprache + Tiefe pro einzelne Datei (#135) -------------

def test_dateieinstellungen_liefert_effektive_werte(client, tmp_projekt):
    r = client.get(f"/api/projects/{tmp_projekt}/files/S1/einstellungen")
    assert r.status_code == 200
    d = r.json()
    assert d["sprache"] == "ch"          # System-Default, kein Override gesetzt
    assert d["korrektur"] == "auto"
    assert isinstance(d["sprach_choices"], list) and d["sprach_choices"]
    assert isinstance(d["tiefen"], list) and d["tiefen"]


def test_dateieinstellungen_unbekannte_datei_404(client, tmp_projekt):
    # Weder Audio noch Roh-JSON -> die Datei existiert fuer die API nicht.
    assert client.get(f"/api/projects/{tmp_projekt}/files/nope/einstellungen").status_code == 404


def test_dateieinstellungen_invalid_name_400(client, tmp_projekt):
    assert client.get(f"/api/projects/{tmp_projekt}/files/a:b/einstellungen").status_code == 400


def test_dateieinstellungen_speichern_schreibt_override(client, tmp_projekt):
    import webtool.projekt as projekt
    r = client.put(f"/api/projects/{tmp_projekt}/files/S1/einstellungen", json={"sprache": "en"})
    assert r.status_code == 200
    assert r.json()["sprache"] == "en"
    # Override tatsächlich in projekt.json gelandet (datei_sprache siegt über Projekt-Default):
    assert projekt.datei_sprache(tmp_projekt, "S1") == "en"
    # GET liefert den neuen effektiven Wert:
    assert client.get(f"/api/projects/{tmp_projekt}/files/S1/einstellungen").json()["sprache"] == "en"


def test_dateieinstellungen_speichern_ignoriert_none(client, tmp_projekt):
    # Leerer Body -> nichts ändert sich, kein Fehler (EinstellungenBody ist komplett optional).
    r = client.put(f"/api/projects/{tmp_projekt}/files/S1/einstellungen", json={})
    assert r.status_code == 200
    assert r.json()["korrektur"] == "auto"
```

- [ ] **Step 2: Tests laufen lassen — sie müssen fehlschlagen**

Run: `.venv\Scripts\python.exe -m pytest webtool/test_api.py -k dateieinstellungen -q`
Expected: FAIL (404 für alle, Endpunkt existiert nicht).

- [ ] **Step 3: Implementiere die beiden Endpunkte**

In `webtool/app.py`, direkt nach der Funktion `projekteinstellungen_speichern` (endet Zeile 247) einfügen:

```python
@app.get("/api/projects/{project}/files/{base}/einstellungen")
def dateieinstellungen(project: str, base: str):
    """Effektive Sprache + Korrektur-Tiefe EINER Datei (Override, sonst Projekt-Standard) plus
    die Auswahlen — das Datei-Pendant des Projekt-Endpunkts (s. projekteinstellungen)."""
    _validate(project, base)
    if not find_audio(project, base) and not os.path.exists(_raw_path(project, base)):
        raise HTTPException(status_code=404, detail=f"keine Datei: {base}")
    return {"sprache": _projekt.datei_sprache(project, base),
            "korrektur": _projekt.datei_korrektur(project, base),
            "sprach_choices": _sprachen.fuer_frontend(), "tiefen": _sprachen.TIEFEN}


@app.put("/api/projects/{project}/files/{base}/einstellungen")
def dateieinstellungen_speichern(project: str, base: str, body: EinstellungenBody):
    """Schreibt den Datei-Override (sprache/korrektur). Reiner Schreibpfad — kein Job-Start,
    keine 409-Sperre: derselbe sperrfreie Weg wie ``upload_audio`` (``setze_datei``), denn ein
    laufender Job hat seine Sprache beim Start bereits gelesen. Die Trigger (Neu-Transkription
    bei Sprache-Wechsel, Neu-Korrektur bei Tiefe-Wechsel) stößt das Frontend über die
    bestehenden ``…/transcribe``/``…/correct``-Endpunkte an — die ihrerseits ``_keine_jobs``
    prüfen. Siehe Spec #135."""
    _validate(project, base)
    _projekt.setze_datei(project, base, sprache=body.sprache, korrektur=body.korrektur)
    return {"sprache": _projekt.datei_sprache(project, base),
            "korrektur": _projekt.datei_korrektur(project, base)}
```

- [ ] **Step 4: Tests laufen lassen — sie müssen durch**

Run: `.venv\Scripts\python.exe -m pytest webtool/test_api.py -k dateieinstellungen -q`
Expected: PASS (5 Tests).

- [ ] **Step 5: Volle Backend-Suite (Regression)**

Run: `.venv\Scripts\python.exe -m pytest webtool/test_api.py -q`
Expected: PASS (keine bestehenden Tests beschädigt — der neue Endpunkt berührt nichts Bestehendes).

- [ ] **Step 6: Commit**

```bash
git add webtool/app.py webtool/test_api.py
git commit -m "feat(backend): Datei-Einstellungs-Endpunkt Sprache/Tiefe (#135)

GET/PUT /api/projects/{p}/files/{base}/einstellungen als reiner Schreibpfad;
Trigger laufen über die bestehenden transcribe/correct-Endpunkte."
```

---

### Task 2: Frontend — API-Schicht + Tests

**Files:**
- Modify: `webtool/frontend/src/lib/api.ts` (Einfügen nach `saveProjektEinstellungen`, Zeile ~34)
- Test: `webtool/frontend/src/lib/api.test.ts` (im `describe('ProjektEinstellungen', …)`-Block oder eigenem `describe('DateiEinstellungen')`)

**Interfaces:**
- Consumes: `ProjectEinstellungen` (aus `types.ts`), Helfer `enc`/`get`/`jn` (in `api.ts`).
- Produces:
  - `getFileEinstellungen(project: string, base: string): Promise<ProjectEinstellungen>`
  - `saveFileEinstellungen(project: string, base: string, patch: Partial<ProjectEinstellungen>): Promise<ProjectEinstellungen>`

- [ ] **Step 1: Schreibe die fehlschlagenden API-Tests**

In `webtool/frontend/src/lib/api.test.ts` einen neuen `describe`-Block anfügen (z. B. nach dem `ProjektEinstellungen`-Block):

```ts
describe('DateiEinstellungen', () => {
  it('getFileEinstellungen GETt den codierten Datei-Pfad', async () => {
    const fm = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ sprache: 'ch', korrektur: 'auto', sprach_choices: [], tiefen: [] }) })
    vi.stubGlobal('fetch', fm)
    await api.getFileEinstellungen('Food Festival', 'A B')
    expect(fm).toHaveBeenCalledWith('/api/projects/Food%20Festival/files/A%20B/einstellungen')
  })

  it('saveFileEinstellungen PUTt JSON und gibt die Antwort zurück', async () => {
    const fm = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ sprache: 'en', korrektur: 'auto', sprach_choices: [], tiefen: [] }) })
    vi.stubGlobal('fetch', fm)
    const r = await api.saveFileEinstellungen('p', 'a', { sprache: 'en' })
    expect(fm).toHaveBeenCalledWith('/api/projects/p/files/a/einstellungen',
      expect.objectContaining({ method: 'PUT', headers: { 'Content-Type': 'application/json' } }))
    expect(r.sprache).toBe('en')
  })
})
```

- [ ] **Step 2: Tests laufen lassen — sie müssen fehlschlagen**

Run: `npm --prefix webtool/frontend test -- --run api.test.ts`
Expected: FAIL (`api.getFileEinstellungen is not a function`).

- [ ] **Step 3: Implementiere die beiden Funktionen**

In `webtool/frontend/src/lib/api.ts`, direkt nach `saveProjektEinstellungen` (Zeile ~34) einfügen:

```ts
/** Per-Datei-Einstellungen (Override, sonst Projekt-Standard) — Datei-Pendant von
 *  getProjektEinstellungen. Liefert dieselben Auswahlen (sprach_choices/tiefen). */
export async function getFileEinstellungen(project: string, base: string): Promise<ProjectEinstellungen> {
  return get(`/api/projects/${enc(project)}/files/${enc(base)}/einstellungen`)
}
/** Schreibt den Datei-Override; nur gesetzte Felder senden (Partial) — wie saveProjektEinstellungen.
 *  Reiner Schreibpfad; die Trigger (retranscribe/correct) stößt der Aufrufer separat an. */
export async function saveFileEinstellungen(
  project: string, base: string, patch: Partial<ProjectEinstellungen>,
): Promise<ProjectEinstellungen> {
  return jn(await fetch(`/api/projects/${enc(project)}/files/${enc(base)}/einstellungen`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }))
}
```

- [ ] **Step 4: Tests laufen lassen — sie müssen durch**

Run: `npm --prefix webtool/frontend test -- --run api.test.ts`
Expected: PASS (neue 2 + bestehende).

- [ ] **Step 5: Commit**

```bash
git add webtool/frontend/src/lib/api.ts webtool/frontend/src/lib/api.test.ts
git commit -m "feat(frontend): API-Funktionen Datei-Einstellungen (#135)"
```

---

### Task 3: Frontend — DateiEinstellungenDialog-Komponente

**Files:**
- Create: `webtool/frontend/src/components/DateiEinstellungenDialog.tsx`
- Test: Create `webtool/frontend/src/components/DateiEinstellungenDialog.test.tsx`

**Interfaces:**
- Consumes: `getFileEinstellungen`/`saveFileEinstellungen` (Task 2), `ProjectEinstellungen`/`ProjectFile` (types), shadcn `Dialog`/`Select`/`Button`.
- Produces: `DateiEinstellungenDialog`-Komponente mit Props `{ project, base, file, offen?, onOpenChange?, onGespeichert? }`. `onGespeichert` erhält `{ spracheGeaendert: boolean; tiefeGeaendert: boolean }`. Der Dialog entscheidet NICHT über Trigger — er schreibt nur den Override und meldet die Änderung.

- [ ] **Step 1: Schreibe die fehlschlagenden Komponenten-Tests**

Create `webtool/frontend/src/components/DateiEinstellungenDialog.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import * as api from '@/lib/api'
import { DateiEinstellungenDialog } from './DateiEinstellungenDialog'
import type { ProjectFile } from '@/lib/types'

const BASIS = {
  sprache: 'ch', korrektur: 'auto',
  sprach_choices: [
    { id: 'ch', label: 'Schweizerdeutsch', hint: '' },
    { id: 'en', label: 'Englisch', hint: '' },
  ],
  tiefen: [{ id: 'voll_dialekt', label: 'Voll (mit Dialekt)' }, { id: 'leicht', label: 'Leicht' }],
}
const datei = (p: Partial<ProjectFile> = {}): ProjectFile =>
  ({ base: 'a', has_audio: true, has_raw: true, has_edit: false, has_md: false, ...p })

/** shadcn-Select öffnen: der Trigger portalt nach document.body; container-Query greift nicht. */
const spracheWaehlen = async (label: string) => {
  fireEvent.click(document.body.querySelector('[role="combobox"]')!)
  fireEvent.click(await screen.findByText(label))
}

describe('DateiEinstellungenDialog', () => {
  it('lädt die effektiven Werte und zeigt sie an', async () => {
    const getSpy = vi.spyOn(api, 'getFileEinstellungen').mockResolvedValue(BASIS)
    render(<DateiEinstellungenDialog project="p" base="a" file={datei()} offen />)
    await waitFor(() => expect(screen.getByText('Schweizerdeutsch')).toBeInTheDocument())
    getSpy.mockRestore()
  })

  it('deaktiviert Speichern, solange nichts geändert ist', async () => {
    vi.spyOn(api, 'getFileEinstellungen').mockResolvedValue(BASIS)
    render(<DateiEinstellungenDialog project="p" base="a" file={datei()} offen />)
    expect(await screen.findByText('Speichern')).toBeDisabled()
  })

  it('zeigt bei Sprache-Änderung + has_raw den Transkriptions-Hinweis und den Trigger-Knopf', async () => {
    vi.spyOn(api, 'getFileEinstellungen').mockResolvedValue(BASIS)
    render(<DateiEinstellungenDialog project="p" base="a" file={datei({ has_edit: true })} offen />)
    await screen.findByText('Schweizerdeutsch')
    await spracheWaehlen('Englisch')
    expect(screen.getByText(/erfordert Neu-Transkription/)).toBeInTheDocument()
    expect(screen.getByText(/handbearbeiteten Fassung/)).toBeInTheDocument()   // has_edit
    expect(screen.getByRole('button', { name: 'Speichern & neu transkribieren' })).toBeEnabled()
  })

  it('zeigt bei nur-Tiefe-Änderung den Korrektur-Knopf', async () => {
    vi.spyOn(api, 'getFileEinstellungen').mockResolvedValue(BASIS)
    render(<DateiEinstellungenDialog project="p" base="a" file={datei()} offen />)
    await screen.findByText('Voll (mit Dialekt)')   // SelectTrigger zeigt die Tiefen-Auswahl
    // Tiefe-Select (zweiter combobox) auf "Leicht" stellen:
    const comboboxes = document.body.querySelectorAll('[role="combobox"]')
    fireEvent.click(comboboxes[comboboxes.length - 1])
    fireEvent.click(await screen.findByText('Leicht'))
    expect(screen.getByRole('button', { name: 'Speichern & neu korrigieren' })).toBeEnabled()
  })

  it('ruft onGespeichert mit den richtigen Flags und speichert nur bei Änderung', async () => {
    const saveSpy = vi.spyOn(api, 'saveFileEinstellungen')
      .mockResolvedValue({ ...BASIS, sprache: 'en' })
    const onGespeichert = vi.fn()
    const onOpenChange = vi.fn()
    vi.spyOn(api, 'getFileEinstellungen').mockResolvedValue(BASIS)
    render(<DateiEinstellungenDialog project="p" base="a" file={datei()} offen
      onOpenChange={onOpenChange} onGespeichert={onGespeichert} />)
    await screen.findByText('Schweizerdeutsch')
    await spracheWaehlen('Englisch')
    fireEvent.click(screen.getByRole('button', { name: 'Speichern & neu transkribieren' }))
    await waitFor(() => expect(saveSpy).toHaveBeenCalledWith('p', 'a', expect.objectContaining({ sprache: 'en' })))
    expect(onGespeichert).toHaveBeenCalledWith({ spracheGeaendert: true, tiefeGeaendert: false })
    expect(onOpenChange).toHaveBeenCalledWith(false)
    saveSpy.mockRestore()
  })

  it('zeigt bei !has_raw den Hinweis zur nächsten Transkription und keinen Trigger-Knopf', async () => {
    vi.spyOn(api, 'getFileEinstellungen').mockResolvedValue(BASIS)
    render(<DateiEinstellungenDialog project="p" base="a" file={datei({ has_raw: false })} offen />)
    await screen.findByText('Schweizerdeutsch')
    await spracheWaehlen('Englisch')
    expect(screen.getByText(/nächsten Transkription/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /neu transkribieren/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Speichern' })).toBeEnabled()
  })
})
```

- [ ] **Step 2: Tests laufen lassen — sie müssen fehlschlagen**

Run: `npm --prefix webtool/frontend test -- --run DateiEinstellungenDialog.test.tsx`
Expected: FAIL (Modul/Komponente existiert nicht).

- [ ] **Step 3: Implementiere die Komponente**

Create `webtool/frontend/src/components/DateiEinstellungenDialog.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { getFileEinstellungen, saveFileEinstellungen } from '@/lib/api'
import type { ProjectEinstellungen, ProjectFile } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'

/** Sprache + Korrektur-Tiefe EINER bereits liegenden Datei. Spiegelt
 *  `ProjektEinstellungenDialog`, ergänzt den kontext-abhängigen Hinweis und den dynamischen
 *  Knopf-Text. Der Dialog schreibt NUR den Override (`saveFileEinstellungen`); welche
 *  Neuberechnung nötig ist, entscheidet der Aufrufer via `onGespeichert` — denn die Job-Hooks
 *  (Adoption, Editor-Reload) hängen in `DateiMenue`.
 *
 *  Verzweigung (Spec #135): Sprache-Änderung + has_raw -> Neu-Transkription (dominiert, zieht
 *  die Korrektur nach); nur Tiefe + has_raw -> Neu-Korrektur; !has_raw -> nur Override. */
export function DateiEinstellungenDialog({ project, base, file, offen, onOpenChange, onGespeichert }: {
  project: string
  base: string
  file: ProjectFile
  offen?: boolean
  onOpenChange?: (o: boolean) => void
  onGespeichert?: (a: { spracheGeaendert: boolean; tiefeGeaendert: boolean }) => void
}) {
  const [data, setData] = useState<ProjectEinstellungen | null>(null)
  const [sprache, setSprache] = useState('')
  const [korrektur, setKorrektur] = useState('')
  const [laedt, setLaedt] = useState(false)
  const [speichert, setSpeichert] = useState(false)

  useEffect(() => {
    if (!offen) return
    let aktiv = true
    setLaedt(true)
    getFileEinstellungen(project, base)
      .then(d => { if (aktiv) { setData(d); setSprache(d.sprache); setKorrektur(d.korrektur) } })
      .catch(e => { if (aktiv) toast.error(`Einstellungen laden fehlgeschlagen: ${(e as Error).message}`) })
      .finally(() => { if (aktiv) setLaedt(false) })
    return () => { aktiv = false }
  }, [offen, project, base])

  const spracheGeaendert = !!data && sprache !== data.sprache
  const tiefeGeaendert = !!data && korrektur !== data.korrektur
  const geaendert = spracheGeaendert || tiefeGeaendert
  // Sprache-Wechsel dominiert (Neu-Transkription deckt die Tiefe über die Autokorrektur-Kette ab).
  const trigger = file.has_raw && geaendert
    ? (spracheGeaendert ? 'transcribe' : 'correct')
    : 'none'

  const knopf =
    trigger === 'transcribe' ? 'Speichern & neu transkribieren'
    : trigger === 'correct' ? 'Speichern & neu korrigieren'
    : 'Speichern'

  const hinweis =
    !file.has_raw ? 'Wird bei der nächsten Transkription verwendet.'
    : trigger === 'transcribe'
      ? `Neue Sprache erfordert Neu-Transkription: Transkript, Korrektur und Export werden verworfen (Audio bleibt)${file.has_edit ? ', inkl. der handbearbeiteten Fassung' : ''}.`
    : trigger === 'correct'
      ? (file.has_edit ? 'Die handbearbeitete Fassung wird überschrieben.'
                       : 'Die Korrektur wird mit der neuen Tiefe neu erstellt.')
    : ''

  const speichernFn = async () => {
    if (!geaendert) return
    setSpeichert(true)
    try {
      await saveFileEinstellungen(project, base, { sprache, korrektur })
      onGespeichert?.({ spracheGeaendert, tiefeGeaendert })
      onOpenChange?.(false)
    } catch (e) {
      toast.error(`Speichern fehlgeschlagen: ${(e as Error).message}`)
    } finally {
      setSpeichert(false)
    }
  }

  return (
    <Dialog open={offen} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sprache &amp; Korrektur-Tiefe — „{base}“</DialogTitle>
        </DialogHeader>
        {laedt ? (
          <p className="text-sm text-muted-foreground">Laden …</p>
        ) : data && (
          <div className="grid gap-4">
            <div>
              <label id="lbl-fs-sprache" className="mb-1.5 block text-sm font-medium">Sprache</label>
              <Select value={sprache} onValueChange={setSprache}>
                <SelectTrigger className="w-full" aria-labelledby="lbl-fs-sprache"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {data.sprach_choices.map(c => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.label}{c.hint && ` — ${c.hint}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label id="lbl-fs-tiefe" className="mb-1.5 block text-sm font-medium">Korrektur-Tiefe</label>
              <Select value={korrektur} onValueChange={setKorrektur}>
                <SelectTrigger className="w-full" aria-labelledby="lbl-fs-tiefe"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {data.tiefen.map(t => (
                    <SelectItem key={t.id} value={t.id}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {hinweis && <p className="text-sm text-muted-foreground">{hinweis}</p>}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange?.(false)} disabled={speichert}>Abbrechen</Button>
          <Button onClick={speichernFn} disabled={!data || speichert || !geaendert}>{knopf}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 4: Tests laufen lassen — sie müssen durch**

Run: `npm --prefix webtool/frontend test -- --run DateiEinstellungenDialog.test.tsx`
Expected: PASS (6 Tests).

- [ ] **Step 5: Commit**

```bash
git add webtool/frontend/src/components/DateiEinstellungenDialog.tsx webtool/frontend/src/components/DateiEinstellungenDialog.test.tsx
git commit -m "feat(frontend): DateiEinstellungenDialog (#135)

Sprache/Tiefe pro Datei mit kontext-abhängigem Hinweis und dynamischem
Knopf-Text; schreibt nur den Override, meldet Änderung via onGespeichert."
```

---

### Task 4: Frontend — DateiMenue-Eintrag + Trigger-Verkabelung

**Files:**
- Modify: `webtool/frontend/src/components/DateiMenue.tsx`
- Test: Modify `webtool/frontend/src/components/DateiMenue.test.tsx`

**Interfaces:**
- Consumes: `DateiEinstellungenDialog` (Task 3), `startRetranscribeFile`/`startCorrectFile` (bereits importiert), `jobStarten`/`korrekturFertig`/`editorVergessen`/`wegVomEditor` (in `DateiMenue` vorhanden), `Languages` aus `lucide-react`.
- Produces: Menüeintrag „Sprache & Korrektur-Tiefe" zwischen „Umbenennen" und dem Trenner; Handler `einstellungenGespeichert`, der bei `has_raw` + Sprache-Änderung retranscribe (Editor vergisst + verlässt), bei nur-Tiefe correct(`force=true`, Editor lädt nach) anstößt.

- [ ] **Step 1: Schreibe die fehlschlagenden Tests**

In `webtool/frontend/src/components/DateiMenue.test.tsx`:

(a) Im `beforeEach` (ab Zeile 31) die Mocks für die neuen API-Funktionen ergänzen — damit der automock nicht mit `undefined` reißt:

```ts
  vi.mocked(api.getFileEinstellungen).mockResolvedValue({
    sprache: 'ch', korrektur: 'auto',
    sprach_choices: [{ id: 'ch', label: 'Schweizerdeutsch', hint: '' }, { id: 'en', label: 'Englisch', hint: '' }],
    tiefen: [{ id: 'voll_dialekt', label: 'Voll' }, { id: 'leicht', label: 'Leicht' }],
  })
  vi.mocked(api.saveFileEinstellungen).mockResolvedValue({
    sprache: 'ch', korrektur: 'auto', sprach_choices: [], tiefen: [],
  })
```

(b) Neuen `describe`-Block anfügen (z. B. nach dem `Löschen`-Block):

```tsx
describe('Sprache & Korrektur-Tiefe', () => {
  const spracheAendern = async () => {
    await menueOeffnen()
    fireEvent.click(await screen.findByText('Sprache & Korrektur-Tiefe'))
    // Der Dialog portalt nach document.body; der sprache-Select ist der erste combobox darin.
    await screen.findByText('Schweizerdeutsch')
    fireEvent.click(document.body.querySelector('[role="combobox"]')!)
    fireEvent.click(await screen.findByText('Englisch'))
  }

  it('änderte Sprache stößt Neu-Transkription an (und verlässt den Editor)', async () => {
    render(<Huelle pfad="/p/P/a"><DateiMenue project="P" file={datei()} /></Huelle>)
    await spracheAendern()
    fireEvent.click(screen.getByRole('button', { name: 'Speichern & neu transkribieren' }))
    await waitFor(() => expect(api.saveFileEinstellungen).toHaveBeenCalledWith('P', 'a', expect.objectContaining({ sprache: 'en' })))
    await waitFor(() => expect(api.startRetranscribeFile).toHaveBeenCalledWith('P', 'a'))
    expect(screen.getByTestId('ort')).toHaveTextContent('/p/P')   // Editor verlassen
  })

  it('nur geänderte Tiefe stößt Neu-Korrektur mit force=true an (Editor bleibt)', async () => {
    render(<Huelle pfad="/p/P/a"><DateiMenue project="P" file={datei()} /></Huelle>)
    await menueOeffnen()
    fireEvent.click(await screen.findByText('Sprache & Korrektur-Tiefe'))
    await screen.findByText('Voll')
    // Tiefe-Select ist der letzte combobox im Dialog.
    const comboboxes = document.body.querySelectorAll('[role="combobox"]')
    fireEvent.click(comboboxes[comboboxes.length - 1])
    fireEvent.click(await screen.findByText('Leicht'))
    fireEvent.click(screen.getByRole('button', { name: 'Speichern & neu korrigieren' }))
    await waitFor(() => expect(api.startCorrectFile).toHaveBeenCalledWith('P', 'a', true))
    expect(screen.getByTestId('ort')).toHaveTextContent('/p/P/a')  // Editor bleibt (Korrektur)
  })

  it('ohne has_raw wird nur gespeichert (kein Trigger)', async () => {
    render(<Huelle><DateiMenue project="P" file={datei({ has_raw: false })} /></Huelle>)
    await spracheAendern()
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
    await waitFor(() => expect(api.saveFileEinstellungen).toHaveBeenCalled())
    expect(api.startRetranscribeFile).not.toHaveBeenCalled()
    expect(api.startCorrectFile).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Tests laufen lassen — sie müssen fehlschlagen**

Run: `npm --prefix webtool/frontend test -- --run DateiMenue.test.tsx`
Expected: FAIL (Menüeintrag „Sprache & Korrektur-Tiefe" nicht gefunden).

- [ ] **Step 3: Verkable den Eintrag + Handler in `DateiMenue.tsx`**

(a) Import ergänzen — `Languages` zur lucide-Zeile (Zeile 4) und die neue API-Funktion + das neue Modul:

```tsx
import { Bot, Languages, MoreHorizontal, Pencil, RotateCcw, Trash2 } from 'lucide-react'
```

am Dateiende des Imports die Komponente importieren (bei den anderen Komponenten-Imports, z. B. unter dem `UmbenennenDialog`-Import, Zeile ~7):

```tsx
import { DateiEinstellungenDialog } from './DateiEinstellungenDialog'
```

(b) State für den Dialog — neben `const [umbenennen, setUmbenennen] = useState(false)` (Zeile ~41):

```tsx
  const [einstellungen, setEinstellungen] = useState(false)
```

(c) Handler — neben `umbenannt` (nach Zeile ~124) einfügen. Sprache-Wechsel dominiert (retranscribe, zieht Korrektur nach); nur Tiefe -> correct mit `force=true`; `!has_raw` -> nur Override. Die Trigger wiederverwenden die bestehende `jobStarten`/`korrekturFertig`/`editorVergessen`/`wegVomEditor`-Logik — kein zweiter Job-Mechanismus.

```tsx
  /** Sprache/Tiefe geändert und gespeichert -> die nötige Neuberechnung anstossen. Sprache-Wechsel
   *  dominiert (Neu-Transkription, die Kette zieht die Korrektur nach); nur Tiefe -> Neu-Korrektur
   *  mit force=true (sonst überspränge correct.py eine human_edited-Datei still). Ohne has_raw
   *  bleibt es beim Override — die nächste Transkription übernimmt ihn. */
  const einstellungenGespeichert = ({ spracheGeaendert, tiefeGeaendert }: {
    spracheGeaendert: boolean; tiefeGeaendert: boolean }) => {
    toast.success(`Einstellungen für „${file.base}“ gespeichert`)
    if (!file.has_raw) return
    if (spracheGeaendert) {
      jobStarten(() => startRetranscribeFile(project, file.base)
        .then(res => { if (res.started) { editorVergessen(); wegVomEditor() }; return res }),
        'transcribe', `Neu transkribieren ${file.base}`)
    } else if (tiefeGeaendert) {
      jobStarten(() => startCorrectFile(project, file.base, true), 'correct',
        `Neu korrigieren ${file.base}`, korrekturFertig)
    }
  }
```

(d) Menüeintrag — im `DropdownMenuContent`, zwischen dem Umbenennen-Eintrag (endet Zeile ~181) und dem `<DropdownMenuSeparator />` (Zeile ~182) einfügen:

```tsx
            <DropdownMenuItem onSelect={() => setEinstellungen(true)}>
              <Languages /> Sprache &amp; Korrektur-Tiefe
            </DropdownMenuItem>
```

(e) Dialog-Instanz — außerhalb des Menüs (wie `UmbenennenDialog`), z. B. direkt nach dem `<UmbenennenDialog … />`-Block (Zeile ~193) einfügen:

```tsx
      <DateiEinstellungenDialog project={project} base={file.base} file={file}
        offen={einstellungen} onOpenChange={setEinstellungen}
        onGespeichert={einstellungenGespeichert} />
```

- [ ] **Step 4: Tests laufen lassen — sie müssen durch**

Run: `npm --prefix webtool/frontend test -- --run DateiMenue.test.tsx`
Expected: PASS (neue 3 + bestehende).

- [ ] **Step 5: Volle Frontend-Suite (Regression)**

Run: `npm --prefix webtool/frontend test -- --run`
Expected: PASS.

- [ ] **Step 6: Typecheck + Build**

Run: `npm --prefix webtool/frontend run build`
Expected: Build erfolgreich (Type-Check inklusive).

- [ ] **Step 7: Commit**

```bash
git add webtool/frontend/src/components/DateiMenue.tsx webtool/frontend/src/components/DateiMenue.test.tsx
git commit -m "feat(frontend): Datei-Einstellungen im ⋯-Menü + Trigger (#135)

Sprache-Wechsel -> Neu-Transkription, nur-Tiefe -> Neu-Korrektur (force);
wiederverwendet jobStarten/korrekturFertig/editorVergessen/wegVomEditor."
```

---

### Task 5: Doku — README + CLAUDE.md

**Files:**
- Modify: `README.md` (Sprachauswahl-Abschnitt)
- Modify: `CLAUDE.md` (**gitignored** — siehe Global Constraints; separat `git add CLAUDE.md`)

**Interfaces:** keine (Doku).

- [ ] **Step 1: README — Nutzer-Hinweis nachziehen**

In `README.md` den Abschnitt zur Sprachauswahl (der aus PR #133/README-Pflege stammt) um den nachträglichen Datei-Wechsel ergänzen. Eine bis zwei Sätze in Nutzer-Sprache (kein Changelog-Ton), sinngemäß:

> Sprache oder Korrektur-Tiefe nachträglich pro einzelner Aufnahme ändern: im ⋯-Menü der Datei „Sprache & Korrektur-Tiefe“. Eine andere Sprache erfordert eine Neu-Transkription (das alte Transkript wird verworfen, das Audio bleibt); eine andere Korrektur-Tiefe startet nur die Korrektur neu.

Die exakte Stelle anhand des bestehenden Sprachauswahl-Abschnitts wählen; dort einordnen, wo der Nutzer sie beim Lesen erwartet (neben der Upload-Sprachauswahl). Vor dem Commit `README.md` lesen und prüfen, dass die Aussage stimmt.

- [ ] **Step 2: CLAUDE.md — Architektur-Fakt**

In `CLAUDE.md`, im Abschnitt „Sprachauswahl + Korrektur-Tiefe (pro Datei)" (der Block, der die PR-#133-Architektur beschreibt), ein Fakt-Paragraph zum Datei-Einstellungs-Endpunkt + Trigger-Verzweigung anfügen, im Stil der bestehenden Einträge (gemessene Begründung, warum der PUT sperrfrei ist und die Trigger über bestehende Endpunkte laufen). Sinngemäß diese Punkte:

- `GET/PUT /api/projects/{p}/files/{base}/einstellungen` als Datei-Pendant des Projekt-Endpunkts; PUT ist **reiner Schreibpfad ohne 409-Sperre** (wie `upload_audio`), die Trigger laufen über die bestehenden `…/transcribe`/`…/correct`-Endpunkte mit ihrem eigenen `_keine_jobs`.
- Trigger-Verzweigung liegt im Frontend (`DateiMenue.einstellungenGespeichert`): Sprache-Wechsel + `has_raw` → retranscribe (dominiert, Editor vergisst + verlässt), nur-Tiefe → correct(`force=true`, sonst überspränge `correct.py` eine `human_edited`-Datei still), `!has_raw` → nur Override.
- `projekt.json`-Race (#134) wird hier nicht behoben; `setze_datei` ist derselbe Pfad wie beim Upload.

- [ ] **Step 3: Commit (README normal, CLAUDE.md separat)**

```bash
git add README.md
git commit -m "docs(readme): Sprache nachträglich pro Datei ändern (#135)"
git add CLAUDE.md
git commit -m "docs(claude): Datei-Einstellungs-Endpunkt + Trigger-Verzweigung (#135)"
```

(Hinweis: CLAUDE.md ist gitignored; `git add CLAUDE.md` erzwingt das Erfassen trotz Ignore. Nicht `git add -A` verwenden — siehe [[gitignorierte-datei-ueberlebt-rebase-nicht]].)

---

## Self-Review (vor Übergabe)

**1. Spec-Abdeckung:**
- Backend-Endpunkt GET/PUT (pure write) → Task 1. ✓
- Frontend api.ts + Typen → Task 2 (`ProjectEinstellungen` passt unverändert). ✓
- Datei-Einstellungsdialog mit Hinweis + dynamischem Knopf → Task 3. ✓
- DateiMenue-Eintrag + Trigger-Verzweigung (Sprache→retranscribe, Tiefe→correct force, !has_raw→Override) → Task 4. ✓
- 409-Verhalten: Trigger laufen über bestehende Endpunkte → Task 4 nutzt `jobStarten`, 409 wird wie bisher als Toast sichtbar (bestehende Logik). ✓
- „Nur bei Änderung PUT": Knopf deaktiviert bei nichts-geändert → Task 3 Step 3 (`disabled={!geaendert}`). ✓
- README + CLAUDE.md → Task 5. ✓
- YAGNI (kein Batch, kein Undo, kein #134-Fix): im Plan nicht enthalten. ✓

**2. Placeholder-Scan:** alle Schritte enthalten vollständigen Code/Tests; keine TBD/TODO. ✓

**3. Typ-Konsistenz:**
- `onGespeichert({ spracheGeaendert, tiefeGeaendert })` — gleich in Task 3 (Produzent) und Task 4 (Konsument). ✓
- `getFileEinstellungen`/`saveFileEinstellungen` — gleich in Task 2, 3, 4. ✓
- `DateiEinstellungenDialog`-Props gleich in Task 3 + 4. ✓
- Endpunkt-Pfad `/api/projects/{project}/files/{base}/einstellungen` — gleich in Task 1 (Backend), Task 2 (Frontend). ✓
