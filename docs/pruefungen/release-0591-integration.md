# Lokaler Integrationsstand fuer v0.59.1

Stand: 2026-10-14. Branch: release/0591-integration. Grundlage: v0.59.0, ad70a675b8a8ae7e4950a354b46f5e9cffc2035b. Dieser Bericht beschreibt einen lokalen Kandidaten; die Paketversion bleibt 0.59.0.

## Umfang

- Langclip-Optimierung: 23f60b0 nach 6da2543 uebernommen. Gespeicherte Aufnahmen verwenden serverseitige Peaks und native Bereichsabrufe; Vorbereitungsfortschritt wird sichtbar.
- Release-Vorpruefung: 77126f5 nach 3c226e7 uebernommen. README-Platzhalter und fehlende oder unpassende Push-Testurteile stoppen den Versionswechsel.
- Integration dfa9d89: neue Protokollmarke correction-stage reserviert; Kontext-Mutationsanker nachgezogen; beim Rohtranskript-Austausch alte aktive Vorbereitungsarbeit, Bloecke und Cursor bereinigt. Kein neues Erfolgs-/Skipurteil fuer die ausgetauschte Quelle.
- Korrektur 7a8bbc9: Numerische NBSP/NNBSP-Darstellungen werden ebenfalls normalisiert. Der Vertragsreview entdeckte den Bypass trotz gruener urspruenglicher Suite; neue Release-/Tag-Regressionen waren zuerst rot.

## Lokale Nachweise

| Pruefung | Ergebnis |
| --- | --- |
| Python, python -m pytest -q -rs | 2217 bestanden, 4 plattformbedingt uebersprungen, 1 Renovate-Netztest abgewählt am 7a8bbc9-Stand |
| Vitest | 1083 bestanden |
| Frontend Build, lint:ci und Lint-Selbsttests | Exit 0 |
| Chromium-Bestandssuite | 12 bestanden |
| Electron-Suite | Exit 0 |
| Bash-Vertraege versionshoehe, notizen, fassung, macos-mindest, release-vorabpruefung | Exit 0, einschliesslich numerischer Nachlauf |
| Ruff-/Mypy-Baselinegates | Exit 0; bestehende Baselines nicht geaendert |
| Kontext-Mutationen | 14/14 getoetet, Positivkontrolle gruen |
| Status-Mutation | 1/1 getoetet, 6 rote Regressionen, Positivkontrolle gruen |

Echte lokale Streaming-Probe mit synthetischer WAV-Datei: Wellenformantwort 200, native Audioantwort und expliziter Range-Abruf 206, Wiedergabezeit steigt, kein decodeAudioData-Aufruf, keine Browserfehler, Quelldatei hashgleich. Das prueft die gespeicherte Aufnahme; lokale Blob-Wiedergabe bleibt von den Komponentenregressionen abgedeckt.

## Review und Grenzen

Sechs Audit-Ebenen und unabhängige Plan-, Diff- und Vertragsprüfungen wurden eingesetzt. Die Logikprüfung fand den behobenen Statusabschluss; die Vertragsprüfung fand die numerischen geschützten Leerzeichen. Zwei kalte Diffarme schlossen nach vollständiger Lektüre aller 31 geänderten Dateien und gezielten eigenen Laufzeitproben mit CLEAN, ohne offene Prüfpunkte. Der numerische Delta wurde separat geprüft. Der Vertragsarm bestätigte mit 47 Workflowtests und zusätzlicher Release-/Tag-Matrix den behobenen Blocker. Sein eigener Bashsuite-Aufruf wurde vom lokalen Namens-Gate blockiert; Root und Diffarm A führten dieselbe Bashsuite regulär erfolgreich aus. Diese Grenze des Vertragsarms bleibt in dessen Bericht sichtbar. Ausführliche lokale Protokolle liegen im ignorierten Aufgabenordner .code-guardian-evidence/2026-10-14--release-0591-integration/.

Geprueft auf Windows mit Python 3.13.16, Node 22.23.2 und Git Bash; dies ersetzt nicht die CI-Matrix mit Node 24 und macOS/Linux. Der echte Renovate-Netzlauf wurde nicht gestartet. Die allgemeine UI-Zustandsprobe meldete bestehende Fokus-, Kontrast-, Zielgroessen-/Abstands-Befunde und Unbekannte; eine vollstaendige Accessibilityfreigabe wird daraus nicht abgeleitet. Reflow bei 320 px war erfolgreich.

Die README-Pruefung normalisiert gueltige semikolonterminierte numerische Leerzeichenreferenzen. HTML-Tags, Linkrendering und Browser-Fehlerkorrektur fuer ungueltige semikolonlose Referenzen sind ausserhalb dieses Syntaxvertrags; der Vertragsreview hat diese Grenze mit dem echten Workflow-Harness nachgewiesen.

## Naechster Release-Schritt

Nach ausdruecklichem Auftrag: Branch pushen und PR ueber die in CLAUDE.md geregelte Review-Kette erstellen lassen; den exakten integrierten Commit in der CI-Matrix pruefen. Erst danach Version, Tag und Release erzeugen. Dieser Lauf hat keinen Push, PR, Tag oder Release ausgefuehrt.

## Ablauf-Erkenntnisse

Mutationen und normale Tests benoetigen getrennte Arbeitsbaeume: ein versehentlich gemeinsamer Lauf wurde abgebrochen, die exakt erkannte eigene Mutation zurueckgenommen und die gesamte Python-Suite sauber wiederholt. Die isolierte Mutationszelle blieb anschliessend sauber. Normale Shellstarts scheiterten an setup refresh; gepruefte Eskalationen funktionierten. Vorhandene Dependency-Installationen wurden ueber Junctions wiederverwendet.

Der Sitzungs-Rückblick trennt erwartete rote Regressionen von tatsächlicher Reibung. Die maskierten Beobachtungen wurden im zentralen Journal abgelegt. Empfehlungen: Mutationen stets isolieren, absolute Startpfade/Scopes und vollständige Dependency-Ziele vorab prüfen, Status-Fixture-Wache sofort mitführen. Globale Runner-/Gateänderungen gehören nicht zu diesem Integrationsauftrag.
