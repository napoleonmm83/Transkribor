# yt-dlp-Selbstaktualisierung im URL-Import — Design

**Datum:** 2026-08-13 · **Status:** gebaut · **Bezug:** #162 (behoben, PR #169), #170, #171

> **Nachtrag beim Bau.** Zwei Dinge kamen gegenueber diesem Entwurf dazu, beide auf Marcus'
> Entscheidung: (1) **Selbstheilung** — bricht ein Download so ab, wie es ein veralteter
> Extraktor tut, wird sofort aktualisiert und einmal neu versucht, statt auf den 14-Tage-Takt
> zu warten (`fetch._extraktor_verdacht`, Positivliste; Login-/Privat-Fehler sind
> ausgeschlossen, hoechstens ein pip pro Lauf). Dazu noetig: `fetch._neu_laden()` raeumt
> `sys.modules`, weil yt-dlp an dieser Stelle bereits importiert ist. (2) **Anzeige** unter
> *Einstellungen › Video-Import*: installierte Fassung, Pruefdatum, Haken `ytdlp_auto` und ein
> Knopf „Jetzt aktualisieren" (`POST /api/settings/ytdlp/update`, synchron im Request).
> Der Rest des Entwurfs steht unveraendert; die Logik liegt in `webtool/ytdlp_update.py`
> statt in `fetch.py` (drei Konsumenten).

## 1. Das Problem

`pip install -r requirements.txt` laeuft in der installierten App **genau einmal** — beim
ersten Start. `electron/setup.js:venvVollstaendig()` prueft danach nur noch

```js
import torch, faster_whisper, fastapi, uvicorn
```

Ist das gruen, laeuft `einrichten()` nie wieder. Ein App-Update ersetzt die `.exe`, nicht die
venv (die liegt in `userData` und ueberlebt bewusst). **yt-dlp friert damit auf dem
Installationstag ein** — bei genau der Abhaengigkeit, die kaputtgehen *muss*: ihre Extraktoren
laufen YouTube und Instagram hinterher.

Belege, dass das kein hypothetisches Problem ist:

- **#162** (2026-08-13): YouTube antwortete mit 403, weil yt-dlp eine JS-Laufzeit braucht.
- CLAUDE.md fuehrt seit Monaten `pip install -U yt-dlp` als „den ueblichen Fix" fuer
  Instagram — der Mechanismus von heute ist also: der Nutzer oeffnet eine Konsole.
- Der in PR #169 eingezogene Boden `yt-dlp>=2026.7.4` schuetzt **nur Neuinstallationen**.
  Renovate haelt nur das Repo aktuell. Fuer eine bestehende Installation tut beides nichts.

## 2. Der Mechanismus

Der Import-Job ist ein eigener Subprozess (`python -m webtool.fetch --download-only …`).
Dort, **vor** dem ersten Zugriff auf yt-dlp:

1. **Fassung ohne Import lesen** — `importlib.metadata.version("yt-dlp")` liest die
   Metadaten von der Platte und laedt das Paket *nicht*.
2. **Faellig?** Fassung aelter als 14 Tage **und** letzte Pruefung laenger als 14 Tage her
   → `pip install -U yt-dlp` als Subprozess, Ausgabe geht ins Job-Log.
3. **Danach erst** `import yt_dlp`.

**Schritt 3 ist der Kern.** Heute steht `import yt_dlp` am Modulkopf — das Modul laege also
im Speicher, bevor pip die Dateien auf der Platte austauscht, und die Aktualisierung wirkte
erst beim naechsten Lauf. Ein **fauler Import** loest das ohne Neustart, ohne `importlib.reload`
und ohne zweiten Prozess. Nebeneffekt: der Server importiert yt-dlp gar nicht mehr (aus
`fetch.py` braucht `app.py` nur `check_url`).

Die Versionsnummer **ist** ein Datum (`2026.7.4`) — die Faelligkeit braucht also keine
PyPI-Abfrage.

## 3. Entscheidungen

**Kein neuer Job-Typ.** Naheliegend waere ein Update-Job, der per `then=` den Import anhaengt.
Das gaebe ein zweites `kind` mit Label in `_KIND_TEXT`, `jobPhases.ts` und der Fusszeile — fuer
zehn Sekunden Hintergrundarbeit. Im Job zu bleiben kostet nur den faulen Import.

**Nicht im Server, sondern im Job.** Im Endpunkt liefe pip *im HTTP-Request*: der Browser
hinge zehn Sekunden am Klick. Im Job landet die Ausgabe dort, wo der Nutzer ohnehin hinschaut.

**Best effort, niemals blockierend.** Scheitert pip (offline, PyPI zickt), wird das
protokolliert und der Import laeuft mit der vorhandenen Fassung weiter. `--retries 1
--timeout 10` plus 120 s Subprozess-Deckel. Ein Update-Fehlschlag darf kein Import-Fehlschlag
werden — sonst waere ein Rechner ohne Netz schlechter dran als vor diesem Feature.

**Der Merker ist noetig, nicht Zierde.** yt-dlp veroeffentlicht stabil etwa monatlich. Allein
an der Fassung gemessen waere sie nach 14 Tagen *dauerhaft* faellig, und **jeder** Import liefe
in ein pip, das nichts aendert. Der Merker (`ytdlp_geprueft`, ISO-Datum) liegt in
`settings.json` im Nutzerprofil: der einzige Ort, der auch in der gepackten App beschreibbar
ist (neben der `.exe` darf nichts geschrieben werden), und er bringt den atomaren Schreibpfad
schon mit. Er wird **auch nach einem Fehlschlag** gesetzt — sonst liefe der naechste Import in
denselben Timeout.

**Abschaltbar per `TRANSKRIBOR_YTDLP_UPDATE=0`**, wie `TRANSKRIBOR_VERIFY` und
`TRANSKRIBOR_AUTOCORRECT`. Wer seine venv selbst verwaltet, will keinen Automatismus darin.

**Nur yt-dlp, nichts sonst.** Ein `pip install -U` ueber alle requirements erwischt irgendwann
torch — und die GPU waere still weg (dieselbe Falle wie beim CPU-Rad in `setup.js`).

**14 Tage**, weil zwei Groessen zusammenpassen muessen: yt-dlp veroeffentlicht stabil etwa
monatlich (kuerzer bringt selten etwas Neues), und ein kaputter Extraktor soll nicht monatelang
kaputt bleiben. Ein Wert, den man aendern darf — er steht als eine Konstante an einer Stelle.

## 4. Grenzen

- **#171 bleibt offen:** eine JS-Laufzeit installiert pip nicht. Ein aktuelles yt-dlp ohne
  Laufzeit bleibt ein aktuelles yt-dlp ohne Laufzeit.
- **#170** (`yt-dlp-ejs`) faellt ab, sobald es entschieden ist: dann heisst der Befehl
  `pip install -U yt-dlp yt-dlp-ejs` — ein Wort mehr, kein neuer Mechanismus.
- Wer `download_one` aus fremdem Code aufruft, bekommt keine Aktualisierung: sie haengt an
  `main()`. Das ist Absicht — eine Bibliotheksfunktion, die pip startet, waere eine
  Ueberraschung.
- Ein Rechner, der beim faelligen Lauf offline war, wartet bis zu 14 Tage auf den naechsten
  Versuch. Der Preis fuer den Merker; ein kuerzerer Wiederholabstand nach Fehlschlag waere
  eine zweite Zahl mit eigenem Ausfallmodus.
