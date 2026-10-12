# T-067: Zeilendeckel im reinen Korrekturlauf

Stand: 2026-10-12. Ausgangsrevision: `ad70a675b8a8ae7e4950a354b46f5e9cffc2035b`.

Der reine `correct`-Lauf erreicht den echten Job-Zeilendeckel. Danach kann
die Wartekarte eine bereits korrigierte Aufnahme erneut als wartend führen.
Außerdem kann `ausgang()` einen Teilerfolg als Erfolg melden, wenn die frühe
Fehlerzeile verdrängt wurde. Diese Abnahme ist kein Produktfix.

## Reproduktion

Vom Repo-Stamm mit der vorhandenen Python-Umgebung und Node.js ausführen:

```powershell
python tools/probe_correct_log_cap.py --files 4 --output .tmp-t067-klein
python tools/probe_correct_log_cap.py --files 2000 --output .tmp-t067-gross
```

Verifiziert mit Python aus der lokalen `.venv` und Node.js v22.23.2.
Node muss `--experimental-strip-types` unterstützen. Keine zusätzlichen
Frontend-Abhängigkeiten werden benötigt.

Die Probe erzeugt einen neuen Unterordner je Lauf. Dort bleiben synthetische
Projekte, `stdout.txt`, `running.json`, `final.json` und `result.json` erhalten.
Sie verwendet keine Kundenaufnahmen und ruft keinen KI-Anbieter auf.

## Messvertrag und Isolation

- Echte Erzeuger: `correct.cmd_run`, korpusweites `_glossary`, `prep_single`,
  `correct_ai_single` und `cmd_apply` mit geschriebenen Editor-Dateien.
- Die vorhandene `_ask_llm`-Grenze liefert lokale synthetische Antworten.
  Dort wird ein früher Fehler ausgelöst und der letzte Aufruf angehalten.
  `_recording_evidence` ist wie in der bestehenden `test_correct.py`-Fixture
  ersetzt; Diarisierung und Verify sind ausgeschaltet. Parallelität ist eins.
- Echte Transportstrecke: Subprozess → `jobs.start` → stdout-Reader →
  `fuege_zeile_an` mit unverändertem `MAX_JOB_LINES` → `jobs.get`.
- Ungekappter stdout wird separat mitgeschrieben. Dieselben unveränderten
  `parseJobPhases`, `warteKarte`, `schonDurch` und `ausgang` lesen das
  vollständige Protokoll und den tatsächlichen Server-Schnappschuss.
- Der letzte KI-Aufruf wartet mit Frist. Der laufende Schnappschuss wird erst
  aufgenommen, wenn seine Korrektur-Startzeile den Reader erreicht hat.
  Freigabe erfolgt im inneren `finally`; der gesamte weitere Job-Lebenszyklus
  einschließlich terminalem Warten liegt unter einem Cleanup.
- Auch der direkte interne `--child`-Einstieg verlangt das synthetische Manifest
  und setzt Projekt- und Settings-Pfade selbst. Geerbte Projektdaten werden
  nicht verwendet.
- Die Probe prüft Vollprotokoll-Kontrollen und tatsächliche Editor-Dateien
  explizit, auch mit `python -O`. Sie setzt keinen Bug im gekappten Zweig
  voraus; dessen abweichende Zustände sind das Messergebnis.

## Ergebnis

| Korpus | Laufender stdout | Job-Puffer | Frühe Kontrollen |
| --- | ---: | ---: | --- |
| klein | 39 Zeilen | 39 Zeilen | Erfolg und Fehler erhalten |
| erster großer Versuch | 11.999 Zeilen | 10.000 Zeilen | Noch erhalten; Glossarzeilen verdrängt |
| erweiterter Versuch | 19.999 Zeilen | 10.000 Zeilen | Erfolg und Fehler verdrängt |

Im erweiterten laufenden Versuch:

| Kontrolle | Vollprotokoll | Server-Puffer | Platte |
| --- | --- | --- | --- |
| `S0000` | `done`, `erreicht=edit`, kein Warten | kein Urteil, `warten={art:correct, vor:0}` | Editor-Datei vorhanden |
| `S0001` | `failed`, kein Warten | kein Urteil, `warten={art:correct, vor:1}` | Keine Editor-Datei |
| `S1999` | `active.phase=correct` | `active.phase=correct` erhalten | Noch keine Editor-Datei |

`schonDurch(..., 'correct', ...)` ist erwartungsgemäß falsch. Die monotone
`gesehen`-Menge kann fehlende Terminalurteile hier nicht ersetzen: sie wird
bereits durch die korpusweiten Glossar-Marken gefüllt.

Nach Freigabe ist der Job `done` mit Exitcode null. Das Vollprotokoll liefert
`ausgang={art:teil, misslungen:[S0001], versucht:2000}`. Derselbe Parser auf
dem Server-Puffer liefert `ausgang={art:erfolg}`. Im kleinen Kontrolllauf
bleibt der Teilerfolg auf beiden Wegen erhalten.

Die Zeilenzahlen wurden zusätzlich direkt aus den Original-Artefakten
unabhängig von `result.json` nachgezählt; der Gegenprobe-Beleg liegt im
Aufgabenordner `2026-10-12--t067-correct-zeilendeckel`.

## Grenze und Folgeschritt

Keine Browser- oder React-Rendering-Abnahme, keine Häufigkeitsmessung in
Kundenprojekten und kein Verhaltenstest echter KI- oder GPU-Anbieter.
Der Nachweis betrifft Erzeuger, Transport und den unveränderten Frontend-
Anzeigezustand. Die vorhandenen Produktdateien wurden nicht geändert.

T-067s Messfrage ist beantwortet. T-069 bleibt offen: Die Toast-Folge ist nun
reproduziert, aber ein veröffentlichter Issue-Nachweis gehört zu dessen
Abschlusskriterium. Der vorhandene serverseitige Lösungsweg (#490) muss beim
späteren Produktfix die Terminalurteile, `erreicht` und Lösch-Unterdrückung
zusammen erhalten. `schonDurch` einfach für `correct` freizugeben wäre wegen
des korpusweiten Glossars kein ausreichender Fix.
