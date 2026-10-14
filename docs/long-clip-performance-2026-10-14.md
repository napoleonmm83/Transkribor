# Lange Clips: Status und Oberfläche

Stand: 2026-10-14. Arbeitsbasis: origin/master, Commit ad70a67 (0.59.0). Umsetzung im Branch fix/long-clip-performance-20261014.

## Referenz und Isolation

Das installierte Projekt **KI verstehen** wurde vollständig in die isolierte Analyseablage .tmp-long-clip/projekte kopiert. Die Aufnahme Aufzeichnung enthält 5055 Segmente und 23026 Wörter bei einer Audio-Metadaten-Dauer von 8764.248 Sekunden. Der letzte Segmentendwert 8763 ist keine Audiodauer. JSON-Zählung und unabhängige Python-Zählung stimmen überein; die Dauer wurde zusätzlich mit PyAV am MP3 geprüft. Originaldateien wurden durch die Arbeit nicht verändert.

Der lokale Testserver lief auf 8194, der eigene Vite-Server auf 5195. Nach dem App-Import wurde die tatsächlich wirksame Projektwurzel geprüft; Einstellungen und .env waren ebenfalls isoliert. Ein GET der Wellenform änderte laut Dateifingerprints keine Projektdateien und erzeugte keine Sidecars.

## Ursachen und Änderungen

1. **Unklare Korrekturvorbereitung.** Kontextanalyse und lokale Zweiterkennung meldeten bislang nur nicht ausgewertete Textzeilen. Der tatsächliche Parser zeigte dadurch weiter Glossar oder Transkription an. Neue JSON-Ereignisse benennen Kontext, lokalen Slot, Modellladen, Audiovorbereitung und Ausschnitterkennung vor den blockierenden Aufrufen. Nur die tatsächlich abgearbeiteten Ausschnitte bekommen einen Prozentwert; andere Phasen bleiben unbestimmt.
2. **Erneuter Aufbau unveränderter Segmente.** Der Wiedergabe-Marker und eine einzelne Bearbeitung renderten alle Segmentbedienelemente erneut. Memo-Grenzen für Redebeiträge und Segmentzeilen, stabile Wiedergabeaktionen und inhaltlich stabile Sprecheroptionen begrenzen den Aufbau auf betroffene Zeilen. Verborgene Rohwortansichten korrigierter Segmente werden erst beim Öffnen erzeugt.
3. **Vollständige Audiodatei im Browser.** WaveSurfer lud die lange Datei als Blob und dekodierte sie komplett. Ein lesender Endpunkt erzeugt nun höchstens 2000 Peak-Werte aus einzelnen Decoderframes. Der Player erhält diese Werte vor dem Laden und verwendet native HTTP-Range-Wiedergabe. Ein kleiner LRU-Cache hält nur die kompakten Ergebnisse, erkennt Dateiersatz und blockiert warme Ergebnisse nicht hinter einer anderen kalten Berechnung. Lokale Blob-Vorschauen bleiben erhalten.

## Gegenprüfung und korrigierte Randfälle

Die unabhängigen Prüfungen fanden zusätzliche Randfälle, die vor Abschluss behoben wurden:

- Nach erfolgreicher Transkription und wegen Handarbeit übersprungener Korrektur bleibt der Erfolg in der Abschlussbilanz erhalten. Die laufende Vorbereitungsanzeige verdeckt den Erfolg vorübergehend; ein Identitätswechsel unter gleichem Namen übernimmt ihn nicht.
- AAC/ADTS kann die Dauer stark unter- oder überschätzen. Der Decoder misst den tatsächlichen Umfang und berechnet bei relevanter Abweichung die Peaks in einer zweiten, ebenfalls speicherbegrenzten Passage. Reale variable AAC-Fixtures prüfen Impulsstärke und Position. Die hier geprüfte lange MP3-Datei benötigte keine zweite Passage; daraus folgt keine Zusicherung für andere MP3-Dateien.
- Beschädigte OGG-Dateien können eine eigene FFmpeg-Ausnahme erzeugen. Der Endpunkt liefert dafür eine verständliche 422-Antwort statt eines internen Serverfehlers.
- Die Audiotests benötigen den bereits in requirements.txt erklärten PyAV-Decoder auch in der schlanken Python-Testumgebung. Die gemeinsame dev-Gruppe übernimmt dessen bestehenden Versionsbereich; die Tests werden nicht übersprungen.

## Messung

Die Rendererprobe nutzt dieselbe vollständige Kopie im lokalen Chromium und misst einen einzelnen Markerwechsel bis nach zwei Animationsframes.

| Messgröße | Vorher | Nachher |
| --- | ---: | ---: |
| Markerwechsel | 1072.9 ms | 36.8 ms |
| Segmente im DOM | 5055 | 5055 |
| DOM-Elemente | 99198 | 99198 |
| JS-Heap in diesem Lauf | 286 MB | 286 MB |

Dies ist eine lokale Einzelvergleichsmessung, keine Produktionslatenz-Verteilung. Der vollständige Dokument-DOM bleibt erhalten; eine allgemeine Heap-Reduktion wird nicht behauptet. Komponentenregressionen belegen unabhängig, dass ein Markerwechsel nur neue/bisher aktive Zeilen erneut aufbaut.

Die lange MP3 benötigte mehrfach etwa 6.5 Sekunden für die kalte Peak-Berechnung; ein warmer Abruf benötigt keine erneute Dekodierung. Der Decoder verarbeitet einzelne Frames und hält höchstens 2000 Peak-Werte vor. Daraus wird ein begrenzter eigener Datenbestand hergeleitet; ein zusätzlicher nativer RAM-Verbrauch wird hier mangels dokumentiertem Messwert und reproduzierbarem Messbefehl nicht als gemessen ausgewiesen. Eine allgemeine harte RAM-Garantie für alle Decoderformate ist damit nicht belegt.

Im vollständigen App-Browserlauf: weit entfernter Suchtreffer sichtbar; Wiedergabesprung zur zugehörigen Zeitmarke; HTTP 206 für Audio; **kein Aufruf von decodeAudioData**, keine Browserfehler.

## Prüfung und Grenzen

- Vollständige Frontend-Regression, TypeScript, Oxlint und Produktionsbuild.
- Korrektur-, Kontext-, Audio- und Pipeline-Regressionssuite sowie neue Wellenformtests; Ruff-/Mypy-Baselines ohne neue Befunde.
- Sechs Audit-Ebenen und zusätzlicher kalter ausführender/lesender Review.
- Die Zustandsprobe prüfte Hover, Fokus, Aktivzustände und schmale Fenster. Sie ist keine vollständige Barrierefreiheitsfreigabe: bestehende kleine Klickziele und Fokus-/Kontrastbefunde wurden gemeldet; Teile blieben unbekannt. Die bisherigen Button-Geometrien und Farben wurden für diese Performanceänderung nicht umgestaltet. Reflow bei 320 Pixeln bestand.
- Keine kostenpflichtige komplette KI-Neukorrektur der zweistündigen Aufnahme. Die Prozessstatuskette wurde mit tatsächlichen Erzeugerereignissen und Regressionen geprüft; die bestehende Erkennungs-/Korrekturlogik blieb erhalten.
- Die lokale Datei-Blob-Vorschau dekodiert weiterhin im Browser. Das neue Streaming gilt für gespeicherte Aufnahmen.

Eine erprobte CSS-Abkürzung für unsichtbare Zeilen wurde verworfen, weil sie weite Suchsprünge verschob. Die endgültige Verbesserung nutzt die ursprünglichen Layout- und Scrollanker.
