# Textsuche im Editor

**Stand:** 2026-08-11, master `b11895c`. Issue #125.

## Problem

Ein Interview-Transkript ist schnell mehrere tausend Wörter lang (hunderte Segmente). Die
Stelle, „wo hat er genau X gesagt?", ist ohne Suche nur durch Lesen oder Scrollen zu finden —
obwohl der Editor sonst schon gut navigiert (Tastenkürzel, Player-Kopplung, Sprecher-Label).
Eine Suche gibt es bisher nicht.

## Lösung (Marcus' Wahl: Filter, nicht Browser-Find)

Ein **sichtbares Suchfeld** oben in der Werkzeugleiste des Editors — **kein** Tastatur-Shortcut.
Der Nutzer tippt einen Begriff ein, daraufhin grauen alle Segmente ohne Treffer aus
(`opacity-40`); die Treffer bleiben in voller Farbe und fallen so sofort ins Auge. `▲` `▼`
neben dem Feld springen von Treffer zu Treffer, ein Zähler zeigt `3 / 17`, und der aktive
Treffer bekommt einen gelben Rahmen + scrollt ins Bild. Feld leeren → alles sieht wieder
normal aus.

**Warum Filter statt Browser-Find (Wort-Markierung):** Wort-genaues Highlight (`<mark>` pro
Treffer) greift in die Unsicherheits-Tokenisierung unkorrigierter Segmente ein (deren
farbige Wort-Spans) — machbar, bringt aber einen zusätzlichen Farblayer in den Text. Die Filter-Variante
kommt **ohne neue Farbe im Text** aus: die Treffer sind schlicht „die nicht ausgegrauten",
nur der *aktive* Treffer trägt einen gelben Rahmen. Das ist die schlankere Lösung und hat
keine Reibung mit den bestehenden Farben (Indigo = Playback/aktiv, Amber/Rot = unsichere
Wörter, kühle oklch = Sprecher).

**Bewusst NICHT gebaut** (Marcus: „ein Suchfeld, keine tastatur-getriggerte Such-Option"):
kein `Strg+F` / `Cmd+F` / `F3`, kein `Enter`/`Esc`-Öffnen, kein Ein-/Ausblend-Zustand. Das
Feld ist immer da. Such-Öffnen per Tastatur liesse sich später als Einzeiler nachreichen
(focus auf das Eingabefeld), bewusst weggelassen.

## Architektur

### Zustand (in `EditorView.tsx`)

`EditorView` besitzt die Such-State, weil dort schon die Tastaturbelegung und `activeId`
(Wiedergabe-Position) leben — die Suche ist deren Geschwister, kein fremder Eigentümer:

- `suchQuery: string` — aktueller Suchtext.
- `suchIndex: number` — Index des aktiven Treffers in der Treffer-Liste.

Abgeleitet:
- `treffer = useSuche(doc?.segments, suchQuery)` → `{ ids: number[], count }`.
- `suchAktivId = treffer.ids[suchIndex] ?? null` — die Segment-ID des aktiven Treffers.
- `trefferSet = useMemo(() => new Set(treffer.ids), [treffer.ids])` — für konstantes
  `has()` je Segment beim Ausgrauen.

**Index-Pflege:**
- Bei jedem Wechsel von `suchQuery` → `suchIndex` auf `0` zurücksetzen (ein `useEffect` auf
  `suchQuery`; erste Suche startet am ersten Treffer).
- `▲`/`▼` clampen `suchIndex` auf `[0, count)`; bei `count === 0` sind sie deaktiviert.
- Bei Dateiwechsel (`base` ändert) → `suchQuery = ''` (ein anderes Transkript, alte Treffer
  sind hinfällig; ein Effekt auf `base`).

### `useSuche(segments, query)` (neu, `hooks/useSuche.ts`)

Reiner Hook, nur `useMemo` — keine eigene State, keine Effekte. Die State liegt im
`EditorView`; der Hook beantwortet nur *eine* Frage: welche Segmente matchen, in welcher
Reihenfolge?

```ts
export function useSuche(segments: Segment[] | undefined, query: string): {
  ids: number[]   // Segmente mit Treffer, in Dokumentreihenfolge
  count: number
}
```

- `query.trim() === ''` → `{ ids: [], count: 0 }` (kein Ausgrauen, keine Treffer).
- Sonst: case-insensitive Substring-Suche (`text.toLowerCase().includes(q)`) auf dem
  **angezeigten** Text je Segment:
  - korrigiert (`isCorrected(seg)`) → `seg.text`,
  - unkorrigiert → `seg.raw_text` (Klartext, nicht die Token-Spans).
- Reihenfolge = `segments`-Reihenfolge (Dokumentreihenfolge).

**Warum der angezeigte Text und nicht immer `raw_text`:** der Nutzer sucht, was er *sieht*.
Bei korrigierten Segmenten steht im `text` die bereinigte Fassung; wer „Wiesental" sucht, hat
die korrigierte Schreibweise vor Augen, nicht die vom ASR gehörte. Bei unkorrigierten ist der
Klartext (`raw_text`) genau das, was die Token-Spans zusammen ergeben.

### `Suchfeld` (neu, `components/Suchfeld.tsx`)

Das UI-Element, gerendert **in der Werkzeugleiste** (`Toolbar`), nicht schwebend:

```
[ 🔍 Suche: Aras          ]  3 / 17  ▲ ▽  ✕
```

- Ein kontrolliertes `<input>` (typ search), Placeholder „Im Transkript suchen …".
- rechts daneben, **nur wenn `query !== ''`**: der Zähler (`index+1 / count` bzw.
  „keine Treffer" bei `count === 0`), `▲` `▽` (deaktiviert bei `count === 0`), `✕`
  (leert das Feld → `onChange('')`).
- keine eigene Tastatur-Logik (kein `Enter`/`Esc`/`F3`).

Die Schaltflächen sind sichtbar statt getastet — der Nutzer muss kein Kürzel kennen.

### `Toolbar.tsx`

Bekommt neue Props und rendert `<Suchfeld …/>` links neben den Export-Knöpfen:

```ts
suchQuery: string
onSuchChange: (v: string) => void
suchCount: number
suchIndex: number
onSuchPrev: () => void
onSuchNext: () => void
```

Die bestehenden Props (`stand`, `bereit`, `onExport`) bleiben unangetastet.

### Datenfluss bis ans Segment

`activeId` (Playback) fließt heute `EditorView → Transcript → SpeakerTurn → SegmentView`
und tut dort zwei Dinge: Highlight (`active`) **und** Scroll (Effekt in `Transcript`). Die
Suche braucht dieselbe Form — Highlight + Scroll —, darf aber `activeId` **nicht**
kapern (Playback und Suche sind unabhängig; ein Such-Sprung darf die Wiedergabe-Position
nicht verstellen und umgekehrt). Also ein **parallel gepaarter Pfad** mit denselben zwei
Aufgaben:

- `EditorView → Transcript`: zusätzlich `trefferSet: Set<number>` und `suchAktivId: number | null`.
- `Transcript → SpeakerTurn`: beide durchgereicht (wie `activeId`).
- `SpeakerTurn → SegmentView`: daraus `suchTreffer = trefferSet.has(seg.id)` und
  `suchAktiv = suchAktivId === seg.id` (genau die Form des bestehenden `active`).

### Ausgrauen + aktiver Ring (`SegmentView.tsx`)

Am Wurzel-`<div data-seg-id>` — drei Zustände, nur relevant wenn `suchQuery !== ''`:

| Segment | Klasse |
|---|---|
| kein Treffer | `opacity-40` (ausgegraut) |
| Treffer, nicht aktiv | keine Extra-Klasse (volle Farbe — sticht gegen Grau heraus) |
| aktiver Treffer | `ring-2 ring-inset ring-yellow-400 dark:ring-yellow-500` |

Bei leerer `suchQuery` bekommt kein Segment eine dieser Klassen — die Editor-Ansicht ist
unverändert. Der gelbe Rahmen **nur am aktiven Treffer** (Marcus' Vorgabe: Rahmen, keine
zusätzliche Hinterlegung).

**Keine Kollision mit anderen Farben:** Yellow sitzt als *Rahmen* am Segment, nicht im Text;
die unsicheren Wörter (Amber/Rot) liegen *im* Text, die Sprecherfarbe als *linker Balken*.
Indigo (Playback-aktiv) bleibt unangetastet — ein Segment kann gleichzeitig Playback-aktiv
und Such-Treffer sein; beide Hinterlegungen/Rahmen bestehen nebeneinander.

### Scroll (aktiver Treffer)

`Transcript` hat heute einen `useEffect([activeId])`, der das aktive Segment in den Radix-
Viewport holt. Die Scroll-Mathematik wird in eine Hilfsfunktion
`scrollSegInView(ref: RefObject<HTMLDivElement>, segId: number)` gezogen (DRY — identische
Logik für Playback und Suche). Ein **zweiter** `useEffect([suchAktivId])` ruft dieselbe
Hilfsfunktion auf. Zwei unabhängige Effekte, je eigener Trigger → keine Race zur Wiedergabe,
keine Regression im bestehenden Verhalten (das ist der Punkt, an dem man `activeId` falsch
mitverwendet und die Wiedergabe beim Suchen springt — explizit vermieden).

## Eingrenzungen / bewusst weggelassen

- **Kontext, Zusammenfassung, Anmerkungen** werden **nicht** durchsucht und **nicht**
  ausgegraut — die Suche konzentriert sich auf das Transkript (Marcus' Vorgabe). Die drei
  Felder sind klein und ohnehin vollständig sichtbar.
- **Keine Wort-Markierung** (`<mark>`) im Text — Filter-Modell (s.o.).
- **Keine Tastatur-Shortcuts** (`Strg+F`/`F3`/`Enter`/`Esc`) — sichtbares Feld statt
  Shortcut (Marcus' Vorgabe).
- **Kein Suchen & Ersetzen** — nur lesen. (Issue nennt nur Suche.)
- **Keine Diakriten-Normalisierung** („ue" findet nicht „ü") — v1 case-insensitive
  Substring. Bei Bedarf später via `.normalize('NFD').replace(/\p{Diacritic}/gu, '')`.
- **Keine持久ung der Suche** über Dateiwechsel: `suchQuery` wird bei `base`-Wechsel
  zurückgesetzt.

## Touchpoints

| Datei | Änderung |
|---|---|
| `hooks/useSuche.ts` | neu — Match-Logik (reiner `useMemo`-Hook) |
| `hooks/useSuche.test.ts` | neu — siehe Tests |
| `components/Suchfeld.tsx` | neu — Eingabefeld + Zähler + `▲▽✕` |
| `components/Toolbar.tsx` | rendert `<Suchfeld/>`, neue Props |
| `pages/EditorView.tsx` | `suchQuery`/`suchIndex`-State, `useSuche`, Reset-Effekte, durchgereicht |
| `components/Transcript.tsx` | `trefferSet`/`suchAktivId` durch, `scrollSegInView` extrahiert, 2. Effekt |
| `components/SpeakerTurn.tsx` | `trefferSet`/`suchAktivId` durchgereicht |
| `components/SegmentView.tsx` | Ausgrauen + aktiver Ring |
| `components/Toolbar.test.tsx` / `EditorView.test.tsx` | neu/erweitert — siehe Tests |

## Tests

`useSuche.test.ts`:
- case-insensitive (`aras` findet `Aras`).
- korrigiertes Segment wird in `seg.text` gesucht, unkorrigiertes in `seg.raw_text`.
- leeres/whitespace-Query → `{ ids: [], count: 0 }`.
- Treffer-Reihenfolge = `segments`-Reihenfolge.
- kein Partial-False: Substring muss wirklich enthalten sein.

Komponenten-Tests (jsdom):
- Tippen in `Suchfeld` → Nicht-Treffer-Segment erhält `opacity-40`, Treffer nicht.
- Zähler zeigt `1 / N` nach Eingabe, „keine Treffer" bei 0; `▲`/`▽` vor/rück, deaktiviert
  bei 0.
- aktiver Treffer trägt die `ring-yellow-*`-Klasse (nur einer).
- `✕` bzw. leeres Feld → keine `opacity-40`-Klasse mehr irgendwo.
- `base`-Wechsel leert das Feld (Reset-Effekt).
- `activeId` (Playback) wird von der Suche nicht berührt (Regression: Such-Sprung ändert
  nicht die Wiedergabe-Position-Anzeige).

Scroll-into-view ist in jsdom nicht realistisch (kein Layout); der Test stellt stattdessen
sicher, dass `suchAktivId` korrekt bis `Transcript` durchgereicht wird — die Scroll-Logik
selbst ist durch den extrahierten Helper und den bestehenden `activeId`-Effekt gedeckelt.

## Offen

- **Diakriten-Normalisierung** („ue"↔„ü") — bei Schweizer Transkripten relevant; bewusst für
  v1 weggelassen, Issue-würdig wenn sich der Bedarf zeigt.
- **Treffer in Kontext/Zusammenfassung** — falls jemand die Header-Felder mitdurchsuchen
  will, ist der Pfad über `useSuche` leicht um die Felder zu erweitern; bewusst nicht jetzt.
