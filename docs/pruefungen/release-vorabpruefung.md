# Vorabpruefung der Freigabe

`scripts/release-vorabpruefung.sh` prueft zwei Voraussetzungen, bevor der
Freigabe-Job Version, Release-Notizen und Tag schreibt:

- `readme [README.md]`: Kein Hinweis auf die „nächsten Fassung“ bzw.
  „naechsten Fassung“, auch bei Grossschreibung, ohne End-n und ohne Artikel.
  Die Pruefung arbeitet unter
  `LC_ALL=C`, beruecksichtigt Zeilenumbrueche, Markdown-Zitate/Hervorhebung
  durch Sternchen, Unterstriche und Backticks sowie geschuetzte Leerzeichen
  U+00A0/U+202F (literal, &nbsp; fuer U+00A0 oder numerisch dezimal/hex).
  Numerische Referenzen muessen mit einem Semikolon enden.
  Fuehrende Nullen und Hex-Grossschreibung werden ebenfalls beruecksichtigt.
  Die Pruefung rendert kein allgemeines HTML oder Markdown; beispielsweise
  HTML-Tags, Linktexte und HTML-Fehlerkorrektur (etwa fehlende Semikolons)
  werden nicht aufgeloest. Sie unterscheidet keinen
  Treffer von einem Lesefehler.
- `lauf <vollstaendige Commit-SHA> <Branch>`: Der neueste Push-Lauf von
  `test.yml` fuer genau diesen Commit und Branch muss `completed/success`
  melden. Fehlende, laufende, abgebrochene oder rote Laeufe sowie API-Fehler
  stoppen die Freigabe mit einer Diagnose.

Ein erfolgreicher aelterer Lauf wird nicht mittels `--status success`
ausgewaehlt. Commit, Branch und Ereignis werden nach der Abfrage erneut
geprueft: die komplette Antwort muss einschliesslich ihrer Spalten exakt
passen. `GH_TOKEN` kommt im Workflow aus `github.token`; der version-Job
erhaelt `actions: read` zusaetzlich zu seinem bisherigen Schreibrecht.

Der Testbau braucht keine Liveabfrage. Bei manuellen Tags wird die README
geprueft; ein vorausgehendes Push-Testurteil ist dort nicht vorgeschrieben,
weil der Tag auch den neu erzeugten Versionscommit enthalten kann. Der
Tagweg ist deshalb kein Ersatz fuer die gepruefte manuelle Freigabe.

## Lokal pruefen

```bash
bash scripts/release-vorabpruefung.sh readme
bash scripts/release-vorabpruefung.test.sh
python -m pytest scripts/test_release_vorabpruefung.py -q
```

Die Bash-Suite prueft reale Dateien und simulierte gh-Antworten ohne Netz
oder Token. Der Python-Harness fuehrt den echten `version`-Planblock aus
dem Workflow mit der GitHub-Bash-Aufrufform aus. `npm` und `git` sind dabei
Mocks: negative Voraussetzungen duerfen weder `npm version` noch `git push`
erreichen; ein erfolgreicher Fall erreicht beide in der richtigen Reihenfolge.
Der neue Skripttest laeuft auch in den vorhandenen Test- und Release-Matrizen.

Die alten Todo-Verweise auf Release-Kommandos in Projekt-/globaler
`CLAUDE.md` sind am untersuchten Stand ueberholt: keine Projektdatei ist
versioniert, die globale Datei enthaelt keinen solchen Ausdruck. Das
obenstehende Kommando ersetzt den ungeprueften grep-Handgriff.

Diese Abnahme ist lokal. Sie startet keine GitHub-Workflows und
veroeffentlicht keinen Tag oder Release. Die macOS-/Linux-Ausfuehrung des
neuen Tests wird nach Integration von den vorhandenen Matrizen nachgeholt.

CLI-Vertrag: [gh run list](https://cli.github.com/manual/gh_run_list).
Tokenrechte: [GitHub Actions permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions).
