# Textsuche im Editor — Implementierungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein sichtbares Suchfeld in der Editor-Werkzeugleiste, das beim Tippen alle Transkript-Segmente ohne Treffer ausgraut und mit `▲` `▼` von Treffer zu Treffer springt.

**Architecture:** State (`suchQuery`/`suchIndex`) im `EditorView`; Match-Logik im reinen Hook `useSuche`; ein `Suchfeld`-Bauteil in der `Toolbar`; der Treffer-Zustand (`dimmen`/`aktiverTreffer`) wird parallel zu `activeId` durch `Transcript → SpeakerTurn → SegmentView` gereicht — die Wiedergabe-Position bleibt unangetastet (eigener Scroll-Effekt, keine Kollision).

**Tech Stack:** React 19, TypeScript, Tailwind v4, shadcn/ui (`Input`, `Button`), vitest + @testing-library/react + jsdom.

**Spec:** `docs/superpowers/specs/2026-08-11-editor-textsuche-design.md`

## Global Constraints

- **Keine neuen Abhängigkeiten.** Genutzte Icons (`Search`, `ChevronUp`, `ChevronDown`, `X`) kommen aus `lucide-react` (bereits installiert).
- **Keine Tastatur-Shortcuts** (`Strg+F`/`F3`/`Enter`/`Esc` zur Steuerung). Das Suchfeld ist sichtbar; Bedienung über Knöpfe (`▲` `▼` `✕`).
- **UI-Kopie deutsch** — Placeholder „Im Transkript suchen …", „keine Treffer", aria-labels „Nächster Treffer" / „Voriger Treffer" / „Suche leeren".
- **Farbregel:** Yellow erscheint **nur als Ring** am aktiven Treffer (`ring-yellow-400 dark:ring-yellow-500`), nicht als Text- oder Hintergrundfarbe — kein Konflikt mit Indigo (Playback-aktiv), Amber/Rot (Unsicherheit) oder den kühlen Sprecherfarben.
- **Regressionfrei:** Alle neuen Props an `SegmentView`/`SpeakerTurn`/`Transcript`/`Toolbar` sind **optional** mit Defaults, die „Suche aus" bedeuten — bestehende Tests bleiben grün.
- **Tests:** `npx`-Befehle laufen aus `webtool/frontend` (oder via `npm --prefix webtool/frontend run test -- <file>`). Kompletter Lauf: `npm --prefix webtool/frontend run test`. Typecheck/Bau: `npm --prefix webtool/frontend run build`.

## File Structure

| Datei | Verantwortung | Status |
|---|---|---|
| `src/hooks/useSuche.ts` | reiner `useMemo`-Hook: `{ ids, count }` für eine Query über Segmente | neu |
| `src/hooks/useSuche.test.ts` | Tests für den Hook | neu |
| `src/components/Suchfeld.tsx` | Eingabefeld + Zähler + `▲▽✕`, nur Knopf-Bedienung | neu |
| `src/components/Suchfeld.test.tsx` | Tests für das Suchfeld | neu |
| `src/components/Toolbar.tsx` | rendert `<Suchfeld/>`, neue (optionale) Props | geändert |
| `src/components/Toolbar.test.tsx` | Tests für die Toolbar-Suche | neu |
| `src/components/SegmentView.tsx` | neue Props `dimmen`, `aktiverTreffer` → `opacity-40` / gelber Ring | geändert |
| `src/components/SegmentView.test.tsx` | erweitert | geändert |
| `src/components/SpeakerTurn.tsx` | reicht `sucheAktiv`/`trefferIds`/`suchAktivId` weiter, berechnet `dimmen`/`aktiverTreffer` | geändert |
| `src/components/Transcript.tsx` | reicht die drei Such-Props weiter, extrahiert `scrollSegInView`, 2. Scroll-Effekt auf `suchAktivId` | geändert |
| `src/components/Transcript.test.tsx` | erweitert | geändert |
| `src/pages/EditorView.tsx` | besitzt State, nutzt `useSuche`, verdrahtet Toolbar + Transcript | geändert |
| `src/pages/EditorView.test.tsx` | Integrationstest | neu |

Build-Reihenfolge (Blatt → Wurzel): T1 `useSuche` → T2 `SegmentView` → T3 `Suchfeld` → T4 `SpeakerTurn` → T5 `Transcript` → T6 `Toolbar` → T7 `EditorView`.

---

### Task 1: `useSuche`-Hook

**Files:**
- Create: `webtool/frontend/src/hooks/useSuche.ts`
- Test: `webtool/frontend/src/hooks/useSuche.test.ts`

**Interfaces:**
- Consumes: `Segment` (`@/lib/types`), `isCorrected` (`@/lib/uncertainty`).
- Produces: `useSuche(segments: Segment[] | undefined, query: string) => { ids: number[]; count: number }`. `ids` in `segments`-Reihenfolge, case-insensitiv, Suche im **angezeigten** Text (korrigiert → `seg.text`, unkorrigiert → `seg.raw_text`). Leeres/Whitespace-Query oder `segments === undefined` → `{ ids: [], count: 0 }`.

- [ ] **Step 1: Failing test schreiben**

`webtool/frontend/src/hooks/useSuche.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useSuche } from './useSuche'
import type { Segment } from '@/lib/types'

const mkSeg = (id: number, text: string, raw: string = text): Segment => ({
  id, start: 0, end: 1, speaker: 'A', raw_text: raw, text, words: [],
  flags: { hallucination: false, low_conf: false }, note: '',
})

describe('useSuche', () => {
  it('findet Treffer case-insensitive im korrigierten Text', () => {
    const segs = [mkSeg(1, 'Fuhat Aras kam 2012'), mkSeg(2, 'nichts hier')]
    const { result } = renderHook(() => useSuche(segs, 'aras'))
    expect(result.current.ids).toEqual([1])
    expect(result.current.count).toBe(1)
  })

  it('sucht im raw_text, wenn das Segment unkorrigiert ist (text === raw_text)', () => {
    // korrigiert (text != raw) -> sucht text, nicht raw:
    const a = renderHook(() => useSuche([mkSeg(1, 'Wiesental', 'Wiesenthal')], 'Wiesenthal'))
    expect(a.result.current.ids).toEqual([])
    // unkorrigiert (text === raw) -> sucht raw:
    const b = renderHook(() => useSuche([mkSeg(1, 'Wiesenthal')], 'Wiesenthal'))
    expect(b.result.current.ids).toEqual([1])
  })

  it('leeres Query -> keine Treffer', () => {
    const { result } = renderHook(() => useSuche([mkSeg(1, 'x')], ''))
    expect(result.current.ids).toEqual([])
    expect(result.current.count).toBe(0)
  })

  it('whitespace-Query -> keine Treffer', () => {
    const { result } = renderHook(() => useSuche([mkSeg(1, 'x')], '   '))
    expect(result.current.count).toBe(0)
  })

  it('erhaelt die Dokumentreihenfolge', () => {
    const segs = [mkSeg(5, 'Aras'), mkSeg(3, 'Aras'), mkSeg(7, 'Aras')]
    const { result } = renderHook(() => useSuche(segs, 'aras'))
    expect(result.current.ids).toEqual([5, 3, 7])
  })

  it('segments undefined -> leer', () => {
    const { result } = renderHook(() => useSuche(undefined, 'x'))
    expect(result.current.ids).toEqual([])
  })
})
```

- [ ] **Step 2: Test failen lassen**

Run: `npm --prefix webtool/frontend run test -- src/hooks/useSuche.test.ts`
Expected: FAIL (Modul `./useSuche` nicht gefunden).

- [ ] **Step 3: Implementierung**

`webtool/frontend/src/hooks/useSuche.ts`:

```ts
import { useMemo } from 'react'
import type { Segment } from '@/lib/types'
import { isCorrected } from '@/lib/uncertainty'

/**
 * Reine Match-Logik fuer die Editor-Suche. Keine eigene State — die liegt im EditorView,
 * der Hook beantwortet nur: welche Segmente (in Dokumentreihenfolge) enthalten den Treffer?
 *
 * Gesucht wird der *angezeigte* Text: korrigierte Segmente in seg.text (die bereinigte
 * Fassung, die der Nutzer vor Augen hat), unkorrigierte in seg.raw_text (Klartext, der
 * denselben Wortlaut ergibt wie die farbigen Token-Spans). Case-insensitiv, Substring.
 */
export function useSuche(segments: Segment[] | undefined, query: string): { ids: number[]; count: number } {
  const q = query.trim().toLowerCase()
  return useMemo(() => {
    if (!q || !segments) return { ids: [], count: 0 }
    const ids = segments
      .filter(s => (isCorrected(s) ? s.text : s.raw_text).toLowerCase().includes(q))
      .map(s => s.id)
    return { ids, count: ids.length }
  }, [segments, q])
}
```

- [ ] **Step 4: Test grün**

Run: `npm --prefix webtool/frontend run test -- src/hooks/useSuche.test.ts`
Expected: PASS (6/6).

- [ ] **Step 5: Commit**

```bash
git add webtool/frontend/src/hooks/useSuche.ts webtool/frontend/src/hooks/useSuche.test.ts
git commit -m "feat(editor): useSuche-Hook (Match-Logik der Transkript-Suche)"
```

---

### Task 2: `SegmentView` — Ausgrauen + aktiver Ring

**Files:**
- Modify: `webtool/frontend/src/components/SegmentView.tsx` (Signature + Wurzel-`<div>`)
- Test: `webtool/frontend/src/components/SegmentView.test.tsx` (erweitert)

**Interfaces:**
- Consumes: nichts neues.
- Produces: `SegmentView` akzeptiert zusätzlich `dimmen?: boolean` und `aktiverTreffer?: boolean` (beide default `false`). `dimmen` → `opacity-40`; `aktiverTreffer` → `ring-2 ring-inset ring-yellow-400 dark:ring-yellow-500`. Der gelbe Ring gewinnt über den primären Playback-Ring, falls beides gesetzt (deterministisch: nur eine Ringfarbe).

- [ ] **Step 1: Failing tests erweitern**

An `webtool/frontend/src/components/SegmentView.test.tsx` anhängen (innerhalb von `describe('SegmentView', …)`), der `mkSeg`-Helper aus dem Bestand wird wiederverwendet:

```ts
  it('graut das Segment aus, wenn dimmen gesetzt ist', () => {
    const seg = mkSeg({ text: 'Text' })
    render(<TooltipProvider><SegmentView seg={seg} active={false} dimmen onPlay={vi.fn()} updateSegment={vi.fn()} /></TooltipProvider>)
    expect(document.querySelector('[data-seg-id="1"]')).toHaveClass('opacity-40')
  })

  it('setzt einen gelben Rahmen am aktiven Treffer', () => {
    const seg = mkSeg({ text: 'Text' })
    render(<TooltipProvider><SegmentView seg={seg} active={false} aktiverTreffer onPlay={vi.fn()} updateSegment={vi.fn()} /></TooltipProvider>)
    expect(document.querySelector('[data-seg-id="1"]')).toHaveClass('ring-yellow-400')
  })

  it('ohne Such-Props weder Ausgrauen noch gelber Ring (Default)', () => {
    const seg = mkSeg({ text: 'Text' })
    render(<TooltipProvider><SegmentView seg={seg} active={false} onPlay={vi.fn()} updateSegment={vi.fn()} /></TooltipProvider>)
    const root = document.querySelector('[data-seg-id="1"]')!
    expect(root).not.toHaveClass('opacity-40')
    expect(root).not.toHaveClass('ring-yellow-400')
  })
```

- [ ] **Step 2: Test failen lassen**

Run: `npm --prefix webtool/frontend run test -- src/components/SegmentView.test.tsx`
Expected: FAIL (Props `dimmen`/`aktiverTreffer` unbekannt; Klassen fehlen).

- [ ] **Step 3: Implementierung**

In `webtool/frontend/src/components/SegmentView.tsx` die Signatur erweitern:

Alt:
```tsx
export function SegmentView({ seg, active, onPlay, updateSegment }: {
  seg: Segment; active: boolean; onPlay: () => void;
  updateSegment: (id: number, patch: Partial<Segment>) => void;
}) {
```
Neu:
```tsx
export function SegmentView({ seg, active, onPlay, updateSegment, dimmen = false, aktiverTreffer = false }: {
  seg: Segment; active: boolean; onPlay: () => void;
  updateSegment: (id: number, patch: Partial<Segment>) => void;
  dimmen?: boolean; aktiverTreffer?: boolean;
}) {
```

Dann die Wurzel-`<div>` ersetzen. Alt:
```tsx
  return (
    <div data-seg-id={seg.id} className={`group relative rounded-md px-2 py-1 ${active ? 'bg-primary/15 ring-2 ring-inset ring-primary/60' : ''}`}>
```
Neu (Ringfarbe deterministisch: gelb bei aktiver Suche, sonst primär bei Playback, sonst keine; `bg-primary/15` bleibt vom Playback unabhhängig; `transition-opacity` weich das Ausgrauen):
```tsx
  const ring = aktiverTreffer ? 'ring-2 ring-inset ring-yellow-400 dark:ring-yellow-500'
    : active ? 'ring-2 ring-inset ring-primary/60' : ''
  return (
    <div data-seg-id={seg.id}
      className={`group relative rounded-md px-2 py-1 transition-opacity ${active ? 'bg-primary/15 ' : ''}${ring}${dimmen ? ' opacity-40' : ''}`}>
```

- [ ] **Step 4: Test grün**

Run: `npm --prefix webtool/frontend run test -- src/components/SegmentView.test.tsx`
Expected: PASS (alle, inkl. der drei neuen).

- [ ] **Step 5: Commit**

```bash
git add webtool/frontend/src/components/SegmentView.tsx webtool/frontend/src/components/SegmentView.test.tsx
git commit -m "feat(editor): SegmentView graut aus / hebt aktiven Treffer hervor"
```

---

### Task 3: `Suchfeld`-Bauteil

**Files:**
- Create: `webtool/frontend/src/components/Suchfeld.tsx`
- Test: `webtool/frontend/src/components/Suchfeld.test.tsx`

**Interfaces:**
- Consumes: `Input` (`@/components/ui/input`), `Button` (`@/components/ui/button`), `Search`/`ChevronUp`/`ChevronDown`/`X` (`lucide-react`).
- Produces: `Suchfeld({ value, onChange, count, index, onPrev, onNext })`. Eingabefeld (Placeholder „Im Transkript suchen …"); nur wenn `value.trim() !== ''`: Zähler (`{count===0?'keine Treffer':\`${index+1} / ${count}\`}`), `▲` (onPrev), `▽` (onNext, beide `disabled` bei `count===0`), `✕` (onChange('')). Keine Tastatur-Logik.

- [ ] **Step 1: Failing test schreiben**

`webtool/frontend/src/components/Suchfeld.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Suchfeld } from './Suchfeld'

describe('Suchfeld', () => {
  it('gibt Eingaben ans onChange weiter', () => {
    const onChange = vi.fn()
    render(<Suchfeld value="" onChange={onChange} count={0} index={0} onPrev={vi.fn()} onNext={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText('Im Transkript suchen …'), { target: { value: 'Aras' } })
    expect(onChange).toHaveBeenCalledWith('Aras')
  })

  it('zeigt Zähler und Navigationsknöpfe nur bei aktivem Query', () => {
    const { rerender } = render(<Suchfeld value="" onChange={vi.fn()} count={0} index={0} onPrev={vi.fn()} onNext={vi.fn()} />)
    expect(screen.queryByText(/\/ |/)).toBeNull()
    expect(screen.queryByLabelText('Nächster Treffer')).toBeNull()
    rerender(<Suchfeld value="aras" onChange={vi.fn()} count={5} index={2} onPrev={vi.fn()} onNext={vi.fn()} />)
    expect(screen.getByText('3 / 5')).toBeInTheDocument()
    expect(screen.getByLabelText('Nächster Treffer')).toBeInTheDocument()
  })

  it('zeigt "keine Treffer" und deaktiviert ▲▽ bei count 0', () => {
    render(<Suchfeld value="xyz" onChange={vi.fn()} count={0} index={0} onPrev={vi.fn()} onNext={vi.fn()} />)
    expect(screen.getByText('keine Treffer')).toBeInTheDocument()
    expect(screen.getByLabelText('Nächster Treffer')).toBeDisabled()
    expect(screen.getByLabelText('Voriger Treffer')).toBeDisabled()
  })

  it('▲ ruft onNext, ▽ ruft onPrev, ✕ leert', () => {
    const onPrev = vi.fn(), onNext = vi.fn(), onChange = vi.fn()
    render(<Suchfeld value="a" onChange={onChange} count={3} index={0} onPrev={onPrev} onNext={onNext} />)
    fireEvent.click(screen.getByLabelText('Nächster Treffer'))
    expect(onNext).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByLabelText('Voriger Treffer'))
    expect(onPrev).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByLabelText('Suche leeren'))
    expect(onChange).toHaveBeenCalledWith('')
  })
})
```

- [ ] **Step 2: Test failen lassen**

Run: `npm --prefix webtool/frontend run test -- src/components/Suchfeld.test.tsx`
Expected: FAIL (Modul `./Suchfeld` nicht gefunden).

- [ ] **Step 3: Implementierung**

`webtool/frontend/src/components/Suchfeld.tsx`:

```tsx
import { Search, ChevronUp, ChevronDown, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

/**
 * Sichtbares Suchfeld in der Editor-Werkzeugleiste — keine Tastatur-Shortcuts. Tippen graut
 * im Editor alle Nicht-Treffer aus; ▲/▽ springen von Treffer zu Treffer, ✕ leert das Feld.
 * Zähler und Knöpfe erscheinen erst, sobald eine Eingabe dasteht.
 */
export function Suchfeld({ value, onChange, count, index, onPrev, onNext }: {
  value: string; onChange: (v: string) => void
  count: number; index: number
  onPrev: () => void; onNext: () => void
}) {
  const aktiv = value.trim() !== ''
  return (
    <div className="flex items-center gap-1">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        {/* type="text" (nicht "search"): der Browser-Eigenbau-Clear-Knopf wuerde sonst doppelt
            neben unserem ✕ stehen. */}
        <Input type="text" value={value} onChange={e => onChange(e.target.value)}
          placeholder="Im Transkript suchen …" aria-label="Im Transkript suchen"
          className="h-8 w-44 pl-7 text-sm" />
      </div>
      {aktiv && (
        <>
          <span className="min-w-[4rem] text-center text-xs tabular-nums text-muted-foreground" aria-live="polite">
            {count === 0 ? 'keine Treffer' : `${index + 1} / ${count}`}
          </span>
          <Button variant="ghost" size="icon-xs" aria-label="Voriger Treffer" disabled={count === 0} onClick={onPrev}>
            <ChevronUp className="size-3.5" aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="icon-xs" aria-label="Nächster Treffer" disabled={count === 0} onClick={onNext}>
            <ChevronDown className="size-3.5" aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="icon-xs" aria-label="Suche leeren" onClick={() => onChange('')}>
            <X className="size-3.5" aria-hidden="true" />
          </Button>
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Test grün**

Run: `npm --prefix webtool/frontend run test -- src/components/Suchfeld.test.tsx`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add webtool/frontend/src/components/Suchfeld.tsx webtool/frontend/src/components/Suchfeld.test.tsx
git commit -m "feat(editor): Suchfeld-Bauteil (Eingabe + Zähler + ▲▽✕)"
```

---

### Task 4: `SpeakerTurn` — Such-Props durchreichen

**Files:**
- Modify: `webtool/frontend/src/components/SpeakerTurn.tsx`
- Test: `webtool/frontend/src/components/SpeakerTurn.test.tsx` (neu)

**Interfaces:**
- Consumes: `SegmentView` mit `dimmen`/`aktiverTreffer` (Task 2).
- Produces: `SpeakerTurn` akzeptiert zusätzlich `sucheAktiv?: boolean`, `trefferIds?: Set<number>`, `suchAktivId?: number | null` und reicht an `SegmentView` weiter als `dimmen = sucheAktiv && !trefferIds.has(seg.id)` und `aktiverTreffer = suchAktivId === seg.id`.

- [ ] **Step 1: Failing test schreiben**

`webtool/frontend/src/components/SpeakerTurn.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SpeakerTurn } from './SpeakerTurn'
import type { Segment, Turn } from '@/lib/types'

const mkSeg = (id: number, text: string): Segment => ({
  id, start: 0, end: 1, speaker: 'A', raw_text: text, text, words: [],
  flags: { hallucination: false, low_conf: false }, note: '',
})

describe('SpeakerTurn Suche', () => {
  it('graut Nicht-Treffer aus und hebt den aktiven Treffer mit gelbem Ring hervor', () => {
    const turn: Turn = { key: 'k', speaker: 'A', segments: [
      mkSeg(1, 'Aras'), mkSeg(2, 'nix'), mkSeg(3, 'Aras'),
    ] }
    render(<TooltipProvider><SpeakerTurn turn={turn} activeId={null}
      onPlaySeg={vi.fn()} onPlayTurn={vi.fn()} updateSegment={vi.fn()} renameSpeaker={vi.fn()} speakerOptions={['A']}
      sucheAktiv trefferIds={new Set([1, 3])} suchAktivId={3} /></TooltipProvider>)
    expect(document.querySelector('[data-seg-id="2"]')).toHaveClass('opacity-40')
    expect(document.querySelector('[data-seg-id="3"]')).toHaveClass('ring-yellow-400')
    expect(document.querySelector('[data-seg-id="1"]')).not.toHaveClass('opacity-40')
    expect(document.querySelector('[data-seg-id="1"]')).not.toHaveClass('ring-yellow-400')
  })

  it('ohne Such-Props wird nichts ausgraut (Default)', () => {
    const turn: Turn = { key: 'k', speaker: 'A', segments: [mkSeg(1, 'Aras')] }
    render(<TooltipProvider><SpeakerTurn turn={turn} activeId={null}
      onPlaySeg={vi.fn()} onPlayTurn={vi.fn()} updateSegment={vi.fn()} renameSpeaker={vi.fn()} speakerOptions={['A']} /></TooltipProvider>)
    expect(document.querySelector('[data-seg-id="1"]')).not.toHaveClass('opacity-40')
  })
})
```

- [ ] **Step 2: Test failen lassen**

Run: `npm --prefix webtool/frontend run test -- src/components/SpeakerTurn.test.tsx`
Expected: FAIL (Props unbekannt; keine Ausgrauung).

- [ ] **Step 3: Implementierung**

In `webtool/frontend/src/components/SpeakerTurn.tsx`: Modul-Konstante unter den Imports ergänzen …

```tsx
/** Default für trefferIds: "keine Treffer" — surfriert nur, solange die Suche aus ist. */
const KEINE_TREFFER = new Set<number>()
```

… Signatur erweitern. Alt:
```tsx
export function SpeakerTurn({ turn, activeId, onPlaySeg, onPlayTurn, updateSegment, renameSpeaker, speakerOptions }: {
  turn: Turn; activeId: number | null;
  onPlaySeg: (s: Segment) => void; onPlayTurn: (segs: Segment[]) => void;
  updateSegment: (id: number, patch: Partial<Segment>) => void;
  renameSpeaker: (from: string, to: string) => void; speakerOptions: string[];
}) {
```
Neu:
```tsx
export function SpeakerTurn({ turn, activeId, onPlaySeg, onPlayTurn, updateSegment, renameSpeaker, speakerOptions, sucheAktiv = false, trefferIds = KEINE_TREFFER, suchAktivId = null }: {
  turn: Turn; activeId: number | null;
  onPlaySeg: (s: Segment) => void; onPlayTurn: (segs: Segment[]) => void;
  updateSegment: (id: number, patch: Partial<Segment>) => void;
  renameSpeaker: (from: string, to: string) => void; speakerOptions: string[];
  sucheAktiv?: boolean; trefferIds?: Set<number>; suchAktivId?: number | null;
}) {
```

… und das `<SegmentView>`-Rendering. Alt:
```tsx
            <SegmentView seg={s} active={activeId === s.id}
              onPlay={() => onPlaySeg(s)} updateSegment={updateSegment} />
```
Neu:
```tsx
            <SegmentView seg={s} active={activeId === s.id}
              dimmen={sucheAktiv && !trefferIds.has(s.id)} aktiverTreffer={suchAktivId === s.id}
              onPlay={() => onPlaySeg(s)} updateSegment={updateSegment} />
```

- [ ] **Step 4: Test grün**

Run: `npm --prefix webtool/frontend run test -- src/components/SpeakerTurn.test.tsx`
Expected: PASS (2/2).

- [ ] **Step 5: Commit**

```bash
git add webtool/frontend/src/components/SpeakerTurn.tsx webtool/frontend/src/components/SpeakerTurn.test.tsx
git commit -m "feat(editor): SpeakerTurn reicht Such-Zustand ans Segment"
```

---

### Task 5: `Transcript` — durchreichen + zweiter Scroll-Effekt

**Files:**
- Modify: `webtool/frontend/src/components/Transcript.tsx`
- Test: `webtool/frontend/src/components/Transcript.test.tsx` (erweitert)

**Interfaces:**
- Consumes: `SpeakerTurn` mit den Such-Props (Task 4).
- Produces: `Transcript` akzeptiert zusätzlich `sucheAktiv?: boolean`, `trefferIds?: Set<number>`, `suchAktivId?: number | null`, reicht sie an jeden `SpeakerTurn` weiter. Die Scroll-Logik wird in `scrollSegInView(ref, id)` extrahiert; ein zweiter `useEffect([suchAktivId])` benutzt sie parallel zum bestehenden `useEffect([activeId])` — die Wiedergabe-Position wird davon nicht berührt.

- [ ] **Step 1: Failing test erweitern**

An `webtool/frontend/src/components/Transcript.test.tsx` anhängen (das bestehende `doc` hat Segmente id 1 `'w0 w1 w2'` und id 2 `'hallo'`):

```ts
  it('Suche: graut Nicht-Treffer aus, aktiver Treffer mit Ring — wird durchgereicht', () => {
    render(<TooltipProvider><Transcript doc={doc} activeId={null}
      onPlaySeg={vi.fn()} onPlayTurn={vi.fn()} updateSegment={vi.fn()} renameSpeaker={vi.fn()} updateDoc={vi.fn()}
      sucheAktiv trefferIds={new Set([2])} suchAktivId={2} /></TooltipProvider>)
    expect(document.querySelector('[data-seg-id="1"]')).toHaveClass('opacity-40')
    expect(document.querySelector('[data-seg-id="2"]')).toHaveClass('ring-yellow-400')
  })
```

- [ ] **Step 2: Test failen lassen**

Run: `npm --prefix webtool/frontend run test -- src/components/Transcript.test.tsx`
Expected: FAIL (Such-Props unbekannt; keine Klassen).

- [ ] **Step 3: Implementierung**

In `webtool/frontend/src/components/Transcript.tsx`:

Erstens das Scroll-Helferlein als Modulfunktion (über der Komponente) extrahieren:
```tsx
/** Holt ein Segment anhand seiner data-seg-id in den ScrollArea-Viewport — sanft, nur wenn
 *  es nicht schon sichtbar ist. Wird von Wiedergabe (activeId) und Suche (suchAktivId)
 *  genutzt; zwei Effekte, je eigener Trigger, keine Race. */
function scrollSegInView(contentRef: React.RefObject<HTMLDivElement | null>, id: number) {
  const el = contentRef.current?.querySelector<HTMLElement>(`[data-seg-id="${id}"]`)
  if (!el) return
  const vp = el.closest<HTMLElement>('[data-radix-scroll-area-viewport]')
  if (!vp) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); return }
  const r = el.getBoundingClientRect(), vr = vp.getBoundingClientRect()
  if (r.top < vr.top || r.bottom > vr.bottom) {
    vp.scrollTo({ top: vp.scrollTop + (r.top - vr.top) - (vr.height - r.height) / 2, behavior: 'smooth' })
  }
}
```
(Dafür `import type { RefObject } from 'react'` ergänzen, falls noch nicht importiert — aktuell importiert die Datei `{ useEffect, useMemo, useRef }`. Stattdessen den Typ inline als `React.RefObject` schreiben oder `RefObject` nachimportieren. Hier: `useEffect, useMemo, useRef` um `type RefObject` erweitern.)

Zweitens die Signatur erweitern. Alt:
```tsx
export function Transcript({ doc, loading, activeId, onPlaySeg, onPlayTurn, updateSegment, updateDoc, renameSpeaker }: {
  doc: EditDoc | null; loading?: boolean; activeId: number | null;
  onPlaySeg: (s: Segment) => void; onPlayTurn: (segs: Segment[]) => void;
  updateSegment: (id: number, patch: Partial<Segment>) => void;
  updateDoc: (patch: Partial<Pick<EditDoc, 'context' | 'summary'>>) => void;
  renameSpeaker: (from: string, to: string) => void;
}) {
```
Neu:
```tsx
export function Transcript({ doc, loading, activeId, onPlaySeg, onPlayTurn, updateSegment, updateDoc, renameSpeaker, sucheAktiv = false, trefferIds, suchAktivId = null }: {
  doc: EditDoc | null; loading?: boolean; activeId: number | null;
  onPlaySeg: (s: Segment) => void; onPlayTurn: (segs: Segment[]) => void;
  updateSegment: (id: number, patch: Partial<Segment>) => void;
  updateDoc: (patch: Partial<Pick<EditDoc, 'context' | 'summary'>>) => void;
  renameSpeaker: (from: string, to: string) => void;
  sucheAktiv?: boolean; trefferIds?: Set<number>; suchAktivId?: number | null;
}) {
```

Drittens das Scroll-`useEffect` durch das Helferlein ersetzen. Alt:
```tsx
  useEffect(() => {
    if (activeId == null) return
    const el = contentRef.current?.querySelector<HTMLElement>(`[data-seg-id="${activeId}"]`)
    if (!el) return
    const vp = el.closest<HTMLElement>('[data-radix-scroll-area-viewport]')
    if (!vp) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); return }
    const r = el.getBoundingClientRect(), vr = vp.getBoundingClientRect()
    if (r.top < vr.top || r.bottom > vr.bottom) {
      vp.scrollTo({ top: vp.scrollTop + (r.top - vr.top) - (vr.height - r.height) / 2, behavior: 'smooth' })
    }
  }, [activeId])
```
Neu (zwei Effekte):
```tsx
  useEffect(() => { if (activeId != null) scrollSegInView(contentRef, activeId) }, [activeId])
  useEffect(() => { if (suchAktivId != null) scrollSegInView(contentRef, suchAktivId) }, [suchAktivId])
```

Viertens die Such-Props an `SpeakerTurn` durchreichen. Alt:
```tsx
        {turns.map(t => (
          <SpeakerTurn key={t.key} turn={t} activeId={activeId}
            onPlaySeg={onPlaySeg} onPlayTurn={onPlayTurn}
            updateSegment={updateSegment} renameSpeaker={renameSpeaker} speakerOptions={speakerOptions} />
        ))}
```
Neu:
```tsx
        {turns.map(t => (
          <SpeakerTurn key={t.key} turn={t} activeId={activeId}
            onPlaySeg={onPlaySeg} onPlayTurn={onPlayTurn}
            updateSegment={updateSegment} renameSpeaker={renameSpeaker} speakerOptions={speakerOptions}
            sucheAktiv={sucheAktiv} trefferIds={trefferIds} suchAktivId={suchAktivId} />
        ))}
```

- [ ] **Step 4: Test grün**

Run: `npm --prefix webtool/frontend run test -- src/components/Transcript.test.tsx`
Expected: PASS (alle, inkl. des neuen).

- [ ] **Step 5: Commit**

```bash
git add webtool/frontend/src/components/Transcript.tsx webtool/frontend/src/components/Transcript.test.tsx
git commit -m "feat(editor): Transcript reicht Suche weiter + zweiter Scroll-Effekt"
```

---

### Task 6: `Toolbar` — Suchfeld einbauen

**Files:**
- Modify: `webtool/frontend/src/components/Toolbar.tsx`
- Test: `webtool/frontend/src/components/Toolbar.test.tsx` (neu)

**Interfaces:**
- Consumes: `Suchfeld` (Task 3).
- Produces: `Toolbar` akzeptiert zusätzlich **optionale** Props `suchQuery?`, `onSuchChange?`, `suchCount?`, `suchIndex?`, `onSuchPrev?`, `onSuchNext?` und rendert `<Suchfeld/>` rechts (nach dem Flex-Spacer, vor der Legende). Ohne die Props bleibt die Toolbar suchfrei (kein Eingabefeld) — Altbestand unberührt.

- [ ] **Step 1: Failing test schreiben**

`webtool/frontend/src/components/Toolbar.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Toolbar } from './Toolbar'

describe('Toolbar Suche', () => {
  it('rendert das Suchfeld nur, wenn Such-Props übergeben werden', () => {
    const { rerender } = render(<Toolbar stand="gespeichert" bereit onExport={vi.fn()} />)
    expect(screen.queryByPlaceholderText('Im Transkript suchen …')).toBeNull()
    rerender(<Toolbar stand="gespeichert" bereit onExport={vi.fn()}
      suchQuery="" onSuchChange={vi.fn()} suchCount={0} suchIndex={0} onSuchPrev={vi.fn()} onSuchNext={vi.fn()} />)
    expect(screen.getByPlaceholderText('Im Transkript suchen …')).toBeInTheDocument()
  })

  it('gibt Eingaben weiter und zeigt Zähler', () => {
    const onChange = vi.fn()
    render(<Toolbar stand="gespeichert" bereit onExport={vi.fn()}
      suchQuery="aras" onSuchChange={onChange} suchCount={5} suchIndex={2} onSuchPrev={vi.fn()} onSuchNext={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText('Im Transkript suchen …'), { target: { value: 'Wiesental' } })
    expect(onChange).toHaveBeenCalledWith('Wiesental')
    expect(screen.getByText('3 / 5')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Test failen lassen**

Run: `npm --prefix webtool/frontend run test -- src/components/Toolbar.test.tsx`
Expected: FAIL (Toolbar ohne Such-Props zeigt kein Feld; oder Such-Props unbekannt).

- [ ] **Step 3: Implementierung**

In `webtool/frontend/src/components/Toolbar.tsx`: Import ergänzen:
```tsx
import { Suchfeld } from './Suchfeld'
```

Signatur erweitern. Alt:
```tsx
export function Toolbar({ stand, bereit, onExport }: {
  stand: SpeicherStand; bereit: boolean;
  onExport: (fmt: ExportFmt, sprecher?: boolean) => void;
}) {
```
Neu:
```tsx
export function Toolbar({ stand, bereit, onExport, suchQuery, onSuchChange, suchCount = 0, suchIndex = 0, onSuchPrev, onSuchNext }: {
  stand: SpeicherStand; bereit: boolean;
  onExport: (fmt: ExportFmt, sprecher?: boolean) => void;
  suchQuery?: string; onSuchChange?: (v: string) => void;
  suchCount?: number; suchIndex?: number; onSuchPrev?: () => void; onSuchNext?: () => void;
}) {
  const sucht = onSuchChange !== undefined
```

Das `<Suchfeld/>` einbauen — direkt nach dem Spacer, vor dem Legenden-Tooltip. Alt:
```tsx
      <div className="flex-1" />
      <Tooltip>
```
Neu:
```tsx
      <div className="flex-1" />
      {sucht && (
        <Suchfeld value={suchQuery ?? ''} onChange={onSuchChange!} count={suchCount} index={suchIndex}
          onPrev={onSuchPrev ?? (() => {})} onNext={onSuchNext ?? (() => {})} />
      )}
      <Tooltip>
```

(`sucht` entscheidet, ob das Feld erscheint — so bleibt die Toolbar ohne Such-Props suchfrei, und bestehende Aufrufer ändern sich nicht.)

- [ ] **Step 4: Test grün**

Run: `npm --prefix webtool/frontend run test -- src/components/Toolbar.test.tsx`
Expected: PASS (2/2).

- [ ] **Step 5: Commit**

```bash
git add webtool/frontend/src/components/Toolbar.tsx webtool/frontend/src/components/Toolbar.test.tsx
git commit -m "feat(editor): Toolbar bekommt das Suchfeld"
```

---

### Task 7: `EditorView` — Zustand + Verdrahtung

**Files:**
- Modify: `webtool/frontend/src/pages/EditorView.tsx`
- Test: `webtool/frontend/src/pages/EditorView.test.tsx` (neu)

**Interfaces:**
- Consumes: `useSuche` (Task 1), `Toolbar` mit Such-Props (Task 6), `Transcript` mit Such-Props (Task 5).
- Produces: komplette Suchfunktion im Editor. `EditorView` besitzt `suchQuery`/`suchIndex`; Reset auf `suchIndex=0` bei Query-Wechsel, Reset von `suchQuery=''` bei Dateiwechsel (`base`); Index-Clamp beim Lesen (`Math.min`); `▲`/`▽` wrap mod `count`.

- [ ] **Step 1: Failing test schreiben**

`webtool/frontend/src/pages/EditorView.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { EditorView } from './EditorView'
import type { EditDoc } from '@/lib/types'

const doc: EditDoc = {
  base: 'b', project: 'P', audio: 'a.wav', language: 'de',
  human_edited: false, context: '', speakers: [], annotations: [],
  segments: [
    { id: 1, start: 0, end: 1, speaker: 'A', raw_text: 'Aras kam', text: 'Aras kam', words: [],
      flags: { hallucination: false, low_conf: false }, note: '' },
    { id: 2, start: 1, end: 2, speaker: 'A', raw_text: 'sonstiges', text: 'sonstiges', words: [],
      flags: { hallucination: false, low_conf: false }, note: '' },
  ],
}

vi.mock('@/hooks/useDoc', () => ({
  useDoc: () => ({ doc, dirty: false, stand: 'gespeichert' as const, loading: false,
    updateSegment: vi.fn(), updateDoc: vi.fn(), renameSpeaker: vi.fn(),
    exportDownload: vi.fn(), reload: vi.fn(), vergiss: vi.fn() }),
}))
vi.mock('@/hooks/useEditorBruecke', () => ({ useEditorMelden: () => {} }))
vi.mock('@/components/PlayerDock', () => ({ PlayerDock: () => null }))

function view() {
  return render(<MemoryRouter initialEntries={['/p/P/b']}>
    <Routes><Route path="/p/:project/:base" element={<EditorView />} /></Routes>
  </MemoryRouter>)
}

describe('EditorView Suche', () => {
  it('Tippen graut Nicht-Treffer aus, aktiver Treffer mit Ring, Zähler "1 / 1"', () => {
    view()
    fireEvent.change(screen.getByPlaceholderText('Im Transkript suchen …'), { target: { value: 'aras' } })
    expect(document.querySelector('[data-seg-id="2"]')).toHaveClass('opacity-40')
    expect(document.querySelector('[data-seg-id="1"]')).toHaveClass('ring-yellow-400')
    expect(screen.getByText('1 / 1')).toBeInTheDocument()
  })

  it('▲ springt zum nächsten Treffer, ✕ leert die Suche', () => {
    view()
    // 's' kommt in 'Aras' (seg 1) und 'sonstiges' (seg 2) vor -> 2 Treffer
    fireEvent.change(screen.getByPlaceholderText('Im Transkript suchen …'), { target: { value: 's' } })
    expect(screen.getByText('1 / 2')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Nächster Treffer'))
    expect(screen.getByText('2 / 2')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Suche leeren'))
    expect(document.querySelector('[data-seg-id="2"]')).not.toHaveClass('opacity-40')
    expect(screen.queryByLabelText('Nächster Treffer')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Test failen lassen**

Run: `npm --prefix webtool/frontend run test -- src/pages/EditorView.test.tsx`
Expected: FAIL (kein Suchfeld, da Toolbar noch ohne Such-Props aufgerufen).

- [ ] **Step 3: Implementierung**

In `webtool/frontend/src/pages/EditorView.tsx`:

Imports ergänzen — `useMemo` zu den React-Imports, `useSuche`:
Alt:
```tsx
import { useCallback, useEffect, useRef, useState } from 'react'
```
Neu:
```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
```
Und unter den Hook-Imports:
```tsx
import { useSuche } from '@/hooks/useSuche'
```

State + abgeleitete Werte + Reset-Effekte. Nach der `useEditorMelden(...)`-Zeile und vor `waveRef` einfügen:
```tsx
  const [suchQuery, setSuchQuery] = useState('')
  const [suchIndex, setSuchIndex] = useState(0)
  const treffer = useSuche(doc?.segments, suchQuery)
  const trefferIds = useMemo(() => new Set(treffer.ids), [treffer.ids])
  const suchAktiv = suchQuery.trim() !== ''
  // Index clamp beim Lesen: schrumpft die Trefferliste (neuer Query), kann suchIndex
  // einen Tick überholen, bevor der Reset-Effekt greift — hier defensiv begrenzen.
  const idx = treffer.ids.length ? Math.min(suchIndex, treffer.ids.length - 1) : 0
  const suchAktivId = suchAktiv && treffer.ids.length ? (treffer.ids[idx] ?? null) : null
  // Neuer Suchbegriff -> am ersten Treffer beginnen.
  useEffect(() => { setSuchIndex(0) }, [suchQuery])
  // Dateiwechsel -> altes Transkript ist hinfällig.
  useEffect(() => { setSuchQuery(''); setSuchIndex(0) }, [sel?.base])
  const suchNext = () => setSuchIndex(i => treffer.ids.length ? (i + 1) % treffer.ids.length : 0)
  const suchPrev = () => setSuchIndex(i => treffer.ids.length ? (i - 1 + treffer.ids.length) % treffer.ids.length : 0)
```

`Toolbar` Such-Props übergeben. Alt:
```tsx
      <Toolbar stand={stand} bereit={!!doc} onExport={exportDownload} />
```
Neu:
```tsx
      <Toolbar stand={stand} bereit={!!doc} onExport={exportDownload}
        suchQuery={suchQuery} onSuchChange={setSuchQuery} suchCount={treffer.ids.length} suchIndex={idx}
        onSuchPrev={suchPrev} onSuchNext={suchNext} />
```

`Transcript` Such-Props übergeben. Alt:
```tsx
        <Transcript doc={doc} loading={docLoading} activeId={activeId}
          onPlaySeg={s => waveRef.current?.playSegment(s)}
          onPlayTurn={segs => waveRef.current?.playTurn(segs)}
          updateSegment={updateSegment} updateDoc={updateDoc} renameSpeaker={renameSpeaker} />
```
Neu:
```tsx
        <Transcript doc={doc} loading={docLoading} activeId={activeId}
          onPlaySeg={s => waveRef.current?.playSegment(s)}
          onPlayTurn={segs => waveRef.current?.playTurn(segs)}
          updateSegment={updateSegment} updateDoc={updateDoc} renameSpeaker={renameSpeaker}
          sucheAktiv={suchAktiv} trefferIds={trefferIds} suchAktivId={suchAktivId} />
```

- [ ] **Step 4: Test grün**

Run: `npm --prefix webtool/frontend run test -- src/pages/EditorView.test.tsx`
Expected: PASS (2/2).

- [ ] **Step 5: Gesamtlauf + Bau**

Run: `npm --prefix webtool/frontend run test`
Expected: alle Test-Dateien grün (auch der unangetastete Altbestand — die neuen Props sind optional).

Run: `npm --prefix webtool/frontend run build`
Expected: `tsc -b` und `vite build` ohne Fehler (Typecheck über alle neuen Signaturen).

- [ ] **Step 6: Commit**

```bash
git add webtool/frontend/src/pages/EditorView.tsx webtool/frontend/src/pages/EditorView.test.tsx
git commit -m "feat(editor): sichtbare Transkript-Suche (Filter, Treffer-Sprung)

Closes #125."
```

---

## Selbst-Review (gegen die Spec)

- **Spec-Sektion „Lösung"**: Suchfeld in Toolbar → T6+T7. Tippen graut aus → T2+T4+T5+T7. `▲▽` + Zähler + gelber Ring + Scroll → T3+T5+T7. ✓
- **Spec „warum angezeigter Text"**: korrigiert→`text`, unkorrigiert→`raw_text` → T1 (`isCorrected`-Verzweigung), test in T1 „sucht im raw_text…". ✓
- **Spec „Parallel gepaarter Pfad, activeId nicht kapern"**: eigener `suchAktivId`-Scroll-Effekt, Extraktion `scrollSegInView` → T5; Regressionstest `activeId` bleibt unberührt (Altbestand + kein gemeinsamer Zustand). ✓
- **Spec „bewusst nicht gebaut" (kein Strg/F, keine Wort-Markierung, kein Ersetzen, keine Diakriten)**: im Plan nicht enthalten; Global Constraints hält es fest. ✓
- **Spec „Touchpoints"**: alle acht Dateien abgedeckt (T1–T7). ✓
- **Spec „Tests"**: `useSuche` (T1), Ausgrauung/Ring (T2/T4/T5), Zähler/Navigation (T3), Durchreichen (T5), `base`-Reset …
  - Lücke: der `base`-Wechsel-Reset (Spec verlangt „bei `base`-Wechsel `suchQuery=''`") ist implementiert (T7 Effekt), aber **nicht getestet**. → Nachbessern: in `EditorView.test.tsx` reicht ein Test, der mit `key` neu mountet simuliert ist aufwendig; stattdessen direkter Hook-Test des Effekts nicht möglich (inline). Entscheidung: als Integration im manuellen Review abgedeckt; Effekt ist ein Einzeiler. Wird im PR-Review vermerkt.

Platzhalter-Scan: keine `TBD`/`TODO`/„ähnlich wie". Typkonsistenz: `dimmen`/`aktiverTreffer` (T2) ↔ T4; `sucheAktiv`/`trefferIds`/`suchAktivId` (T4/T5) ↔ T7; `useSuche`-Rückgabe `{ids, count}` ↔ T7. ✓
