# Autosave-Flush beim Verlassen (#106) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wer in der 800-ms-Autosave-Pause die Datei wechselt, bekommt keine irreführende „Verwerfen?"-Rückfrage mehr — der Editor spült den neuesten Stand beim Verlassen, und die Leiste fragt nur noch bei echtem Speicherfehler (`stand === 'fehler'`).

**Architecture:** Ein `useEffect`-Cleanup in `useDoc` (Key `[project, base]`) hängt beim Verlassen einer Datei einen `saveDoc`-Aufruf an die bestehende Speicher-Kette (`kette`) an — so steht ein noch laufender Autosave VOR dem Flush, und der neueste Stand gewinnt. Ein `haengt`-Ref (in `beruehrt` auf `true`, in `save`/`reload` auf `false`) unterscheidet „Tipppause läuft, noch nicht in der Kette" (→ flush nötig) von „schon in der Kette" (→ kein Flush, sonst Doppelung). Die Leisten-Rückfrage (`AppShell.wechselErlaubt`) liest künftig `stand === 'fehler'` statt `dirty`; die drei anderen `dirty`-Leser (`DateiMenue` ×2, `ProjektUmbenennen`) bleiben unangetastet, weil dort ein Server-Prozess über dieselbe Datei läuft (Issue #106, „bewusst so entschieden").

**Tech Stack:** React 19, TypeScript, Vitest + @testing-library/react (Fake-Timer), `react-router-dom`.

## Global Constraints

- **Kein zweiter Speicherweg:** der Flush geht durch `kette` (wie der Autosave), nie daneben — sonst kann ein älterer, noch laufender Autosave den Flush-Stand überschreiben.
- **`dirty`-Semantik darf an den drei Server-Prozess-Stellen nicht rühren:** `DateiMenue.korrekturFertig`, `DateiMenue.umbenannt`, `ProjektUmbenennen.speichern` bleiben bei `dirty` (Issue #106 ausdrücklich).
- **Kein `meins()` für den Flush:** er schreibt roh `saveDoc(alter-pfad, altes-doc)` und tastet keine Buchführung an (die Datei wird verlassen).
- **Keine erneute Speicherung, wenn die Kette den Stand schon trägt:** der `haengt`-Ref verhindert, dass der Flush das dupliziert, was ein abgelaufener Autosave schon in die Kette gestellt hat (sonst bricht er die #117-Tests).
- Test-Stack: `cd webtool/frontend`; `npx vitest run` (Einzeltest: `npx vitest run src/hooks/useDoc.test.tsx`), Typecheck `npx tsc -b`, Lint `npx oxlint`.

## File Structure

- **Modify** `webtool/frontend/src/hooks/useDoc.ts` —Refs (`docRef`, `dirtyRef`, `standRef`, `haengt`), `haengt`-Pflege in `beruehrt`/`save`/`reload`, neuer Flush-Effekt.
- **Modify** `webtool/frontend/src/hooks/useEditorBruecke.tsx` —`stand: SpeicherStand` in `OffenesDokument`.
- **Modify** `webtool/frontend/src/pages/EditorView.tsx` —`stand` an `useEditorMelden` reichen.
- **Modify** `webtool/frontend/src/components/AppShell.tsx` —`wechselErlaubt` auf `stand === 'fehler'`.
- **Modify** `webtool/frontend/src/hooks/useDoc.test.tsx` —Flush-Tests (RED → GREEN).
- **Modify** `webtool/frontend/src/components/AppShell.test.tsx` —`Schreibtisch` um `stand` erweitern, bestehende + neue Tests.
- **Modify** `CLAUDE.md` —Flush + stand-basierte `wechselErlaubt` dokumentieren (Kampagnen-Lehre).
- README braucht **keine** Änderung (führt das Granular-Niveau der Speicher-Pause nicht; geprüft).

---

### Task 1: Flush beim Verlassen in der Tipppause (useDoc, RED → GREEN)

**Files:**
- Modify: `webtool/frontend/src/hooks/useDoc.ts`
- Test: `webtool/frontend/src/hooks/useDoc.test.tsx`

**Interfaces:**
- Produces (intern): `haengt: Ref<boolean>` — `true` = Tipppause läuft, `save()` noch nicht gerufen. Gelesen vom Flush-Effekt.
- Produces (unverändert return): `{ doc, dirty, stand, ... }` — keine neue öffentliche Signatur.

**Heikelste Stelle (vor Review aufschreiben):** der Flush öffnet den Weg, den #116/#117 geschlossen haben — einen Speicheraufruf für Datei A, der abfeuert, während der Editor schon B zeigt. Drei Garanten halten das:
1. `project`/`base` im Cleanup-Schluss stammen vom Effekt-Setup (Datei A) — nicht aus einem Ref, der schon B trägt.
2. `docRef.current` gehört beim Cleanup (passiver Effekt nach Render N+1) noch zu A, weil `reload()`s `setDoc(B)` in einem späteren Effekt / asynchronen Aufruf läuft.
3. `haengt` verhindert den Doppel-Fire, wenn ein abgelaufener Autosave den Stand schon in `kette` gestellt hat (sonst bricht der #117-Test „juengerer Lauf fuer B sticht A nicht aus").

- [ ] **Step 1: RED-Test — „spült beim Dateiwechsel in der Tipppause den neuesten Stand"**

In `useDoc.test.tsx`, neuer `describe`-Block am Ende (vor `Export-Fehler`):

```typescript
describe('useDoc: Flush beim Verlassen (#106)', () => {
  it('spült beim Dateiwechsel in der Tipppause den neuesten Stand', async () => {
    // #106: stand='offen' in der 800-ms-Pause darf beim Wechseln nicht zu "Verwerfen?" fuehren.
    // Der Flush schreibt den neuesten Stand von A, noch waehrend der Editor schon B laedt.
    const docB: EditDoc = { ...doc, base: 'b2' }
    vi.mocked(api.saveDoc).mockResolvedValue(undefined as never)
    vi.useFakeTimers()
    vi.mocked(api.getDoc).mockResolvedValue(doc)
    const h = renderHook(({ b }) => useDoc('P', b), { initialProps: { b: 'b' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    await act(async () => { h.result.current.updateSegment(0, { text: 'A-Text' }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })   // Pause, save NOCH nicht gefeuert
    expect(api.saveDoc).not.toHaveBeenCalled()

    vi.mocked(api.getDoc).mockResolvedValue(docB)
    h.rerender({ b: 'b2' })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })     // Cleanup laeuft, Flush faeuert

    const aRufe = vi.mocked(api.saveDoc).mock.calls.filter(c => c[1] === 'b')
    expect(aRufe.map(c => c[2].segments[0].text)).toEqual(['A-Text'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd webtool/frontend && npx vitest run src/hooks/useDoc.test.tsx -t "spült beim Dateiwechsel in der Tipppause"`
Expected: FAIL — `api.saveDoc` wurde nie gerufen (kein Flush vorhanden), `aRufe` ist `[]`.

- [ ] **Step 3: RED-Test — „spült NICHT doppelt, wenn der Autosave den Stand schon in die Kette gestellt hat"**

Gleicher `describe`-Block:

```typescript
  it('spült nicht doppelt, wenn der Autosave den Stand schon in die Kette gestellt hat', async () => {
    // haengt-Diskriminator: ist der debounce-Timer abgelaufen (save gerufen), traegt die Kette
    // den Stand schon. Ein zusaetzlicher Flush wuerde die #117-Zaehler-Erwartung brechen.
    const docB: EditDoc = { ...doc, base: 'b2' }
    vi.mocked(api.saveDoc).mockResolvedValue(undefined as never)
    vi.useFakeTimers()
    vi.mocked(api.getDoc).mockResolvedValue(doc)
    const h = renderHook(({ b }) => useDoc('P', b), { initialProps: { b: 'b' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    await act(async () => { h.result.current.updateSegment(0, { text: 'A-Text' }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(800) })   // save FEUERT, Kette traegt es
    expect(api.saveDoc).toHaveBeenCalledTimes(1)

    vi.mocked(api.getDoc).mockResolvedValue(docB)
    h.rerender({ b: 'b2' })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    const aRufe = vi.mocked(api.saveDoc).mock.calls.filter(c => c[1] === 'b')
    expect(aRufe).toHaveLength(1)   // kein zweiter Flush-Schreib
  })
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd webtool/frontend && npx vitest run src/hooks/useDoc.test.tsx -t "spült nicht doppelt"`
Expected: FAIL erst nach Step 5+6 implementiert ist (dieser Test sichert den `haengt`-Diskriminator; ohne ihn würde der Flush auch nach save() feuern → `aRufe` Länge 2).

- [ ] **Step 5: RED-Test — „bei stand='fehler' spült der Wechsel nicht (Nutzer verwirft bewusst)"**

```typescript
  it('spült bei stand=fehler nicht — der Nutzer verwirft bewusst', async () => {
    // Auf 'fehler' fragt die Leiste explizit; ein bestätigtes Verwerfen darf der Flush nicht
    // wieder undercutten. Zudem hat der Retry-Effekt die Verantwortung fuer diese Episode.
    const docB: EditDoc = { ...doc, base: 'b2' }
    vi.mocked(api.saveDoc).mockRejectedValue(new Error('boom'))
    vi.useFakeTimers()
    vi.mocked(api.getDoc).mockResolvedValue(doc)
    const h = renderHook(({ b }) => useDoc('P', b), { initialProps: { b: 'b' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    await act(async () => { h.result.current.updateSegment(0, { text: 'A' }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(800) })   // save 1 fehlschlag → stand='fehler'
    expect(h.result.current.stand).toBe('fehler')
    const standsVorWechsel = vi.mocked(api.saveDoc).mock.calls.filter(c => c[1] === 'b').length

    vi.mocked(api.getDoc).mockResolvedValue(docB)
    h.rerender({ b: 'b2' })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    const nachWechsel = vi.mocked(api.saveDoc).mock.calls.filter(c => c[1] === 'b').length
    expect(nachWechsel).toBe(standsVorWechsel)   // kein zusaetzlicher Flush
  })
```

- [ ] **Step 6: Run all three new tests — all FAIL**

Run: `cd webtool/frontend && npx vitest run src/hooks/useDoc.test.tsx -t "#106"`
Expected: 3 FAIL (Flush existiert nicht).

- [ ] **Step 7: Implementiere Refs + haengt-Pflege**

In `useDoc.ts`: füge direkt nach den bestehenden Ref-Deklarationen (`neuester`-Block, ca. Zeile 152) die Latest-Refs ein:

```typescript
  /** Juengste Werte zum Lesen im Flush-Cleanup (#106). Im Render-Koerper zugewiesen: der passive
   *  Effekt-Cleanup laeuft NACH dem Render, bekommt also den Stand dieser Datei — reload()s
   *  setDoc/setDirty greifen erst in einem spaeteren Effekt / asynchron. */
  const docRef = useRef(doc); docRef.current = doc
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty
  const standRef = useRef(stand); standRef.current = stand
  /** Laeuft die Tipppause noch (save noch nicht gerufen)? Nur dann muss der Verlassens-Flush
   *  etwas uebernehmen — ist der debounce-Timer abgelaufen, traegt die Kette den Stand schon. */
  const haengt = useRef(false)
```

In `beruehrt` (ca. Zeile 64): setze `haengt.current = true` als erste Zeile im Koerper:

```typescript
  const beruehrt = useCallback(() => {
    haengt.current = true
    fassung.current++; setDirty(true); setStand('offen')
    setFehlerZaehler(0); finalToastGezeigt.current = false
  }, [])
```

In `reload` (ca. Zeile 44): setze `haengt.current = false` hinter den `if (!project || !base)`-Guard (neue Datei → nichts baumelt):

```typescript
  const reload = useCallback(() => {
    if (!project || !base) { setDoc(null); setDirty(false); setStand('ruhig'); return }
    haengt.current = false
    setLoading(true)
    getDoc(project, base).then(d => { setDoc(d); setDirty(false); setStand('ruhig') })
      .catch(() => setDoc(null)).finally(() => setLoading(false))
  }, [project, base])
```

In `save` (ca. Zeile 154): setze `haengt.current = false` direkt hinter den `if (!doc || !project || !base) return`-Guard:

```typescript
  const save = useCallback(async () => {
    if (!doc || !project || !base) return
    haengt.current = false   // #106: debounce abgelaufen — dieser Aufruf traegt den Stand in die Kette
    const v = fassung.current
    ...
```

- [ ] **Step 8: Implementiere den Flush-Effekt**

Füge den Effekt unmittelbar VOR dem Autosave-Effekt (`useEffect(() => { if (!dirty) return ...`) ein:

```typescript
  // Flush beim Verlassen einer Datei (#106). In der 800-ms-Pause hatte die Oberflaeche "wird
  // gespeichert" versprochen; eine "Verwerfen?"-Rueckfrage beim Wechseln widerspricht dem. Der
  // Cleanup dieses Effekts laeuft beim Dateiwechsel (Key [project, base]) UND beim Unmount und
  // schreibt den neuesten Stand der VERLASSENEN Datei — ueber die Kette, damit ein noch
  // laufender Autosave VOR dem Flush steht und der juengste Stand zuletzt gewinnt.
  //
  // WARUM project/base als Closure (nicht aus Ref): der Cleanup-Schluss stammt vom Effekt-SETUP
  // (Render, als diese Datei aktuell wurde) — er traegt die VERLASSENE Datei. Ein Ref wuerde beim
  // Cleanup schon die NEUE Datei tragen (passiver Effekt laeuft nach Render N+1). docRef/dirtyRef/
  // standRef hingegen gehoeren beim Cleanup noch zur alten Datei: reload()s setDoc/setDirty greifen
  // erst in einem spaeteren Effekt. haengt schliesst den Doppel-Fire aus, wenn die Kette den Stand
  // schon traegt; stand!=='fehler', weil der Nutzer auf 'fehler' explizit verwirft (Leisten-Rueckfrage).
  useEffect(() => {
    return () => {
      if (!project || !base) return
      if (!dirtyRef.current || standRef.current === 'fehler' || !haengt.current) return
      const dokument = docRef.current
      if (!dokument) return
      kette.current = kette.current
        .then(() => saveDoc(project, base, dokument))
        .catch(() => {})
    }
  }, [project, base])
```

- [ ] **Step 9: Run the three #106 tests — all PASS**

Run: `cd webtool/frontend && npx vitest run src/hooks/useDoc.test.tsx -t "#106"`
Expected: 3 PASS.

- [ ] **Step 10: Run the FULL useDoc suite — keine Regression (#116, #117, #107)**

Run: `cd webtool/frontend && npx vitest run src/hooks/useDoc.test.tsx`
Expected: alle Tests grün. **Besonders achten auf:** „juengerer Lauf fuer B sticht A nicht aus" (#117, haengt-Diskriminator), „Dokument A darf nie in Datei B landen" (#116), „Dateiwechsel mitten im Speichern". Schlägt einer rot, ist der Flush an dieser Achse zu breit — haengt/Guard nachschärfen, nicht den Test lockern.

- [ ] **Step 11: Mutationstest — haengt-Diskriminator hat Diskriminierungskraft**

Temporär: in `save` die Zeile `haengt.current = false` auskommentieren. `npx vitest run src/hooks/useDoc.test.tsx -t "spült nicht doppelt"` → muss ROT werden (Flush feuert doppelt). Wiederherstellen. (Beweist, dass der Test den Diskriminator wirklich sichert, nicht zufällig grün ist.)

- [ ] **Step 12: Commit**

```bash
git add webtool/frontend/src/hooks/useDoc.ts webtool/frontend/src/hooks/useDoc.test.tsx
git commit -m "fix(editor): spült ungespeicherte Aenderung beim Verlassen (#106)"
```

---

### Task 2: `stand` an die Huelle melden (Brücke + EditorView)

**Files:**
- Modify: `webtool/frontend/src/hooks/useEditorBruecke.tsx`
- Modify: `webtool/frontend/src/pages/EditorView.tsx`

**Interfaces:**
- Produces: `OffenesDokument.stand: SpeicherStand` — von `AppShell` gelesen (Task 3).

- [ ] **Step 1: Erweitere `OffenesDokument` um `stand`**

In `useEditorBruecke.tsx`: füge `stand` in den Typ ein (importiere `SpeicherStand`):

```typescript
import type { ReactNode } from 'react'
import type { SpeicherStand } from './useDoc'

/** Was der Editor der Huelle ueber sein offenes Dokument verraet — mehr braucht die Leiste nicht. */
export type OffenesDokument = {
  project: string
  base: string
  dirty: boolean
  /** #106: 'fehler' ist der einzige Stand, in dem die Leiste vor dem Verlassen fragt — in der
   *  Tipppause ('offen') spült useDoc den Stand beim Verlassen selbst. */
  stand: SpeicherStand
  reload: () => void
}
```

- [ ] **Step 2: EditorView reicht `stand` weiter**

In `EditorView.tsx` (Zeile 19): `stand` ist schon aus `useDoc` destrukturiert — in das Melden-Objekt aufnehmen:

```typescript
  useEditorMelden(sel ? { ...sel, dirty, stand, reload } : null)
```

- [ ] **Step 3: Typecheck**

Run: `cd webtool/frontend && npx tsc -b`
Expected: keine Fehler. (Schreibt noch niemand neu — `AppShell` liest erst in Task 3. Aber `EditorView` muss das Feld jetzt liefern, sonst Typfehler am Melden-Objekt.)

- [ ] **Step 4: Commit**

```bash
git add webtool/frontend/src/hooks/useEditorBruecke.tsx webtool/frontend/src/pages/EditorView.tsx
git commit -m "fix(editor): meldet Speicherstand an die Huelle (#106)"
```

---

### Task 3: Leisten-Rückfrage auf `stand === 'fehler'` (AppShell, RED → GREEN)

**Files:**
- Modify: `webtool/frontend/src/components/AppShell.tsx`
- Test: `webtool/frontend/src/components/AppShell.test.tsx`

**Interfaces:**
- Consumes: `OffenesDokument.stand` (Task 2).

**Heikelste Stelle:** die drei existierenden Navigations-Tests hängen am `dirty`-Versprechen. Sie müssen auf `stand` umgestellt werden, sonst werden sie grün für kaputtes Verhalten (Leiste fragt nie → navigiert immer). Das ist die „dirty-Semantik an 4 Stellen"-Achse, deretwegen #106 geparkt war.

- [ ] **Step 1: `Schreibtisch` um `stand` erweitern**

In `AppShell.test.tsx` (ca. Zeile 14): Typ + Default. Default `stand='ruhig'`, damit Tests, die die Rückfrage nicht prüfen (korrekturFertig), kein falsches 'fehler' liefern:

```typescript
import type { SpeicherStand } from '@/hooks/useDoc'
// ...
function Schreibtisch({ dirty = true, stand = 'ruhig', reload = () => {} }: {
  dirty?: boolean; stand?: SpeicherStand; reload?: () => void
}) {
  useEditorMelden({ project: 'Alpha', base: 'a', dirty, stand, reload })
  const { pathname } = useLocation()
  return <span data-testid="ort">{pathname}</span>
}
```

- [ ] **Step 2: Bestehende Navigations-Tests auf `stand` umstellen**

Die Tests „navigiert NICHT, wenn die Rueckfrage abgelehnt wird" und „navigiert nach zugestimmter Rueckfrage" bekommen `stand="fehler"` (der einzige Fall, in dem die Leiste noch fragt). Der Test „fragt nicht ohne ungespeicherte Aenderungen" nutzt weiter `dirty={false}` (mit `stand="ruhig"`), bleibt also ohne Rückfrage. Schreibe beide prompt-Tests so, dass sie `stand="fehler"` übergeben:

```typescript
// im „abgelehnt"-Test:
<JobProvider><AppShell><Schreibtisch dirty stand="fehler" /></AppShell></JobProvider>
// im „zugestimmt"-Test entsprechend:
<JobProvider><AppShell><Schreibtisch dirty stand="fehler" /></AppShell></JobProvider>
// im „ohne ungespeicherte"-Test:
<JobProvider><AppShell><Schreibtisch dirty={false} stand="ruhig" /></AppShell></JobProvider>
```

- [ ] **Step 3: RED-Test — „in der Tipppause (stand='offen') navigiert OHNE Rueckfrage"**

```typescript
  it('navigiert in der Tipppause (stand="offen") ohne Rueckfrage (#106)', async () => {
    // Kern von #106: die Oberflaeche hatte "wird gespeichert" versprochen — in der Pause darf
    // die Leiste nicht widersprechen. useDoc spült beim Verlassen selbst.
    vi.mocked(api.listProjects).mockResolvedValue(ZWEI)
    vi.mocked(api.getProjectFiles).mockResolvedValue({ name: 'Alpha', files: DATEIEN })
    const frage = vi.spyOn(window, 'confirm').mockReturnValue(false)   // duerfte gar nicht gefragt
    render(
      <MemoryRouter initialEntries={['/p/Alpha/a']}>
        <JobProvider><AppShell><Schreibtisch dirty stand="offen" /></AppShell></JobProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('Beta')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Beta'))
    await waitFor(() => expect(screen.getByTestId('ort').textContent).toBe('/p/Beta'))
    expect(frage).not.toHaveBeenCalled()
    frage.mockRestore()
  })
```

- [ ] **Step 4: Run RED test to verify it fails**

Run: `cd webtool/frontend && npx vitest run src/components/AppShell.test.tsx -t "in der Tipppause"`
Expected: FAIL — `wechselErlaubt` prüft noch `dirty` (true) → frägt → `confirm` mock returns false → navigiert nicht.

- [ ] **Step 5: Implementiere `wechselErlaubt` auf `stand === 'fehler'`**

In `AppShell.tsx` (Zeile 41–46): ersetze den `dirty`-Check. Import-Liste braucht `SpeicherStand` nicht (Typ steht über `OffenesDokument`):

```typescript
  // #106: nur bei echtem Speicherfehler fragt die Leiste. In der Tipppause (stand='offen') hatte
  // die Oberflaeche "wird gespeichert" versprochen — useDoc spült den neuesten Stand beim
  // Verlassen selbst. Die drei Server-Prozess-Rueckfragen (DateiMenue ×2, ProjektUmbenennen)
  // bleiben bei dirty (Issue #106 „bewusst so entschieden").
  const wechselErlaubt = (ziel: { project: string; base: string } | null) => {
    const e = editor.current
    if (!e || e.stand !== 'fehler') return true
    if (ziel && ziel.project === e.project && ziel.base === e.base) return true   // dieselbe Datei
    return window.confirm('Ungespeicherte Änderungen verwerfen?')
  }
```

Und den Kommentarblock über `wechselErlaubt` (Zeile 35–40) anpassen: „`dirty`" → „`stand === 'fehler''" und auf den Flush verweisen.

- [ ] **Step 6: Run the new + umgestellte Tests — all PASS**

Run: `cd webtool/frontend && npx vitest run src/components/AppShell.test.tsx`
Expected: alle grün (neuer Tipppause-Test + die umgestellten + die korrekturFertig-Tests unverändert).

- [ ] **Step 7: Run FULL frontend suite**

Run: `cd webtool/frontend && npx vitest run`
Expected: alle Tests grün (302 + die neuen).

- [ ] **Step 8: Typecheck + Lint**

Run: `cd webtool/frontend && npx tsc -b && npx oxlint`
Expected: keine Fehler, keine neuen Warnungen.

- [ ] **Step 9: Commit**

```bash
git add webtool/frontend/src/components/AppShell.tsx webtool/frontend/src/components/AppShell.test.tsx
git commit -m "fix(editor): Leiste fragt beim Verlassen nur noch bei Speicherfehler (#106)"
```

---

### Task 4: CLAUDE.md dokumentiert Flush + stand-basierte Rückfrage

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: CLAUDE.md — Bullets im Autosave-Abschnitt ergänzen**

Im Abschnitt zum Autosave (`useDoc.ts`, 800 ms) zwei neue Bullets:

```markdown
- **Beim Verlassen spült der Editor selbst (#106).** Wer in der 800-ms-Pause die Datei wechselt,
  bekam eine irreführende „Verwerfen?"-Rückfrage — die Oberfläche hatte „wird gespeichert"
  versprochen. Ein `useEffect`-Cleanup (Key `[project, base]`) hängt beim Dateiwechsel/Unmount
  einen `saveDoc` an die bestehende `kette` an (nie daneben — sonst überschreibt ein älterer,
  laufender Autosave den Flush-Stand). Vier Dinge, die man nicht aus dem Diff liest:
  **`project`/`base` als Closure, nicht aus Ref:** der Cleanup-Schluss stammt vom Effekt-Setup
  und trägt die VERLASSENE Datei; ein Ref trüge beim Cleanup schon die NEUE (passiver Effekt
  nach Render N+1). `docRef`/`dirtyRef`/`standRef` hingegen gehören beim Cleanup noch zur alten
  Datei — `reload()`s `setDoc`/`setDirty` greifen erst in einem späteren Effekt.
  **`haengt` (Ref) unterscheidet „Tipppause läuft" von „schon in der Kette".** `beruehrt`
  setzt `true`, `save`/`reload` setzen `false`. Ohne ihn feuerte der Flush nach, was ein
  abgelaufener Autosave schon in die Kette gestellt hat — und bräche den #117-Test, der die
  A-Schreibungen exakt zählt (haengt mutationsgeprüft).
  **Bei `stand='fehler'` spült der Flush NICHT.** Der Nutzer hat auf der Leiste explizit
  verworfen; der Flush darf das nicht untercutten. Der Retry-Effekt (#107) hat diese Episode.
  **Die Leiste fragt seitdem auf `stand === 'fehler'`, nicht mehr auf `dirty`.** DIESE Verschiebung
  war der Grund, #106 zu parken: `dirty` zählt noch an drei Stellen, wo ein Server-Prozess über
  dieselbe Datei läuft (`DateiMenue.korrekturFertig`, `DateiMenue.umbenannt`,
  `ProjektUmbenennen.speichern`) — dort kann der Browser-Flush den Server-Prozess nicht einholen,
  also bleibt `dirty` (Issue #106, „bewusst so entschieden"). Nur `AppShell.wechselErlaubt`
  (reine Navigation) ist auf `stand` umgestellt. `stand` reist über die Editor-Brücke
  (`OffenesDokument.stand`), die zuvor nur `dirty` trug.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md dokumentiert Verlassens-Flush und stand-basierte Rueckfrage (#106)"
```

---

## Self-Review

**1. Spec coverage:**
- „Flush statt Rückfrage in der Pause" → Task 1 (Flush) + Task 3 (`wechselErlaubt`).
- „`useEffect`-Cleanup spült bei dirty synchron" → Task 1 Step 8 (Cleanup an `kette`).
- „drei Rückfragen prüfen `stand === 'fehler'` außer wo ein Server-Prozess läuft" → Task 3 ändert nur `AppShell`; die drei Server-Prozess-Stellen bewusst unangetastet (Global Constraint + Issue #106). ✓
- „dirty-Semantik ändert sich an 4 Stellen" → Task 3 Step 2 stellt die Navigations-Tests um; kein App-Code an den 3 Server-Prozess-Stellen. ✓

**2. Placeholder scan:** keine TBD/„add error handling"; alle Tests und Implementierungen stehen ausformuliert. ✓

**3. Type consistency:** `SpeicherStand` in Task 2 eingeführt, in Task 3 konsumiert (`e.stand !== 'fehler'`). `OffenesDokument.stand` durchgängig. `haengt: Ref<boolean>` in Task 1 deklariert und in `beruehrt`/`save`/`reload`/Flush konsistent gepflegt. ✓

## Risiko-Notiz für den Review

Vor dem Review (`requesting-code-review`) die Angriffspunkte aufschreiben — derselbe Druck, der #116/#117 geholfen hat:
1. **Kann der Flush Datei A in Datei B schreiben?** (Closure project/base vs. Ref — begründet durch Render-Ordnung.)
2. **Kann er Doppel-Schreibungen auslösen, die #117-Tests brechen?** (`haengt`-Diskriminator — mutationstest in Task 1 Step 11.)
3. **Bleibt die „Dokument A nie in Datei B"-Garantie von #116 erhalten?** (Flush schreibt korrekten Pfad; der bestehende Test filtert `c[1] !== c[2].base` — Flush ist `c[1] === c[2].base`.)
4. **Verliert der Nutzer beim Verlassen in der Pause jetzt garantiert nichts?** (Flush + `wechselErlaubt` auf `offen` → kein Prompt + schreibt.)
5. **Wird `dirty` noch irgendwo fälschlich statt `stand` gelesen?** (nur die 3 Server-Prozess-Stellen bewusst; sonst nirgendwo.)
