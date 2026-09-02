# Release-Notizen

**Eine Zeile je Änderung, in der Sprache der Nutzerin.** Was sie davon hat, nicht was im Code
passiert ist — „Auf Touch-Geräten sind die ⋯-Menüs wieder sichtbar", nicht „opacity-Klasse für
`any-pointer:coarse` ergänzt". Ein Satz reicht; wer zwei braucht, hat wahrscheinlich zwei
Änderungen.

Sie gehört unter `## Unveröffentlicht`, in **einen** der drei Blöcke — `**Neu**`, `**Behoben**`,
`**Sicherheit**` —, und zwar im selben PR wie die Änderung. Beim nächsten Release über den
Workflow wandert der ganze Abschnitt automatisch unter die neue Versionsnummer und landet als
Release-Text auf GitHub; `## Unveröffentlicht` bleibt leer zurück. (Ein von Hand gesetzter Tag
ist der Sonderweg: er veröffentlicht diese Zeilen, rotiert sie aber nicht — sie kommen beim
nächsten regulären Release also noch einmal mit.) Interne Umbauten, Testarbeit und
Abhängigkeits-Updates brauchen keine Zeile — dort ändert sich für niemanden etwas.

Scheitert ein Release-Lauf nach dem Rotieren, ist nichts verloren: das nächste Release hängt
die Abschnitte an, zu denen es kein veröffentlichtes Release gibt (ein liegengebliebener
Entwurf zählt als keines).

**Keine `##`-Überschriften innerhalb eines Abschnitts** — jede beginnt einen neuen. Alles
dahinter bliebe beim Rotieren als heimatloser Abschnitt in dieser Datei zurück und käme in
kein Release. Fettzeilen (`**Neu**`) sind genau dafür da.

Steht beim Freigeben nichts hier, veröffentlicht der Workflow ersatzweise die Commit-Titel
seit der letzten Fassung — dieselbe Auswahl, die auch die Versionsnummer hebt (`feat`, `fix`,
`perf` und alles mit `!` bzw. `BREAKING CHANGE`) — und schreibt dazu, dass eine Notiz gefehlt
hat. Lesbar, aber unschön — das ist Absicht.

## Unveröffentlicht

**Neu**
- Wartende Aufnahmen sagen jetzt, worauf sie warten und wie viele noch davor liegen — statt nur „In Warteschlange“.

**Behoben**
- Bricht ein Löschen mittendrin ab, bleibt kein unsichtbarer Rest mehr für immer liegen — Transkribor gibt den Platz beim Start wieder frei, sobald der Rest etwa zehn Minuten alt ist.
- Ein zu langer Name beim Umbenennen meldet jetzt „Name zu lang“ statt eines Serverfehlers.
- Der Fortschrittsbalken einer gestückelten Korrektur bleibt am Ende nicht mehr eine Stufe zu niedrig stehen.
- Eine Aufnahme, deren Handarbeit geschützt wurde, heisst nicht mehr „Übersprungen" — das las sich, als sei sie liegen geblieben.
- Die Meldung beim Löschen einer laufenden Aufnahme spricht nicht mehr von „Transkription", wenn gerade korrigiert wird.

## v0.50.2 — 2026-09-01

**Behoben**
- Aufnahmen bleiben nicht mehr versehentlich bis zum Ende eines Auftrags gesperrt (Löschen wurde immer wieder mit „läuft gerade“ abgewiesen), wenn der Fortschrittsbalken oder ein Fehler die interne Buchhaltung durcheinanderbringt.
- Projektnamen, die wie Protokoll-Schlagwörter aussehen (zum Beispiel „active"), und Namen mit eckigen Klammern werden abgelehnt — sie verstellten vorher Fortschrittsanzeige und Dateisperren. Ein altes Projekt mit so einem Namen bleibt nur lesbar, bis es einmal umbenannt ist.
- Der „Korrigieren"-Knopf einer einzelnen Aufnahme wird abgewiesen, solange dieselbe Aufnahme gerade von einem laufenden Auftrag geschrieben wird — statt daneben her zu korrigieren.
- Der projektweite „Alles korrigieren"-Knopf wird abgewiesen, solange eine laufende Transkription die Aufnahmen selbst korrigiert — statt dass zwei Korrekturläufe dieselben Dateien schreiben.
- Löschst du eine wartende Aufnahme und lädst sofort eine gleichnamige neu hoch, während ein Lauf läuft, gilt sie wieder als Teil des Laufs — Umbenennen und Neu-Transkribieren warten dann korrekt, statt der laufenden Verarbeitung in die Quere zu kommen.
- Eine Aufnahme, die während eines laufenden Projektlaufs fertig wird, zeigt sofort ihren richtigen Stand, statt bis zu vier Sekunden lang „Nur Audio — noch nicht transkribiert“ zu behaupten.
- Eine während eines Laufs gelöschte und gleichnamig neu hochgeladene Aufnahme zeigt ihren echten Stand statt „Fertig“ oder „Fehler“ aus dem Lauf der gelöschten Datei — auch dann, wenn der Lauf sie erst Minuten später erneut erreicht.

## v0.50.1 — 2026-08-30

**Behoben**
- Eine während eines laufenden Projektlaufs hinzugefügte Aufnahme zeigt jetzt ihren Fortschritt, statt bis zum Ende des Laufs auf dem Wartesymbol zu stehen — auch bei sehr langen Läufen mit vielen Aufnahmen, und scheitert sie, sagt die Abschlussmeldung das jetzt ebenfalls.
- Lässt du mehrere Aufnahmen auf einmal korrigieren, bleibt keine mehr fälschlich als „in Arbeit“ stehen — sie zeigt wieder ihren richtigen Stand und lässt sich auch wieder löschen. Läuft gleichzeitig eine Transkription, kann es noch vorkommen.
- Lädst du weitere Aufnahmen hoch, während schon eine Transkription läuft, stehen sie als „In Warteschlange“ in der Liste, sobald die gerade laufende Aufnahme fertig ist — statt bis zu ihrem eigenen Beginn wie unbearbeitetes Audio auszusehen.

## v0.50.0 — 2026-08-28

**Neu**
- Die Release-Seite sagt jetzt, was sich in der Fassung geändert hat, statt nur den Hinweis zu Gatekeeper und SmartScreen zu zeigen.

**Behoben**
- Eine einzelne, sehr lange Protokollzeile leert den Fehlerbericht nicht mehr — sie wird gekürzt und als gekürzt markiert.
- Löschen, Umbenennen oder Neu-Transkribieren einer Aufnahme, die gerade bearbeitet wird, meldet „wird gerade bearbeitet — bitte warten" statt eines Fehlers und lässt die Aufnahme nie halb zurück.

## v0.49.1 — 2026-08-28

**Neu**
- Fehlerbericht direkt aus der App (unter *Version*): vorbereitete E-Mail mit Protokollauszug, Vorschau vor dem Senden.
- Startseite zeigt bis zu acht Projekte als Karten mit Fortschritt.

**Behoben**
- Auf Touch-Geräten sind die `⋯`-Menüs und die Sprecherauswahl wieder sichtbar.
- Das Schliesskreuz bleibt in gescrollten Dialogen oben.
- Die Anzeige während eines Laufs zeigt die Korrekturphasen wieder; ein Totalausfall der Korrektur endet rot statt „fertig".
- Eine während eines Laufs hinzugefügte Aufnahme geht bei Fehlschlag oder Abbruch nicht mehr verloren.
- Löschen einer Aufnahme in Bearbeitung meldet „bitte warten" statt einen Fehler mit halb gelöschter Aufnahme.

**Sicherheit (Desktop-App)**
- Links aus Transkripten öffnen nur noch normale Web-Adressen; das Fenster kann nicht mehr auf fremde Seiten umgelenkt werden.

`v0.49.0` ist nur eine Markierung ohne Download — inhaltlich gleich.
