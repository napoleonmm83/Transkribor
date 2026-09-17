# Issue-Bündelung nach PR #624

Stand: 17.09.2026 · Basis: `master` auf `a283f899c1ecbb610d4e9f0946d6197e2b135671`

## Gemessener Bestand

`gh issue list --state open --limit 100` liefert 26 offene Issues. `gh pr list --state open --limit 100` liefert einen offenen PR: Renovate #621. PR #624 ist mit allen beobachteten Prüfungen grün gemergt; der Merge-Commit ist `a283f899`.

Jedes offene Issue steht in genau einer Primär-Disposition:

| Disposition | Issues | Begründung |
| --- | --- | --- |
| **Nächstes Bündel: Browser-Registrierung und Editor-Reflow** | #613, #616 | Gemeinsame Playwright-Konfiguration, Browser-Fixture, Reflow-Messung und Mutationsprobe. |
| **Durch PR #624 geliefert; Issue-Abschluss nach Mergebeleg** | #615, #618 | PR #624 schützt die zusätzlichen Editor-Ausgänge und verhindert das Wiederanlegen eines gelöschten Projekts. |
| **Einzelarbeit: Prompt-Vertrag** | #619 | Benötigt eine Produktentscheidung über den Workflow-Pfad und gehört nicht in einen Layout-/Browser-Konfigurationsdiff. |
| **Einzelarbeit: Mutationstreiber** | #622 | Betrifft Interpreter-Weitergabe im Python-Werkzeug und hat keinen gemeinsamen Ausführungspfad mit dem Frontend-Bündel. |
| **Bündel C2: Fehlerberichte** | #530, #519, #520 | Gemeinsamer Fehlerbericht-, Transport- und Drosselungspfad. |
| **Mac-Paketfenster** | #36, #504, #512 | Benötigt gebaute macOS-Pakete beziehungsweise Apple-Silicon-Messungen. |
| **Sperrprotokoll** | #210, #237 | Gemeinsame Halter-, Herzschlag- und Netzfreigabe-Semantik. |
| **Sprachkette** | #136, #137, #164 | Messung, Glossarauswahl und Segmentmetadaten bauen fachlich aufeinander auf. |
| **Diarisierung nach Lizenzentscheidung** | #274, #276 | CC-BY-NC ist seit 22.08.2026 akzeptiert; die Messung wartet auf den Referenzsatz aus Task 8. |
| **Einzelarbeit** | #553, #509, #469, #346, #288, #95, #45 | Je ein eigenständiger Vertrag ohne tragfähigen gemeinsamen Änderungspfad zum nächsten Bündel. |

Kontrollsumme: 2 + 2 + 1 + 1 + 3 + 3 + 2 + 3 + 2 + 7 = **26**.

## Änderung zum Plan vom 10.09.2026

Fakt: Die neuen Issues #613, #615, #616, #618, #619 und #622 sind seit dem Vorgängerzensus hinzugekommen; erledigte Vorgängerissues sind nicht mehr offen. Fakt: Das frühere Bündel D ist geliefert, und #615/#618 sind mit PR #624 umgesetzt. Fakt: Renovate #621 ist der einzige offene PR.

Herleitung: #613 und #616 bilden das nächste Bündel, weil beide in derselben Browser-Sitzung überprüfbar sind und dieselben Konfigurations-, Fixture- und Mutationspfade berühren. Der offene Renovate-PR verändert diese fachliche Reihenfolge nicht; er beansprucht lediglich denselben CI- und Review-Kanal.

## Reihenfolge

1. #613 beheben: vier Playwright-Wächter auf `.spec.ts` umstellen, Playwright und Vitest eindeutig trennen und die überholten Marker entfernen.
2. #616 auf derselben Browser-Fixture testgetrieben beheben: 900-px-Fehlerzustand mit aktiver Suche rot belegen und die Toolbar umbrechen lassen. Herleitung und freigegebene Entscheidung: `flex-wrap` erhält im Gegensatz zu gekürzten Beschriftungen die vollständigen Exportnamen; die Wirkung wird mutiert.
3. Das Bündel vollständig prüfen, reviewen und als PR mit `Fixes #613` und `Fixes #616` abschließen.
4. #615 und #618 mit dem vorhandenen Mergebeleg schließen.
