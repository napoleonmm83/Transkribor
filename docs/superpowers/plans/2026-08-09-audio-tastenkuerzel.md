# Tastenkürzel für die Audio-Wiedergabe — Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die Wiedergabe im Editor mit `Ctrl+Space` (Play/Pause) und `Ctrl+←/→` (±2 s) bedienen, ohne die Tastatur zu verlassen.

**Architecture:** Die Entscheidung „was tun, wenn jemand Ctrl+Space drückt" wird als reine Funktion `naechsteAktion` in `lib/playback.ts` gekapselt und dort getestet. `Waveform.tsx` führt sie nur aus und hält den wavesurfer-Zustand (läuft es, wo steht es, welches Fenster zuletzt). `EditorView.tsx` bestimmt allein, *welches* Segment gemeint ist — aus `document.activeElement.closest('[data-seg-id]')`, sonst `activeId`.

**Tech Stack:** React 19, TypeScript, vitest + @testing-library, wavesurfer.js 7.12.11 via `@wavesurfer/react`.

**Spec:** [`docs/superpowers/specs/2026-08-09-transkribor-audio-tastenkuerzel-design.md`](../specs/2026-08-09-transkribor-audio-tastenkuerzel-design.md)

## Global Constraints

- **Arbeitsverzeichnis für alle npm-Befehle:** `webtool/frontend` (`npm --prefix webtool/frontend …` vom Repo-Root aus).
- **Branch:** `feat/audio-tastenkuerzel` (existiert, Spec liegt darauf als `498433c`).
- **Belegung ist fix:** `Ctrl+Space` = Play/Pause, `Ctrl+←` = 2 s zurück, `Ctrl+→` = 2 s vor. Dieselbe Belegung im Textfeld wie ausserhalb. Die blosse Leertaste bleibt Leertaste — **keine** Fokus-Sonderfälle.
- **Kein Backend, kein Python.** Fünf Frontend-Dateien, sonst nichts.
- **Deutsche Bezeichner** in neuem Code, wie im Rest von `webtool/frontend/src/lib` (`naechsteAktion`, `fenster`, `laeuft`). Kommentare deutsch, ohne Umlaut-Verlust (die Dateien sind UTF-8).
- **Bestehende Tests bleiben grün:** `npm --prefix webtool/frontend test` (aktuell 129 Tests).
- **`aria-label` wird nicht angefasst.** Nur `title`. Der zugängliche Name eines Knopfes ist nicht der Ort für eine Tastenkombination.

## File Structure

| Datei | Verantwortung | Änderung |
|---|---|---|
| `webtool/frontend/src/lib/playback.ts` | Reine Wiedergabe-Logik: Fenster berechnen, Aktion entscheiden, Sprungziel klemmen, Segment-ID aus dem Fokus lesen | erweitert (bisher nur `PAD` + `playWindow`) |
| `webtool/frontend/src/lib/playback.test.ts` | Tests dazu | erweitert (bisher nur `playWindow`) |
| `webtool/frontend/src/components/Waveform.tsx` | wavesurfer-Anbindung, hält das zuletzt gespielte Fenster | `WaveHandle` um `toggle`/`skip` erweitert |
| `webtool/frontend/src/pages/EditorView.tsx` | Tastatur-Listener, bestimmt das gemeinte Segment | `useEffect` mit `keydown` dazu |
| `webtool/frontend/src/components/SegmentView.tsx` | Segment-Darstellung | `title` des ▶ um das Kürzel ergänzt |

---

### Task 1: Die Entscheidungslogik in `playback.ts`

Reine Funktionen, kein DOM ausser einem `Element`-Argument, kein wavesurfer. Der ganze Verstand des Features steckt hier und wird hier geprüft.

**Files:**
- Modify: `webtool/frontend/src/lib/playback.ts`
- Test: `webtool/frontend/src/lib/playback.test.ts`

**Interfaces:**
- Consumes: `playWindow(seg, duration)` und `PAD` (existieren bereits in derselben Datei), `Segment` aus `./types`.
- Produces: `SKIP: number`, `type Fenster`, `type Aktion`, `naechsteAktion(zustand): Aktion`, `skipZiel(zeit, sekunden, dauer): number`, `segIdAusFokus(el, fallback): number | null`. Task 2 nutzt `Fenster`, `Aktion`, `naechsteAktion`, `skipZiel`; Task 3 nutzt `SKIP` und `segIdAusFokus`.

- [ ] **Step 1: Die fehlschlagenden Tests schreiben**

An `webtool/frontend/src/lib/playback.test.ts` anhängen (der bestehende `playWindow`-Block bleibt unberührt). Den Import in Zeile 2 erweitern zu:

```ts
import { playWindow, naechsteAktion, skipZiel, segIdAusFokus, SKIP } from './playback'
import type { Segment } from './types'
```

Danach anhängen. **Beachte `expect.closeTo` bei den Fenstergrenzen:** `31.98 - 0.15` ergibt in
Fliesskomma `31.830000000000002`, ein `toEqual` mit `31.83` fiele durch. Der bestehende
`playWindow`-Block benutzt aus demselben Grund sein `near()`.

```ts
/** Nur die Felder, die naechsteAktion liest — der Rest von Segment ist hier Ballast. */
const seg = (id: number, start: number, end: number) =>
  ({ id, start, end }) as unknown as Segment

describe('naechsteAktion', () => {
  it('pausiert, wenn etwas laeuft — egal was sonst anliegt', () => {
    expect(naechsteAktion({
      laeuft: true, fenster: { from: 1, to: 2, segId: 7 }, zeit: 1.5, segment: seg(9, 30, 31), dauer: 60,
    })).toEqual({ art: 'pause' })
  })

  it('spielt das gewaehlte Segment, wenn noch nichts gespielt wurde', () => {
    expect(naechsteAktion({
      laeuft: false, fenster: null, zeit: 0, segment: seg(47, 18.36, 20.06), dauer: 60,
    })).toEqual({
      art: 'fenster', from: expect.closeTo(18.21, 9), to: expect.closeTo(20.41, 9), segId: 47,
    })
  })

  it('setzt im gemerkten Fenster fort UND setzt die Grenze neu', () => {
    expect(naechsteAktion({
      laeuft: false, fenster: { from: 18.21, to: 20.41, segId: 47 }, zeit: 19.0, segment: null, dauer: 60,
    })).toEqual({ art: 'weiter', to: 20.41 })
  })

  it('setzt auch dann fort, wenn der Cursor im selben Segment steht (Pause -> weiter)', () => {
    expect(naechsteAktion({
      laeuft: false, fenster: { from: 18.21, to: 20.41, segId: 47 }, zeit: 19.0,
      segment: seg(47, 18.36, 20.06), dauer: 60,
    })).toEqual({ art: 'weiter', to: 20.41 })
  })

  it('springt zum anderen Segment, statt fortzusetzen', () => {
    expect(naechsteAktion({
      laeuft: false, fenster: { from: 18.21, to: 20.41, segId: 47 }, zeit: 19.0,
      segment: seg(48, 31.98, 42.76), dauer: 60,
    })).toEqual({
      // 31.98 - 0.15 ist in Fliesskomma 31.830000000000002 — darum closeTo und nicht 31.83.
      art: 'fenster', from: expect.closeTo(31.83, 9), to: expect.closeTo(43.11, 9), segId: 48,
    })
  })

  it('vergisst das Fenster, wenn die Position herausgespult wurde', () => {
    expect(naechsteAktion({
      laeuft: false, fenster: { from: 18.21, to: 20.41, segId: 47 }, zeit: 22.5, segment: null, dauer: 60,
    })).toEqual({ art: 'weiter' })
  })

  it('spielt blank weiter, wenn es weder Fenster noch Segment gibt', () => {
    expect(naechsteAktion({
      laeuft: false, fenster: null, zeit: 5, segment: null, dauer: 60,
    })).toEqual({ art: 'weiter' })
  })

  it('behandelt einen Redebeitrag (segId null) als fremdes Fenster', () => {
    expect(naechsteAktion({
      laeuft: false, fenster: { from: 10, to: 40, segId: null }, zeit: 20,
      segment: seg(47, 18.36, 20.06), dauer: 60,
    })).toEqual({
      art: 'fenster', from: expect.closeTo(18.21, 9), to: expect.closeTo(20.41, 9), segId: 47,
    })
  })
})

describe('skipZiel', () => {
  it.each([
    [10, SKIP, 60, 12],
    [10, -SKIP, 60, 8],
    [1, -SKIP, 60, 0],       // nicht vor den Anfang
    [59.5, SKIP, 60, 60],    // nicht hinter das Ende
    [10, SKIP, NaN, 12],     // Dauer unbekannt -> kein oberes Clamp
  ])('klemmt %s + %s bei Dauer %s auf %s', (zeit, s, dauer, erwartet) => {
    expect(skipZiel(zeit, s, dauer)).toBe(erwartet)
  })
})

describe('segIdAusFokus', () => {
  it('liest die id aus dem umgebenden Segment-Div', () => {
    document.body.innerHTML = '<div data-seg-id="47"><textarea id="t"></textarea></div>'
    expect(segIdAusFokus(document.getElementById('t'), 3)).toBe(47)
  })

  it('faellt auf das hervorgehobene Segment zurueck, wenn der Fokus woanders steht', () => {
    document.body.innerHTML = '<button id="b"></button>'
    expect(segIdAusFokus(document.getElementById('b'), 3)).toBe(3)
  })

  it('faellt auch ohne Fokus zurueck', () => {
    expect(segIdAusFokus(null, 3)).toBe(3)
    expect(segIdAusFokus(null, null)).toBe(null)
  })
})
```

- [ ] **Step 2: Tests laufen lassen, Fehlschlag bestätigen**

Run: `npm --prefix webtool/frontend test -- playback`
Expected: FAIL — `naechsteAktion is not a function` bzw. TypeScript meckert über die fehlenden Exporte.

- [ ] **Step 3: Die Implementierung schreiben**

An `webtool/frontend/src/lib/playback.ts` anhängen (bestehende `PAD`/`playWindow` bleiben, wie sie sind):

```ts
import type { Segment } from './types'

/** Sprungweite pro Ctrl+←/→. Zwei Sekunden ist die Faustregel aus der Transkriptionsarbeit:
 *  lang genug fuer ein verschlucktes Wort, kurz genug, um nicht den Satz zu verlieren. */
export const SKIP = 2

/** Das zuletzt angespielte Stueck. `segId` ist null nach einem ganzen Redebeitrag. */
export type Fenster = { from: number; to: number; segId: number | null }

export type Aktion =
  | { art: 'pause' }
  /** play(undefined, to) — Position bleibt, Grenze wird (falls gesetzt) neu scharf gestellt. */
  | { art: 'weiter'; to?: number }
  /** play(from, to) — an eine andere Stelle springen. */
  | { art: 'fenster'; from: number; to: number; segId: number }

/** Was Ctrl+Space als Naechstes tun soll.
 *
 *  Reihenfolge ist der ganze Witz: ein *anderes* Segment schlaegt das Fortsetzen (Regel 2 vor 3),
 *  sonst liesse sich eine Stelle nie gezielt nochmal hoeren. Verglichen wird die Segment-ID und
 *  nicht das Zeitfenster — playWindow rechnet Fliesskomma, ein Gleichheitstest darauf waere eine
 *  Wanze, die erst bei irgendeinem krummen Zeitstempel zubeisst. */
export function naechsteAktion(z: {
  laeuft: boolean
  fenster: Fenster | null
  zeit: number
  segment: Segment | null
  dauer: number
}): Aktion {
  if (z.laeuft) return { art: 'pause' }
  if (z.segment && z.segment.id !== z.fenster?.segId) {
    const { from, to } = playWindow(z.segment, z.dauer)
    return { art: 'fenster', from, to, segId: z.segment.id }
  }
  // Ausserhalb des Fensters heisst: jemand hat herausgespult. Dann gilt die Grenze nicht mehr,
  // sonst hielte das Fortsetzen sofort wieder an.
  if (z.fenster && z.zeit >= z.fenster.from && z.zeit < z.fenster.to) {
    return { art: 'weiter', to: z.fenster.to }
  }
  return { art: 'weiter' }
}

export function skipZiel(zeit: number, sekunden: number, dauer: number) {
  const ziel = Math.max(0, zeit + sekunden)
  return Number.isFinite(dauer) ? Math.min(dauer, ziel) : ziel
}

/** Welches Segment gemeint ist: beim Tippen steckt die Textarea im Segment-Div, sonst gilt das
 *  hervorgehobene. `data-seg-id` rendert SegmentView bereits, Transcript.tsx liest es genauso. */
export function segIdAusFokus(el: Element | null | undefined, fallback: number | null): number | null {
  const roh = el?.closest('[data-seg-id]')?.getAttribute('data-seg-id')
  const id = roh == null ? NaN : Number(roh)
  return Number.isFinite(id) ? id : fallback
}
```

- [ ] **Step 4: Tests laufen lassen, grün bestätigen**

Run: `npm --prefix webtool/frontend test -- playback`
Expected: PASS — der `playWindow`-Block (5 Fälle) plus die neuen Blöcke.

- [ ] **Step 5: Ganze Suite + Typprüfung**

Run: `npm --prefix webtool/frontend test` → alle grün (129 bisherige + neue).
Run: `npm --prefix webtool/frontend run build` → `tsc -b` ohne Fehler.

- [ ] **Step 6: Commit**

```bash
git add webtool/frontend/src/lib/playback.ts webtool/frontend/src/lib/playback.test.ts
git commit -m "feat(player): die Entscheidung hinter Ctrl+Space als pruefbare Funktion

naechsteAktion kennt vier Faelle; der verzwickte ist, dass ein anderes Segment
das Fortsetzen schlagen muss, sonst laesst sich eine Stelle nie gezielt nochmal
hoeren. Verglichen wird die Segment-ID statt des Zeitfensters — playWindow
rechnet Fliesskomma.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `Waveform` führt aus und merkt sich das Fenster

**Files:**
- Modify: `webtool/frontend/src/components/Waveform.tsx`

**Interfaces:**
- Consumes: `naechsteAktion`, `skipZiel`, `playWindow`, `type Fenster` aus `@/lib/playback` (Task 1).
- Produces: `WaveHandle` mit `playSegment`, `playTurn`, **`toggle(seg?: Segment | null): void`**, **`skip(sekunden: number): void`**. Task 3 ruft `toggle` und `skip` über `waveRef.current`.

**Warum kein Test:** Diese Datei ist nach der Extraktion aus Task 1 nur noch Klebstoff zu wavesurfer. Ein Test bräuchte eine Audio-Attrappe (WebAudio, Decoding, `isPlaying`), die mehr Wartung kostet, als sie fängt. Die Prüfung ist Task 3, Step 4 — von Hand im Browser.

- [ ] **Step 1: Import und Typ erweitern**

In `webtool/frontend/src/components/Waveform.tsx` Zeile 3 ersetzen:

```ts
import { playWindow, naechsteAktion, skipZiel, type Fenster } from '@/lib/playback'
```

Und `WaveHandle` (Zeile 7) ersetzen durch:

```ts
export type WaveHandle = {
  playSegment: (s: Segment) => void
  playTurn: (s: Segment[]) => void
  /** Play/Pause. `seg` = das Segment unter dem Cursor, falls es eines gibt. */
  toggle: (seg?: Segment | null) => void
  skip: (sekunden: number) => void
}
```

- [ ] **Step 2: Fenster-Ref anlegen**

Nach der `useWavesurfer`-Zeile (aktuell Zeile 21-24, direkt nach der schliessenden `})`) einfügen:

```ts
    // Das zuletzt angespielte Stueck. Muss hier liegen und nicht in wavesurfer: der loescht
    // seine eigene Endgrenze (stopAtPosition) im pause-Handler, ein blosses playPause() liefe
    // darum ueber das Segmentende hinaus.
    const fenster = useRef<Fenster | null>(null)
    useEffect(() => { fenster.current = null }, [url])   // andere Datei -> alte Grenze gilt nicht
```

- [ ] **Step 3: `useImperativeHandle` ersetzen**

Den Block aus Zeile 33-46 vollständig ersetzen:

```ts
    useImperativeHandle(ref, () => ({
      playSegment(s) {
        if (!wavesurfer) return
        const { from, to } = playWindow(s, wavesurfer.getDuration())
        fenster.current = { from, to, segId: s.id }
        wavesurfer.play(from, to)?.catch(() => {})
      },
      playTurn(segs) {
        if (!wavesurfer || !segs.length) return
        const dur = wavesurfer.getDuration()
        const from = playWindow(segs[0], dur).from
        const to = playWindow(segs[segs.length - 1], dur).to
        fenster.current = { from, to, segId: null }
        wavesurfer.play(from, to)?.catch(() => {})
      },
      toggle(seg) {
        if (!wavesurfer) return
        const a = naechsteAktion({
          laeuft: wavesurfer.isPlaying(),
          fenster: fenster.current,
          zeit: wavesurfer.getCurrentTime(),
          segment: seg ?? null,
          dauer: wavesurfer.getDuration(),
        })
        if (a.art === 'pause') { wavesurfer.pause(); return }
        if (a.art === 'fenster') {
          fenster.current = { from: a.from, to: a.to, segId: a.segId }
          wavesurfer.play(a.from, a.to)?.catch(() => {})
          return
        }
        if (a.to == null) fenster.current = null
        // Kein Startwert: die Position bleibt stehen, nur die Grenze wird neu gesetzt.
        wavesurfer.play(undefined, a.to)?.catch(() => {})
      },
      skip(sekunden) {
        if (!wavesurfer) return
        // setTime loescht stopAtPosition — hier erwuenscht: wer vorspult, will ueber das
        // Segmentende hinaus hoeren. Das Ref bleibt stehen, naechsteAktion verwirft es dann.
        wavesurfer.setTime(skipZiel(wavesurfer.getCurrentTime(), sekunden, wavesurfer.getDuration()))
      },
    }), [wavesurfer])
```

- [ ] **Step 4: Typprüfung + Suite**

Run: `npm --prefix webtool/frontend run build`
Expected: `tsc -b` ohne Fehler. Schlägt es fehl, weil `useRef`/`useEffect` nicht importiert sind: Zeile 1 prüfen — beide werden bereits importiert.

Run: `npm --prefix webtool/frontend test`
Expected: alle grün (`Waveform` wird von keinem Test gerendert, aber `EditorView`-nahe Tests dürfen nicht brechen).

- [ ] **Step 5: Commit**

```bash
git add webtool/frontend/src/components/Waveform.tsx
git commit -m "feat(player): toggle und skip am WaveHandle, mit gemerktem Fenster

Fortgesetzt wird mit play(undefined, to) statt playPause(): wavesurfer wirft
stopAtPosition im pause-Handler weg, die Segmentgrenze muss beim Fortsetzen
also neu scharf gestellt werden.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Tasten anschliessen und den Hinweis setzen

**Files:**
- Modify: `webtool/frontend/src/pages/EditorView.tsx`
- Modify: `webtool/frontend/src/components/SegmentView.tsx:36`

**Interfaces:**
- Consumes: `SKIP`, `segIdAusFokus` aus `@/lib/playback` (Task 1); `waveRef.current.toggle` / `.skip` (Task 2).
- Produces: nichts für spätere Tasks — das ist der letzte.

- [ ] **Step 1: Import in `EditorView.tsx` ergänzen**

Nach Zeile 8 (`import { uploadAudio, … } from '@/lib/api'`) einfügen:

```ts
import { SKIP, segIdAusFokus } from '@/lib/playback'
```

- [ ] **Step 2: Den Tastatur-Listener einsetzen**

Direkt nach dem `onTime`-`useCallback` (endet aktuell Zeile 39) einfügen:

```tsx
  // Eine Belegung fuer drinnen wie draussen: die blosse Leertaste tippt im Segment ein
  // Leerzeichen und darf nicht umgedeutet werden, und zwei Belegungen je nach Fokus erzeugen
  // nur die Frage "warum geht das hier nicht".
  // ponytail: fest verdrahtet. Auf macOS faengt Mission Control Ctrl+←/→ ab und Cmd+Space ist
  // Spotlight — dort kommen die Kuerzel teils nicht an. Konfigurierbar machen, wenn das je
  // jemanden stoert (Issue #36: die Mac-Seite ist bis heute nie gestartet worden).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.shiftKey) return
      if (e.key === ' ') {
        e.preventDefault()
        const id = segIdAusFokus(document.activeElement, activeId)
        waveRef.current?.toggle(doc?.segments.find(s => s.id === id) ?? null)
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        waveRef.current?.skip(e.key === 'ArrowLeft' ? -SKIP : SKIP)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [doc, activeId])
```

- [ ] **Step 3: Den Hinweis an den Segment-▶ schreiben**

In `webtool/frontend/src/components/SegmentView.tsx` Zeile 36, **nur** das `title`-Attribut:

```tsx
      <button onClick={onPlay} title="Abspielen (Ctrl+Space)" aria-label="Segment abspielen"
```

`aria-label` bleibt unverändert. Der ▶ am Redebeitrag (`SpeakerTurn.tsx:43`) wird **nicht** angefasst — er spielt den ganzen Beitrag, `Ctrl+Space` das einzelne Segment.

- [ ] **Step 4: Von Hand prüfen — das ist der eigentliche Test dieses Features**

```powershell
.\webtool.ps1
```

Ein Projekt mit Audio öffnen (`/p/<Projekt>/<base>`) und der Reihe nach:

1. In ein Segment klicken (Textarea offen) → `Ctrl+Space` → **genau dieses** Segment spielt und stoppt am Ende.
2. Während es läuft `Ctrl+Space` → Pause. Nochmal `Ctrl+Space` → läuft weiter und **stoppt wieder am Segmentende** (das ist der Fall, den `playPause()` kaputtgemacht hätte).
3. `Ctrl+→` zweimal → springt über das Segmentende hinaus; `Ctrl+Space` läuft von dort **ohne** Grenze weiter.
4. `Ctrl+←` → 2 s zurück, hörbar.
5. Im Textfeld die blosse Leertaste tippen → schreibt ein Leerzeichen, spielt nichts ab.
6. Ohne Bearbeitung (irgendwo hinklicken, Fokus ausserhalb) → `Ctrl+Space` spielt das hervorgehobene Segment.
7. Datei in der Sidebar wechseln → `Ctrl+Space` spielt nicht das Fenster der alten Datei.
8. Mit der Maus auf ▶ zeigen → Tooltip nennt „Abspielen (Ctrl+Space)".

- [ ] **Step 5: Suite + Build**

Run: `npm --prefix webtool/frontend test` → alle grün.
Run: `npm --prefix webtool/frontend run build` → ohne Fehler.
Run: `npm --prefix webtool/frontend run lint` → keine neuen Warnungen (Basis: 8 bestehende).

- [ ] **Step 6: Commit**

```bash
git add webtool/frontend/src/pages/EditorView.tsx webtool/frontend/src/components/SegmentView.tsx
git commit -m "feat(editor): Ctrl+Space und Ctrl+←→ steuern die Wiedergabe

Welches Segment gemeint ist, steht im DOM: beim Tippen steckt die Textarea im
Segment-Div, sonst gilt das hervorgehobene. Kein neuer State, kein neues Prop —
data-seg-id liegt schon da und wird in Transcript.tsx genauso gelesen.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7: PR öffnen**

```bash
git push -u origin feat/audio-tastenkuerzel
gh pr create --base master --title "Tastenkuerzel fuer die Wiedergabe" --body "$(cat <<'EOF'
Der Audio-Player im Editor war laengst fertig — Wellenform, Segment-▶, Hervorhebung.
Was beim Korrigieren fehlte, war die Bedienung ohne Maus: der Cursor steht in der
Textarea, und jedes Nachhoeren kostete den Weg zur Maus und zurueck.

`Ctrl+Space` spielt/pausiert das Segment unter dem Cursor, `Ctrl+←/→` springt 2 s.
Eine Belegung fuer drinnen wie draussen; die blosse Leertaste bleibt Leertaste.

Der Fund, der das Design bestimmt hat: wavesurfer loescht `stopAtPosition` in seinem
`pause`-Handler, ein `playPause()` beim Fortsetzen waere also ueber das Segmentende
hinausgelaufen — ein Fehler, der beim ersten Klick funktioniert und erst beim dritten
auffaellt. Fortgesetzt wird darum mit `play(undefined, to)`.

Die Entscheidung dahinter (vier Faelle) liegt als reine Funktion in `lib/playback.ts`
und ist dort getestet; `Waveform.tsx` fuehrt nur aus.

Spec: `docs/superpowers/specs/2026-08-09-transkribor-audio-tastenkuerzel-design.md`
Von Hand geprueft im Browser (die 8 Schritte aus dem Plan, Task 3 Step 4).

**Bekannte Grenze:** auf macOS faengt Mission Control `Ctrl+←/→` ab. Als
`ponytail:`-Kommentar vermerkt, nicht geloest — die Mac-Seite ist laut #36 nie
gestartet worden.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec-Abdeckung:**

| Spec-Abschnitt | Task |
|---|---|
| 2 · Belegung (Ctrl+Space, Ctrl+←/→, eine Regel) | Task 3, Step 2 |
| 2 · macOS-Grenze als `ponytail:`-Kommentar | Task 3, Step 2 |
| 3 · Play/Pause-Semantik (4 Fälle) | Task 1, Steps 1+3 |
| 3.1 · Fortsetzen mit `play(undefined, to)` | Task 2, Step 3 |
| 4.1 · `naechsteAktion` in `playback.ts` | Task 1 |
| 4.2 · `WaveHandle` um `toggle`/`skip` | Task 2 |
| 4.3 · Segment aus `activeElement.closest` | Task 1 (`segIdAusFokus`) + Task 3, Step 2 |
| 4.4 · `title` nur am Segment-▶ | Task 3, Step 3 |
| 5 · Tests (6 Fälle + `playWindow` bleibt) | Task 1, Step 1 — 8 Fälle für `naechsteAktion` |
| 6 · Risiko „Fenster nach Dateiwechsel" | Task 2, Step 2 (`useEffect` auf `url`) |

**Typkonsistenz:** `Fenster` heisst in Task 1, 2 und den Tests gleich; `naechsteAktion` nimmt überall `{laeuft, fenster, zeit, segment, dauer}`; `toggle(seg?: Segment | null)` wird in Task 3 mit `… ?? null` gerufen, passt.

**Keine Platzhalter:** jeder Code-Schritt enthält den vollständigen Text zum Einsetzen.

**Beim Gegenlesen gefunden und korrigiert:** die Fenster-Tests standen zuerst mit exakten Zahlen
da (`toEqual({from: 31.83, …})`). `31.98 - 0.15` ergibt in Fliesskomma aber `31.830000000000002` —
die Tests wären am ersten Lauf durchgefallen, an genau der Falle, vor der die Spec bei der
Segment-ID warnt. Jetzt `expect.closeTo(…, 9)`, wie es der bestehende `playWindow`-Block mit seinem
`near()` seit jeher tut.
