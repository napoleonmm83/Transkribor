# Autosave-Härtung — vier Issues, vier PRs

**Stand:** 2026-08-11, master `652e4f2`. Vier offene Autosave-Issues, alle im Pfad
`useDoc.ts` + `TextEditor.tsx` — demselben Pfad, an dem PR #116 vier Datenverlust-Achsen
nacheinander fand und schloss. Die Lehre aus #116 bestimmt Reihenfolge und Aufteilung:
kleinste, isolierbarste Fixes zuerst; jeder PR einzeln prüfbar; voller Review-Zyklus pro PR.

## Issues und Reihenfolge

| PR | Issue | Schwere | Risiko neu? |
|----|-------|---------|-------------|
| 1 | #118 Feld-Verwurf ohne Hinweis | Hoch | Ja (neu durch #116) |
| 2 | #107 Kein Retry nach Fehlschlag | Mittel | Nein (Lücke) |
| 3 | #117 Kette staut sich | Mittel | Nein (Effizienz) |
| 4 | #106 Rückfrage in 800-ms-Pause | Niedrig | Nein (UX) |

## #118 — Hinweis beim Verwerfen von Getipptem

**Problem:** `key={initial}` in `TextEditor` verwirft den lokalen Feldinhalt still, wenn
`reload()` das Dokument tauscht (fertige Korrektur trifft ein). Weder `onCommit` noch
`onCancel` feuern; der Nutzer tippt bruchlos im ersetzten Text weiter.

**Lösung:** `TextEditor` trackt lokal (Ref beim `change`), ob der Feldinhalt vom Ausgangswert
abwich. Der `useEffect`-Cleanup beim Unmount (= Key-Wechsel) feuert eine neue optionale Prop
`onVerworfen` — **nur** wenn verändert **und** weder `onCommit` noch `onCancel` in diesem
Render- Zyklus griffen. Der Parent reicht `onVerworfen` an `useDoc` weiter; `useDoc` zeigt
`toast.info` („korrigierte Fassung geladen, dein nicht übernommener Text wurde ersetzt").

**Heikelste Stelle:** Cleanup läuft auch beim echten Commit/Cancel-Unmount. `onVerworfen`
darf **nur** feuern beim Key-Wechsel-mit-Veränderung. Tests decken alle vier Pfade:
(1) unverändert → weder toast noch Verwurf, (2) commit → onCommit, kein Verwurf,
(3) cancel → onCancel, kein Verwurf, (4) key-Wechsel mit Veränderung → onVerworfen.

## #107 — Begrenztes Retry nach Fehlschlag

**Problem:** Ein misslungener `save` bleibt beim einen Versuch. Erst der nächste Tastendruck
rettet. Häufigster Fall: Serverneustart während der Arbeit.

**Lösung:** Separater Retry-Effekt in `useDoc`, der bei `stand === 'fehler'` nach Backoff
(2 s, 4 s, 8 s) erneut speichert, max. 3 Versuche. Finaler Fehlschlag → bestehender
`toast.error`. `dirty` bleibt oben bis Erfolg oder Aufgeben.

**Heikelste Stelle:** Retry muss **je Dokument** gelten (gleicher `offen`-Ref-Trick wie #116)
— sonst retried ein Lauf für Datei A, während B offen ist. Bestehender Test
„kein Nachtreten in Schleife" wird zum „begrenzt Nachtreten, dann Schluss".

## #117 — Überholte Kette-Läufe fallen lassen

**Problem:** Bei langsamen Server staut sich `kette`; 5 Tipppausen → 5 Läufe, 4 veraltet.
Kein Datenverlust (neuester Lauf schreibt zuletzt), aber „minutenlang speichert" für den
Nutzer und ein Schwanz Schreibvorgänge, die jedes Mal `render_md` auslösen, für den Server.

**Lösung:** `neuester`-Zähler je Dokument; beim Start eines wartenden Laufs prüfen: ist er
noch der neueste für *dieses* Dokument? Wenn nicht, überspringt er `saveDoc`.

**Heikelste Stellen (zwei):**
1. Zähler **je Dokument** via `offen`-Key. Globaler Zähler: A-Lauf von B-Lauf übersprungen,
   A nie geschrieben.
2. Bestehende #116-Tests müssen grün bleiben, speziell „dirty oben beim Weiter_tippen_während
   _Lauf" (verlangt, dass der zweite Lauf mit „zwei" wirklich läuft). Die Unterscheidung
   „wartet, weil einer läuft" vs. „übersprungen, weil ein neuerer wartet" muss sauber trennen.

## #106 — Flush statt Rückfrage in der Pause

**Problem:** Wer in der 800-ms-Pause die Datei wechselt, bekommt eine irreführende
„Verwerfen?"-Rückfrage — die Oberfläche hatte eine Sekunde vorher „wird gespeichert" versprochen.

**Lösung:** `useEffect`-Cleanup in `useDoc` spült bei `dirty` noch einmal synchron. Die drei
Rückfragen (`AppShell`, `DateiMenue` ×2, `ProjektUmbenennen`) prüfen künftig
`stand === 'fehler'` statt `dirty` — außer wo ein Server-Prozess über dieselbe Datei läuft
(dort bleibt `dirty` nötig, weil der Flush im Browser den Server-Prozess nicht einholt).

**Heikelste Stelle:** `dirty`-Semantik ändert sich an 4 Stellen. Bewusst geparkt, weil der
Umbau groß ist. Geht zuletzt, isoliert.

## Review-Prozess (pro PR, verbindlich)

TDD (rot → fix → grün) → `systematic-debugging` für root cause → Implementation →
`requesting-code-review` (Reviewer-Subagent mit Angriffspunkten, da CodeRabbit rate-limited
ist) → `receiving-code-review` (technisch prüfen, nicht blind umsetzen) →
`verification-before-completion` (Tests + `npm run typecheck` + `npm run build`) → PR →
CI prüfen → rebase-merge → Issue schließt automatisch.

Besonders bei #117 und #106: vor dem Review die Angriffspunkte aufschreiben (welchen neuen
Weg zum selben Schaden öffnet dieser Fix?), wie es #116 geholfen hat.
