# Vertragsprüfung: Mutationsvorlauf

Trace: `2026-09-23--t219-mutations-vorlauf`

## Vertrag

`scripts/mutation.py --nur-vorlauf` meldet nur dann Erfolg, wenn der getrackte
Arbeitsbaum im gewählten Pfad vor und nach dem Testlauf sauber ist, der Plan samt
Ankern und Zielpfaden gültig ist und ein direkter Pytest- oder npm-Testlauf
mindestens einen Test erfolgreich ausführt. Der Vorlauf verändert keine
Mutationsziele und leert keinen Bytecode-Cache. Bei fehlender Grundlage für ein
Urteil gibt er Exitcode 2 zurück. Der Wächter für committete Pläne prüft lokale
Pytest-Pfade und npm-Testskripte; eine CI-Ausnahme trägt einen nichtleeren Grund.

## Ausgeführte Gegenproben

- Ein grüner echter Pytest-Lauf und der echte Frontend-Plan
  `statuspille_durch.json` bestanden mit Exitcode 0; die Zieldatei blieb
  unverändert.
- Ein schmutziger Baum vor beziehungsweise nach dem Lauf und ein Lauf ohne
  gesammelte Tests brachen mit Exitcode 2 ab.
- `python -c "print('1 passed')"`, ein npm-Skript mit `echo 1 passed`, eine
  Shell-Verkettung und ein Zeilenumbruch im Testkommando wurden abgewiesen.
- Der unabhängige Kaltreview führte zusätzlich eine Shell-Substitution in
  einer Pytest-Option und eine Windows-Verkettung hinter einfachen Quotes aus;
  die direkte Kommando-Prüfung weist diese Zeichenformen ab.

## Urteil und Grenze

`CONTRACT REVIEW: PASS — 0 offene Befunde.` Ein npm-Skript wird nur als Testlauf
anerkannt, wenn es direkt `vitest run` oder `playwright test` startet. Die
Testdateien und diese Läufer selbst bleiben Teil der vertrauenswürdigen
Projektumgebung. Prüfbelege und der volle Mutationslauf liegen im Aufgabenordner
`.code-guardian-evidence/2026-09-23--t219-mutations-vorlauf/`.
