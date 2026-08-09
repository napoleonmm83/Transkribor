# Transkribor — Tastenkürzel für die Audio-Wiedergabe (Design)

- **Datum:** 2026-08-09
- **Status:** Entwurf genehmigt → bereit für Implementierungsplan
- **Betrifft:** `webtool/frontend/` (nur Frontend, 5 Dateien; kein Backend, kein Python)
- **Vorgänger-Specs:** [`2026-07-06-transkribor-webtool-design.md`](2026-07-06-transkribor-webtool-design.md), [`2026-07-09-transkribor-webtool-redesign.md`](2026-07-09-transkribor-webtool-redesign.md)

## 1 · Problem & Ziel

Der Audio-Player im Editor ist vollständig gebaut: Wellenform-Dock (`Waveform.tsx`, wavesurfer 7.12),
Audio per HTTP-Range aus `GET /api/projects/{p}/audio/{base}`, ein ▶ an jedem Segment und an jedem
Redebeitrag, und das laufende Segment wird hervorgehoben. **Was fehlt, ist die Bedienung ohne Maus.**

Beim Korrigieren steht der Cursor in der Textarea eines Segments (`SegmentEditor.tsx`). Willst du
nachhören, was da eigentlich gesagt wurde, musst du: zur Maus greifen, den 12px grossen ▶ treffen,
zurück ins Textfeld klicken, die Einfügemarke wiederfinden. Pro unsicherem Wort. Das ist der Grund,
warum Transkriptions-Software seit jeher ein Fusspedal hat — die Hände sollen den Text nicht verlassen.

**Ziel:** Wiedergabe steuern, ohne die Tastatur zu verlassen.

**Nicht-Ziele (YAGNI):** Tempo-Regelung, konfigurierbare Tastenbelegung, Fusspedal-Unterstützung,
Durchlauf-Modus über Segmentgrenzen, Wort-genaues Anspringen. Alles nachrüstbar, keines heute belegt.

## 2 · Die Belegung

| Taste | Wirkung | im Textfeld | ausserhalb |
|---|---|---|---|
| `Ctrl+Space` | Play/Pause | ✓ | ✓ |
| `Ctrl+←` | 2 s zurück | ✗ | ✓ |
| `Ctrl+→` | 2 s vor | ✗ | ✓ |

**`Ctrl+Space` gilt für beide Zustände**, bewusst. Die naheliegende Alternative — blosse Leertaste
ausserhalb des Textfelds, `Ctrl+Space` darin — wurde verworfen: sie kostet eine Fokus-Prüfung und
erzeugt die Frage „warum geht das hier nicht", sobald der Fokus einmal woanders steht als vermutet.
Die blosse Leertaste tippt also immer ein Leerzeichen, überall.

`Ctrl+←/→` dagegen wirken **nur ausserhalb** eines Textfelds: dort ist die Kombination auf Windows
und Linux bereits der wortweise Cursorsprung — das Standard-Werkzeug beim Korrigieren von Text, und
Korrigieren von Text ist, wofür dieses Programm gebaut ist. Hier war die Fokus-Prüfung nicht zu
vermeiden, die bei `Ctrl+Space` bewusst entfällt: die Pfeile sind im Textfeld bereits vergeben,
Play/Pause nicht (Review Important 2).

**Bekannte Grenzen:** Auf macOS ist der Wortsprung `Alt+←/→`, `Ctrl+←/→` daher unbetroffen —
schaltet dort aber stattdessen zwischen Schreibtischen (Mission Control), und `Cmd+Space` ist
Spotlight und erreicht die Seite gar nicht. Auf einem Mac werden die Kürzel damit teilweise nicht
ankommen. Das wird als `ponytail:`-Kommentar im Code vermerkt und **nicht** durch eine
konfigurierbare Belegung gelöst: die Mac-Seite ist laut Issue #36 noch nie gestartet worden, eine
Einstellungsfläche für einen ungetesteten Nutzer wäre Vorbau. Upgrade-Pfad, falls es je jemanden
stört: Belegung aus einer Konstante lesen und in den Einstellungen überschreibbar machen.

## 3 · Semantik von Play/Pause

`Ctrl+Space` bezieht sich auf **das Segment unter dem Cursor** — dasselbe, was der ▶ daneben täte.

```
Cursor in Segment 47, nichts läuft
  Ctrl+Space  → spielt 47 (mit dem üblichen Polster aus playWindow), stoppt am Ende
  Ctrl+Space  → Pause
  Ctrl+Space  → weiter, stoppt weiterhin am Ende von 47
  Ctrl+→      → 2 s vor, auch über das Ende von 47 hinaus
  Ctrl+Space  → läuft von dort weiter, ohne Segmentgrenze
```

Wird gerade nichts bearbeitet, gilt das zuletzt hervorgehobene Segment (`activeId`). Gibt es auch das
nicht, spielt/pausiert der Player schlicht an seiner aktuellen Position.

### 3.1 Warum das Fortsetzen kein `playPause()` sein darf

wavesurfer setzt die Endgrenze eines Fensters als `stopAtPosition` und **löscht sie im
`pause`-Handler** (`wavesurfer.js` Z. 143) sowie in `setTime()` (Z. 325). Ein Fortsetzen per
`playPause()` liefe darum über das Segmentende hinaus — die Grenze ist zu diesem Zeitpunkt weg.

Fortgesetzt wird deshalb mit `play(undefined, to)`: kein `setTime` (die Position bleibt, wo sie war),
aber die Grenze wird neu scharf gestellt. Dafür merkt sich `Waveform` das zuletzt gespielte Fenster
`{from, to}` in einem Ref.

Dass `setTime()` die Grenze ebenfalls löscht, ist für `skip` genau richtig und wird nicht umgangen:
wer 2 s vorspult, will hörbar über die Segmentgrenze hinaus.

## 4 · Aufteilung

### 4.1 `playback.ts` — die Entscheidung, ohne Browser

Die vier Fälle sind das einzig Verzwickte an der Sache. Sie wandern als reine Funktion neben
`playWindow`, damit sie ohne wavesurfer und ohne DOM prüfbar sind:

```ts
type Aktion =
  | { art: 'pause' }
  | { art: 'weiter'; to?: number }        // play(undefined, to) — Position bleibt
  | { art: 'fenster'; from: number; to: number }  // play(from, to) — neues Segment

naechsteAktion(zustand: {
  laeuft: boolean
  fenster: { from: number; to: number; segId: number | null } | null
  zeit: number
  segment: Segment | null
  dauer: number
}): Aktion
```

Regeln, in dieser Reihenfolge:

1. `laeuft` → `pause`
2. `segment` gesetzt **und** `segment.id !== fenster?.segId` → `fenster`
   (ein anderes Segment als das zuletzt gespielte, also dorthin springen)
3. `fenster` gesetzt und `zeit` liegt in `[from, to)` → `weiter` **mit** `to` (Grenze neu setzen)
4. sonst → `weiter` ohne `to` (Fenster vergessen, blank weiterspielen)

Verglichen wird die **Segment-ID**, nicht das Zeitfenster: `playWindow` liefert Fliesskommazahlen,
und ein Gleichheitstest darauf wäre eine Wanze, die erst bei irgendeinem krummen Zeitstempel zubeisst.
`playTurn` merkt sich `segId: null` — nach einem Redebeitrag führt jedes Segment unter dem Cursor
also über Regel 2, was stimmt: der Beitrag ist gespielt, gemeint ist jetzt das einzelne Segment.

Fall 2 vor Fall 3 ist der Unterschied zwischen „ich will diese Stelle nochmal" und „ich will da
weitermachen, wo ich war". Fall 4 fängt das Vorspulen aus dem Fenster heraus ab — ohne ihn hielte
`Ctrl+Space` nach einem `Ctrl+→` sofort wieder an, weil die Position bereits hinter `to` läge.

### 4.2 `Waveform.tsx` — führt aus, hält den wavesurfer-Zustand

`WaveHandle` wächst um zwei Methoden:

```ts
type WaveHandle = {
  playSegment: (s: Segment) => void      // unverändert
  playTurn: (s: Segment[]) => void       // unverändert
  toggle: (seg?: Segment | null) => void // neu
  skip: (sekunden: number) => void       // neu
}
```

`toggle` fragt `naechsteAktion` und führt aus; `playSegment`/`playTurn` schreiben zusätzlich das
Fenster-Ref. `skip` ist `setTime(clamp(getCurrentTime() + s, 0, getDuration()))`.

Die Entscheidung liegt bewusst **im Player, nicht in `EditorView`**: dort liegt schon, was sie
braucht (läuft es, wo steht es, welches Fenster zuletzt). `EditorView` sagt nur, *welches* Segment
gemeint ist.

### 4.3 `EditorView.tsx` — welches Segment gemeint ist

Ein `keydown`-Listener am `window` (`useEffect`, aufgeräumt beim Unmount). Er reagiert nur bei
`e.ctrlKey` auf `' '`, `'ArrowLeft'`, `'ArrowRight'` und ruft dann `e.preventDefault()`.

Das gemeinte Segment kommt aus dem DOM:

```ts
document.activeElement?.closest('[data-seg-id]')   // beim Tippen: die Textarea steckt darin
```

Fällt das aus, gilt `activeId`. Kein neuer State, keine neuen Props: `data-seg-id` rendert
`SegmentView.tsx:35` bereits, und `Transcript.tsx:22` fragt es auf demselben Weg ab (Auto-Scroll) —
das Muster existiert in diesem Code also schon und wird nicht neu erfunden.

### 4.4 Auffindbarkeit

Der `title` des Segment-▶ wird zu `"Abspielen (Ctrl+Space)"` (`SegmentView.tsx:36`). Keine neue
Legende, keine neue Fläche — ein Kürzel, das man nur in einer Hilfeseite findet, ist keines.

**Nur dort.** Der ▶ am Redebeitrag (`SpeakerTurn.tsx:43`, „Redebeitrag abspielen") bleibt unangetastet:
er spielt den ganzen Beitrag, `Ctrl+Space` das einzelne Segment. Dasselbe Kürzel an eine andere
Wirkung zu schreiben wäre schlechter als gar kein Hinweis. Das `aria-label` bleibt ebenfalls, wie es
ist — der zugängliche Name eines Knopfes ist nicht der Ort für eine Tastenkombination.

## 5 · Tests

`webtool/frontend/src/lib/playback.test.ts` — deckt `naechsteAktion` ab:

| Fall | Erwartung |
|---|---|
| läuft | `pause` |
| Stille, Segment gewählt | `fenster` mit dem Polster aus `playWindow` |
| Stille, Position im gemerkten Fenster, kein neues Segment | `weiter` **mit** `to` |
| Stille, Position hinter dem Fenster (nach `skip`) | `weiter` **ohne** `to` |
| Stille, kein Fenster, kein Segment | `weiter` ohne `to` |
| Segment gewählt, das vom gemerkten Fenster abweicht | `fenster` (nicht `weiter`) |

Der wavesurfer-Klebstoff in `Waveform.tsx` bleibt bewusst ungetestet — er ist nach der Extraktion
geradeaus und bräuchte eine Audio-Attrappe, die mehr Wartung kostet als sie fängt.

Bestehende Suiten müssen grün bleiben: `npm --prefix webtool/frontend test` (129 Tests).
`SegmentView.test.tsx`/`SpeakerTurn.test.tsx` prüfen ggf. den `title`-Text — dann mitziehen.

## 6 · Risiken

| Risiko | Umgang |
|---|---|
| `Ctrl+Space` ist auf manchen Linux-Desktops der Eingabemethoden-Umschalter | In Kauf genommen; die Wellenform bleibt klickbar, der ▶ auch |
| Ein `keydown` am `window` feuert auch in Dialogen (Sprecher-Combobox, Projekt löschen) | `Ctrl`-Kombination kollidiert dort mit nichts; Dialoge tippen keine Kürzel |
| Fenster-Ref und wavesurfer laufen auseinander (z. B. nach Dateiwechsel) | `url`-Wechsel setzt das Ref zurück; im Zweifel Fall 4 = einfach weiterspielen, kein Absturz |
