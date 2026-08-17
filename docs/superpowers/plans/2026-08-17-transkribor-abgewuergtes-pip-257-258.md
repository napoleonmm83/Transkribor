# #257 + #258: ein abgewürgtes pip darf yt-dlp nicht dauerhaft töten

> **Für agentische Arbeiter:** Umsetzung task-für-task, jede Aufgabe endet mit
> Test + Commit. Schritte tragen `- [ ]`.
>
> **Fassung 2** — nach zwei gegnerischen Prüfläufen gegen den Quelltext. Fassung 1 hatte
> drei Fehler, zwei davon in der Sorte, die dieses Repo als seine häufigste führt (eine
> Behauptung, die schärfer ist als der Code). Was sich geändert hat, steht unten unter
> „Was der Gegenlauf umgeworfen hat" — **wer nur den Code liest, hält Fassung 1 für
> gleichwertig; sie ist es nicht.**

**Ziel:** Ein `pip install -U yt-dlp[default]`, das mitten im Lauf abgewürgt wird
(Windows `taskkill /F /T`, POSIX `os.killpg(SIGKILL)`), lässt yt-dlp halb installiert
zurück — und heute ist die Selbstaktualisierung damit **dauerhaft** tot. Nach diesem Plan
holt der nächste Serverstart genau **einen** Reparaturlauf nach.

**Architektur:** Ein Merker auf der Platte, **an die venv gebunden** und **innerhalb der
pip-Sperre** gesetzt: unmittelbar vor `subprocess.run`, gelöscht unmittelbar danach. Er
überlebt damit **nur**, wenn der Prozess selbst stirbt — genau das ist #257/#258.
`faellig()` liest ihn und liefert True, solange er höchstens `INTERVALL_TAGE` alt ist.

**Tech-Stack:** Python 3.13, `webtool/ytdlp_update.py`, pytest. `webtool/sperre.py`,
`webtool/jobs.py`, `webtool/app.py`, `electron/backend.js` bleiben **unangetastet**.

**Spec:** GitHub-Issues [#257](https://github.com/napoleonmm83/Transkribor/issues/257) und
[#258](https://github.com/napoleonmm83/Transkribor/issues/258); Vorgeschichte in
`webtool/CLAUDE.md`, Abschnitt zu #224.

---

## Was der Gegenlauf umgeworfen hat

Beide Prüfläufe haben unabhängig voneinander dieselben drei Kernpunkte getroffen. Sie
stehen hier, weil sie die Entwurfsentscheidungen tragen — nicht als Chronik.

**1. Der Merker hing an der falschen Sache.** Fassung 1 legte ihn neben die
Einstellungsdatei (`settings.path() + ".ytdlp.abbruch"`). `settings.path()`
(`webtool/settings.py:77-85`) kennt **keinen** Zweig für die gepackte App — `electron/backend.js`
setzt `TRANSKRIBOR_SETTINGS` nicht (nachgeprüft), `webtool.ps1` auch nicht. Der Merker wäre
also **pro Einstellungsdatei** gewesen, der Schaden ist aber **pro venv** (`aktualisiere()`
ruft `[sys.executable, "-m", "pip", …]`, `ytdlp_update.py:590`). Folge, Schritt für Schritt:
die gepackte App bricht ihr pip ab → Marcus startet später den Entwicklerserver aus dem Repo →
derselbe `%APPDATA%`-Pfad ⇒ fällig ⇒ `pip install -U` gegen `E:\Git\Transkribor\.venv`, eine
von Hand verwaltete venv, die nie beschädigt war — **und dieser Lauf verbraucht den Merker**,
die kaputte App-venv bekommt ihre Reparatur nie. Beide Richtungen falsch. Dass sich diese zwei
Prozesse Sperre und Merker teilen, steht bereits als #254 im Repo.
⇒ **Der Merkername trägt jetzt eine Kennung von `sys.prefix`.**

**2. „Bedingungslos, und das ist kein Flag ohne Ende" war schlicht falsch.** Fassung 1 schrieb
das wörtlich in den Code. `_pip_merker_loeschen()` fängt aber `OSError` und macht weiter:
scheitert das Löschen dauerhaft, ist `faellig()` **für immer** True — ein Hintergrund-pip bei
jedem Serverstart, also genau die Klasse, gegen die dieses Modul an vier Stellen gebaut ist
(`ytdlp_update.py:386-390`, `:410-415`). **Gemessen** auf dieser Maschine (Windows, Python
3.13): eine Datei mit Read-only-Attribut am Merkerpfad ⇒ `os.remove` → `PermissionError
[WinError 5]` **und** `open(…,"w")` → `PermissionError`; ein Verzeichnis am Merkerpfad ⇒
dasselbe. Auf POSIX zählt das Verzeichnisrecht, auf Windows das Dateiattribut — ein
Backup-/Sync-Client oder ein `attrib +R` genügt.
⇒ **Der Merker trägt ein Datum, und das Datum wird GELESEN: älter als `INTERVALL_TAGE` ⇒
gilt nicht mehr.** (In Fassung 1 wurde ein Datum geschrieben und nie gelesen — eine
Behauptung über eine Prüfung, die nicht stattfindet.)

**3. Der Merker hatte keinen Eigentümer — und die Reihenfolge war aus einem falschen Grund
gewählt.** Fassung 1 setzte ihn **vor** `with sperre.datei(...)`, begründet mit der
#207-Rechnung (eine zweite Sperre im Abschnitt zwingt `_lock_stale()` nach oben). Diese
Rechnung gilt für ein `settings.save()` — **nicht für einen einfachen Dateischreibvorgang**.
Der Grund trug also nicht, und die Reihenfolge riss eine echte **Erkennungslücke** auf:
Prozess B setzt den Merker und wartet an der Sperre; A wird fertig und löscht **B's** Merker;
B's pip läuft danach und wird abgewürgt — es bleibt **kein** Merker zurück, der Schaden wird
nie erkannt. Zwei Aktualisierer gleichzeitig sind hier der Normalfall (Server + fetch-Subprozess,
seit #254 auch zwei Server).
⇒ **Setzen und Löschen liegen jetzt beide INNERHALB derselben Sperre**, um `subprocess.run`
herum. Damit gibt es keinen fremden Merker zu treffen, und ein Merker, der beim blossen
**Warten** auf die Sperre entstünde, existiert gar nicht mehr.

**4. Und daraus fällt eine ganze Fallunterscheidung weg.** Fassung 1 behandelte
`subprocess.TimeoutExpired` gesondert (Merker bleibt liegen) — mit einer Begründung, die für
`returncode != 0` obendrein **geraten** war. Das war die einzige Quelle eines Dauerlaufs, den
die Uhr nicht deckt: auf einer langsamen Leitung überschreitet pip die 120 s bei **jedem**
Start, und der Merker bliebe jedes Mal liegen. Weg damit — der Merker wird jetzt nach **jedem**
behandelten Ausgang gelöscht. Er überlebt damit **genau dann**, wenn der Prozess selbst stirbt.
Der Preis ist benannt und wird ein eigenes Issue: ein selbst verursachter Timeout **mitten in
der Installation** bleibt unerkannt — das ist heute genauso, also kein Rückschritt.

Nebenbefunde des Gegenlaufs, die in den Code bzw. die Doku wandern:

- **Die Begründung „ein DEFAULTS-Schlüssel schlägt in die API durch" war falsch** und ist
  gestrichen: `settings.public()` (`settings.py:213-222`) und `app._settings_body()`
  (`app.py:796`) haben feste Feldlisten, die Feldmengen-Tests (`test_api.py:605`, `:630`)
  blieben grün. Gegen `settings.json` sprechen die zwei **anderen** Gründe (venv-Bindung,
  `_lock_stale()`), und die tragen.
- **Die Folge einer Datei IM Lock-Verzeichnis war falsch benannt.** Nicht „das Lock bliebe für
  immer liegen": gemessen mit echtem `sperre.py` fällt `datei()` nach `frist(stale)` offen
  (`sperre.py:582-586`) — **220 s Wartezeit bei jedem Lauf und danach pip OHNE Sperre**, also
  zwei `pip install` in dieselbe venv. Schlimmer als „liegt herum", nicht harmloser.
- **`test_pip_sperre_deckt_die_VERSCHACHTELTE_wartezeit_mit`** (`test_ytdlp_update.py:1096`)
  rechnet seine Vergleichsgrösse aus **denselben** Konstanten wie `_lock_stale()` und kann eine
  Verletzung der #207-Regel deshalb nicht finden. Betrifft diesen Plan nicht direkt (wir nehmen
  keine zweite Sperre) — wird ein Issue.
- **PowerShell 5.1 verliert doppelte Anführungszeichen**, wenn ein Here-String an ein natives
  Kommando geht (`& $py -c @'…print("x")…'@` → `SyntaxError: print(x`, gemessen), und
  `Start-Process -ArgumentList` zerlegt ein Element mit Leerzeichen (`-c`,`import time; …` →
  python bekam `-c import`, gemessen). Die Messschritte laufen deshalb über **Skriptdateien**,
  nicht über `-c`.

---

## Warum dieser Weg

**Beide Issues nennen denselben dritten Weg als billigsten** („`faellig()` unterscheidet eine
kaputte Installation von einer fehlenden"), und #258 sagt ausdrücklich: „Der dritte Weg ist der
billigste und deckt #257 mit." Die beiden anderen fassen Prozessverwaltung an
(`CREATE_NEW_PROCESS_GROUP` + `CTRL_BREAK_EVENT`; SIGTERM-Gnadenfrist in `jobs.cancel_all()`)
und ändern damit das Abbruchverhalten **aller** Jobs — Transkription und Korrektur inklusive —
für einen Fall, der sich nach diesem Fix von selbst heilt.

**Der Merker misst das EREIGNIS, nicht die FORM.** Der naheliegende Entwurf wäre, den Schaden
auf der Platte wiederzuerkennen (`find_spec("yt_dlp")` findet Dateien, während `metadata.version`
wirft). Das rät über pips Innenleben: je nachdem, wo der Kill trifft, entsteht ein anderer
Zustand — Metadaten weg und Dateien da, Metadaten **da** und Dateien halb (dann sieht `fassung()`
gesund aus und keine Prüfung im `v is None`-Zweig greift), oder beides weg. „Wir haben ein pip
gestartet und nie beendet" ist dagegen eine Tatsache über uns und deckt alle drei ab, auch die,
die niemand aufgezählt hat.

**Was dieser Fix NICHT tut** (gehört in die Issue-Schlussnotiz, nicht unter den Tisch): Das
Abwürgen selbst bleibt. `taskkill /F /T` reisst weiterhin pip mit, `jobs.cancel_all()` schickt
weiterhin SIGKILL. Was wegfällt, ist die **Dauerhaftigkeit** — aus „ohne Neueinrichtung nicht
mehr zu retten" wird „ein Hintergrundlauf beim nächsten Start".

## Globale Rahmenbedingungen

- **Sprache:** Kommentare und Docstrings deutsch, im Ton des Moduls — was nicht aus dem Diff zu
  lesen ist, steht als Begründung dabei.
- **Dieses Modul darf NIRGENDS werfen** (#185): `fetch._hole_yt_dlp()` und `app._lifespan` haben
  keinen Schutz. Jede neue Funktion fängt ihre `OSError` selbst.
- **Kein echtes pip im Test.** Die `isoliert`-Fixture (`test_ytdlp_update.py:28-41`) setzt
  `TRANSKRIBOR_SETTINGS` in `tmp_path` und verdrahtet `subprocess.run` auf `pytest.fail`; der
  Merkerpfad hängt über `_lockziel()` daran und ist mit-isoliert (vom Gegenlauf bestätigt, ebenso
  dass **kein** anderes Testfile `faellig`/`beim_start`/`aktualisiere` unisoliert erreicht).
- **Jeder Test wird mutationsgeprüft**, mit **eindeutigem Anker** — die Mutationstabellen unten
  nennen ihn wörtlich, weil `except OSError as e:` und `return True` in dieser Datei mehrfach
  vorkommen.
- **Nach jeder Mutationsserie** `find webtool -name __pycache__ -type d -exec rm -rf {} +`.
- **Testläufe nie über eine Pipe in einen `&&`-Vertrag.**
- **Prüfkette:** `superpowers:requesting-code-review` → CodeRabbit CLI → CodeRabbit-Bot
  (den **Kommentar** lesen, nicht die Prüfspalte).
- **Lokaler Funktionstest ist Pflicht**, ausschliesslich auf einer Wegwerf-venv im Scratchpad —
  nie gegen `E:\Git\Transkribor\.venv`, nie gegen `projekte\`.

---

## Dateien

| Datei | Rolle |
|---|---|
| `webtool/ytdlp_update.py` | **einzige Produktivdatei.** Fünf kleine Funktionen neu, zwei Eingriffe (`aktualisiere()`, `faellig()`). |
| `webtool/test_ytdlp_update.py` | alle neuen Tests, plus ein Satz in der Fixture-Doku. |
| `webtool/CLAUDE.md` | neuer Abschnitt nach dem #224-Abschnitt. |
| `README.md` | nur prüfen; ändern **nur** bei einer jetzt falschen Behauptung. |

---

## Aufgabe 0: Messen, bevor gebaut wird

Der ganze Fix steht und fällt mit **einer** Frage: **repariert ein erneutes
`pip install -U "yt-dlp[default]"` eine abgewürgte Installation — ohne Neueinrichtung?**
Sagt die Messung nein, ist der Plan gegenstandslos.

Zweitens (fürs Protokoll, nicht für die Logik): **wie sieht der Schaden aus?** Das ist die
Belegtabelle für die Doku und der Grund, warum der Merker das Ereignis misst statt der Form.

Diese Aufgabe ändert keine Zeile Produktivcode. **Kein Commit.**

- [ ] **Schritt 1: Messskript ins Scratchpad schreiben** (Datei, nicht `-c` — PS 5.1
      verstümmelt Anführungszeichen in Here-Strings, gemessen)

`<scratchpad>\zustand.py`:
```python
from importlib import metadata, util
try:
    print("version:", repr(metadata.version("yt-dlp")))
except Exception as e:
    print("version wirft:", type(e).__name__, e)
print("find_spec:", util.find_spec("yt_dlp") is not None)
try:
    import yt_dlp
    print("import ok:", yt_dlp.version.__version__)
except Exception as e:
    print("import wirft:", type(e).__name__, e)
```

- [ ] **Schritt 2: Wegwerf-venv mit einer ALTEN Fassung, Cache vorwärmen**

```powershell
$S = "$env:LOCALAPPDATA\Temp\claude\E--Git-Transkribor\4e73cce8-48b7-48a4-8b0c-76e18ccee865\scratchpad\v257"
py -3.13 -m venv $S
& "$S\Scripts\python.exe" -m pip install -q --disable-pip-version-check "yt-dlp[default]==2025.9.5" packaging
& "$S\Scripts\python.exe" -m pip download -q --disable-pip-version-check -d "$S\cache" "yt-dlp[default]"
```

Drei Dinge sind nicht beliebig: eine **alte** Fassung (gegen die neueste macht `-U` nur
„Requirement already satisfied" — es gäbe kein Fenster zu treffen; liegt `2025.9.5` nicht mehr
auf PyPI, eine andere aus `pip index versions yt-dlp` nehmen und die Zahl im Bericht nennen);
der **vorgewärmte Cache**, sonst trifft der Kill fast immer die harmlose Download-Phase; und
**`packaging`**, weil `ytdlp_update` sonst auf seinem fail-open-Pfad läuft
(`ytdlp_update.py:115-118`) und die Messung etwas anderes misst, als der Server tut.

- [ ] **Schritt 3: pip starten, mitten im Lauf abwürgen, Zustand aufnehmen**

```powershell
$args = @("-m","pip","install","-U","--disable-pip-version-check","--no-index","--find-links","$S\cache","yt-dlp[default]")
$p = Start-Process -PassThru -NoNewWindow "$S\Scripts\python.exe" -ArgumentList $args
Start-Sleep -Milliseconds 700
taskkill /F /T /PID $p.Id
& "$S\Scripts\python.exe" "$PSScriptRoot\zustand.py"
```

Kein Element von `$args` enthält ein Leerzeichen — das ist die Bedingung, unter der
`Start-Process -ArgumentList` hier verlässlich ist (gemessen: mit Leerzeichen zerlegt es das
Element und python bekommt Bruchstücke). Die 700 ms sind ein **Startwert**: mehrere Läufe mit
300/700/1200/2000 ms, weil es mehrere Kill-Fenster gibt. Nach jedem Lauf die venv neu aufsetzen
(Schritt 2), sonst misst der zweite Lauf den Schaden des ersten.

- [ ] **Schritt 4: Die eigentliche Frage — repariert ein zweiter Lauf?**

```powershell
& "$S\Scripts\python.exe" -m pip install -U --disable-pip-version-check --no-index --find-links "$S\cache" "yt-dlp[default]"
echo "exitcode: $LASTEXITCODE"
& "$S\Scripts\python.exe" "$PSScriptRoot\zustand.py"
```
Erwartet: Exitcode 0 und `import ok`. **Das ist die Prämisse des Plans.**

- [ ] **Schritt 5: derselbe Kill über den POSIX-Weg (#258) in WSL**

```
wsl -d Ubuntu-22.04 -- bash -lc 'S=/tmp/v258; rm -rf $S; python3 -m venv $S && $S/bin/pip -q install "yt-dlp[default]==2025.9.5" packaging && $S/bin/pip -q download -d $S/cache "yt-dlp[default]" && setsid $S/bin/pip install -U --no-index --find-links $S/cache "yt-dlp[default]" & PID=$!; sleep 0.7; PGID=$(ps -o pgid= -p $PID | tr -d " "); echo "pgid=$PGID"; kill -KILL -$PGID'
```

`setsid` + `kill -KILL -<pgid>` bildet nach, was `jobs._kill_tree` tut
(`os.killpg(os.getpgid(proc.pid), SIGKILL)`). Die **pgid wird protokolliert, nicht angenommen**
— läuft `setsid` als Prozessgruppenführer, forkt es nicht, aber das gehört gemessen statt
unterstellt. Danach `zustand.py` in der WSL-venv laufen lassen.

- [ ] **Schritt 6: Aufräumen und Protokoll festhalten**

```powershell
Remove-Item -Recurse -Force $S
wsl -d Ubuntu-22.04 -- bash -lc 'rm -rf /tmp/v258'
```

> **Entscheidungspunkt.** Zeigt Schritt 4, dass ein zweiter pip-Lauf den Zustand **nicht**
> repariert, wird **nicht gebaut**. Dann bekommen beide Issues die Messung als Schlussnotiz und
> der Zuschnitt geht zurück an Marcus. Das ist ein zulässiger Ausgang, kein Scheitern.

---

## Aufgabe 1: Der Merker

**Dateien:** Ändern `webtool/ytdlp_update.py` (neue Funktionen direkt nach `_lock_stale()`),
Test `webtool/test_ytdlp_update.py`.

**Schnittstellen:**
- Verbraucht: `_lockziel()`, `_heute()`, `INTERVALL_TAGE` (alle bestehend)
- Liefert: `_venv_kennung() -> str`, `_pip_merker() -> str`, `_pip_merker_setzen() -> None`,
  `_pip_merker_loeschen() -> None`, `_pip_unterbrochen() -> bool`

- [ ] **Schritt 1: Die fehlschlagenden Tests schreiben**

Ans Ende von `webtool/test_ytdlp_update.py`:

```python
# --- Der Merker eines unterbrochenen pip-Laufs (#257/#258) -------------------

def test_der_merker_haengt_an_der_VENV_nicht_nur_an_der_einstellungsdatei(monkeypatch):
    """Der Schaden ist pro venv (`pip` laeuft gegen `sys.executable`), die Einstellungsdatei
    aber pro NUTZER: `settings.path()` kennt keinen Zweig fuer die gepackte App, und
    `electron/backend.js` setzt `TRANSKRIBOR_SETTINGS` nicht. Ohne diese Kennung repariert
    der Entwicklerserver die Repo-venv fuer einen Schaden in der App-venv — und verbraucht
    dabei den Merker, den die App braucht (#254)."""
    a = yu._pip_merker()
    monkeypatch.setattr(yu.sys, "prefix", r"C:\woanders\.venv")
    b = yu._pip_merker()
    assert a != b
    assert os.path.dirname(a) == os.path.dirname(b) == os.path.dirname(yu._lockziel())


def test_der_merker_liegt_NEBEN_der_sperre_nicht_darin():
    """Eine Datei IM Lock-Verzeichnis bekommt `sperre._wegraeumen` nicht per `os.rmdir` weg.
    Die Folge ist nicht „das Lock liegt herum", sondern (an echtem `sperre.py` gemessen):
    `datei()` faellt nach `frist(stale)` offen — 220 s Wartezeit bei JEDEM Lauf und danach
    pip OHNE Sperre, also zwei `pip install` in dieselbe venv."""
    lockdir = yu._lockziel() + ".lock"
    merker = yu._pip_merker()
    assert merker != lockdir
    assert not merker.startswith(lockdir + os.sep)


def test_setzen_und_loeschen_beantworten_die_frage():
    """Positiv- UND Negativkontrolle: ein Merker, der IMMER gilt, ist derselbe Schaden von
    der anderen Seite — ein Hintergrund-pip bei jedem Serverstart."""
    assert yu._pip_unterbrochen() is False
    yu._pip_merker_setzen()
    assert yu._pip_unterbrochen() is True
    yu._pip_merker_loeschen()
    assert yu._pip_unterbrochen() is False


def test_ein_alter_merker_gilt_nicht_mehr():
    """Die einzige verbliebene Quelle eines Dauerlaufs ist ein Merker, den `os.remove` nicht
    wegbekommt — GEMESSEN erreichbar: eine Datei mit Read-only-Attribut weist auf Windows
    `os.remove` UND `open(...,'w')` mit PermissionError ab. Dann friert sein Datum ein, und
    genau daran endet er. Ohne diese Uhr waere `faellig()` fuer immer True: die Klasse „Flag
    ohne Ende", gegen die dieses Modul an vier Stellen gebaut ist."""
    with open(yu._pip_merker(), "w", encoding="utf-8") as f:
        f.write((HEUTE - dt.timedelta(days=yu.INTERVALL_TAGE + 1)).isoformat())
    assert yu._pip_unterbrochen() is False


def test_ein_frischer_merker_am_rand_der_frist_gilt_noch():
    """Die Gegenprobe zum Test darueber — auf der Grenze, nicht daneben. Ohne ihn waere ein
    `<`-statt-`<=`-Dreher unsichtbar, und ein Merker verfiele einen Tag zu frueh."""
    with open(yu._pip_merker(), "w", encoding="utf-8") as f:
        f.write((HEUTE - dt.timedelta(days=yu.INTERVALL_TAGE)).isoformat())
    assert yu._pip_unterbrochen() is True


def test_ein_unlesbarer_oder_zukuenftiger_merker_gilt_nicht():
    """Beides heisst „keine Auskunft", und Unbekanntes flaggt dieses Modul nicht (dieselbe
    Richtung wie `_ejs_untauglich`). Ein Zukunftsdatum entsteht durch eine vorgehende
    Rechneruhr — ohne diese Wache waere es dauerhaft gueltig."""
    for inhalt in ("", "gestern", "2099-01-01"):
        with open(yu._pip_merker(), "w", encoding="utf-8") as f:
            f.write(inhalt)
        assert yu._pip_unterbrochen() is False, inhalt


def test_loeschen_ohne_merker_wirft_nicht():
    """Dieses Modul darf nirgends werfen (#185), und der Normalfall ist der ohne Merker."""
    yu._pip_merker_loeschen()
    yu._pip_merker_loeschen()


def test_ein_unschreibbarer_merker_reisst_niemanden_mit(monkeypatch, capsys):
    """Best effort: ohne Merker ist der Zustand der von vor diesem Fix. Aber nicht STILL —
    ein lautlos uebersprungener Merker ist von einem gesetzten nicht zu unterscheiden
    (dieselbe Regel wie bei `sperre.datei`s fail-open)."""
    def kaputt(*a, **k):
        raise OSError("kein Platz")
    monkeypatch.setattr("builtins.open", kaputt)
    yu._pip_merker_setzen()
    monkeypatch.undo()
    assert yu._pip_unterbrochen() is False
    assert "Merker" in capsys.readouterr().out
```

`import os`, `import datetime as dt` und `HEUTE` stehen bereits am Kopf der Datei. Der
`builtins.open`-Patch ist nachgemessen unschädlich für pytest/capsys (das Patchfenster umfasst
zwei Anweisungen, `capsys.readouterr()` geht nicht durch `builtins.open`).

- [ ] **Schritt 2: Fehlschlag bestätigen**

```
E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_ytdlp_update.py -k "merker" -v
```
Erwartet: `AttributeError: module 'webtool.ytdlp_update' has no attribute '_pip_merker'`.

- [ ] **Schritt 3: Die Funktionen einbauen**

Am Kopf von `webtool/ytdlp_update.py` `import hashlib` ergänzen (alphabetisch vor `import os`).
Direkt **nach** `_lock_stale()`:

```python
def _venv_kennung() -> str:
    """Eine kurze, stabile Kennung DIESER Umgebung.

    Der Merker unten haengt an `settings.path()` — und das ist pro NUTZER, nicht pro venv:
    `settings.path()` kennt keinen Zweig fuer die gepackte App, und `electron/backend.js`
    setzt `TRANSKRIBOR_SETTINGS` nicht (nachgeprueft). Der SCHADEN ist aber pro venv, denn
    `aktualisiere()` ruft `sys.executable -m pip`. Ohne diese Kennung reparierte der
    Entwicklerserver seine Repo-venv fuer einen Schaden in der App-venv — und verbrauchte
    dabei den Merker, den die App noch braucht (dieselbe Zwei-Prozess-Lage wie #254).

    `hashlib`, nicht `hash()`: das ist pro Prozess gesalzen (PYTHONHASHSEED) und liefe beim
    naechsten Start auf einen anderen Namen. `normcase` + `abspath`, weil Windows-Pfade
    gross-/kleinschreibungsblind sind. Was das NICHT deckt: dieselbe venv ueber einen Symlink
    oder eine Netzfreigabe erreicht, ergibt zwei Kennungen — die Folge ist eine verpasste
    Reparatur, kein Schaden.
    """
    roh = os.path.normcase(os.path.abspath(sys.prefix)).encode("utf-8", "replace")
    return hashlib.sha1(roh).hexdigest()[:8]


def _pip_merker() -> str:
    """Der Pfad des Merkers „ein pip-Lauf hat begonnen und ist nie sauber geendet"
    (#257/#258).

    **NEBEN der Sperre, nicht darin.** Das Lock-Verzeichnis raeumt der naechste Erwerber weg —
    genau das darf diesem Merker nicht passieren, sein Ueberleben IST seine Aufgabe. Eine Datei
    IM Lock waere zusaetzlich ein Fehler mit Ansage: `sperre._wegraeumen` bekommt ein nicht
    leeres Verzeichnis nicht per `os.rmdir` weg, `datei()` faellt dann nach `frist(stale)` offen
    — an echtem `sperre.py` gemessen 220 s Wartezeit bei jedem Lauf und danach pip OHNE Sperre.

    **Eine Datei statt eines Schluessels in `settings.json`**, aus zwei Gruenden: sie kann eine
    venv-Kennung im Namen tragen (siehe oben), und das Setzen liegt INNERHALB der pip-Sperre —
    ein `settings.save()` dort waere eine zweite verschachtelte Sperre und zwaenge `_lock_stale()`
    um eine weitere `sperre.frist()` nach oben (215 s -> 280 s, die Rechnung aus #207). Ein
    einfacher Dateischreibvorgang nimmt keine Sperre. (Der dritte, naheliegende Grund — „ein
    neuer DEFAULTS-Schluessel schluege in die API durch" — ist NACHGEPRUEFT FALSCH:
    `settings.public()` und `app._settings_body()` haben feste Feldlisten. Er steht hier, damit
    ihn niemand ein zweites Mal erfindet.)
    """
    return f"{_lockziel()}.{_venv_kennung()}.abbruch"


def _pip_merker_setzen() -> None:
    """Unmittelbar VOR `subprocess.run`, INNERHALB der Sperre — siehe `aktualisiere`.

    Best effort: ein nicht schreibbarer Merker macht den Zustand nur so schlecht, wie er vor
    diesem Fix war. Aber nicht STILL, sonst ist er von einem gesetzten nicht zu unterscheiden
    (dieselbe Regel wie bei `sperre.datei`s fail-open).
    """
    try:
        with open(_pip_merker(), "w", encoding="utf-8") as f:
            f.write(_heute().isoformat())
    except OSError as e:
        print(f"[ytdlp] Merker fuer den pip-Lauf nicht schreibbar: {e}", flush=True)


def _pip_merker_loeschen() -> None:
    """Unmittelbar NACH dem Lauf, noch INNERHALB derselben Sperre.

    `FileNotFoundError` schweigt — das ist der Normalfall, wenn der Schreibversuch scheiterte.
    Jeder andere `OSError` gehoert ins Protokoll: er ist die einzige verbliebene Quelle eines
    Dauerlaufs, und `_pip_unterbrochen()` deckelt ihn mit der Uhr statt ihn zu verhindern.
    """
    try:
        os.remove(_pip_merker())
    except FileNotFoundError:
        pass
    except OSError as e:
        print(f"[ytdlp] Merker fuer den pip-Lauf nicht loeschbar: {e} — die Faelligkeit "
              f"bleibt bis zur Frist bestehen", flush=True)


def _pip_unterbrochen() -> bool:
    """Wurde ein pip-Lauf abgewuergt, und ist das noch aktuell?

    Gefragt wird die PLATTE (wie bei `settings.kaputt_pfad()`): der Merker ueberlebt den
    Prozess absichtlich, und geschrieben hat ihn oft ein Subprozess, den nie jemand gesehen hat
    (die Selbstheilung in `fetch.py`).

    **Das Datum wird GELESEN, nicht nur geschrieben** — daran haengt die Zusicherung „kein Flag
    ohne Ende". Gelingt `os.remove` dauerhaft nicht, friert das Datum ein (dieselbe Datei weist
    auch `open(...,"w")` ab — auf Windows an einer Datei mit Read-only-Attribut gemessen), und
    nur die Uhr beendet den Zustand dann noch. `INTERVALL_TAGE` statt einer eigenen Zahl: laenger
    als der Kalendertakt zu warten hiesse, auf eine Reparatur zu warten, die der Kalender ohnehin
    anstoesst.

    Unlesbar oder in der ZUKUNFT (vorgehende Rechneruhr) heisst „keine Auskunft" ⇒ gilt nicht.
    Unbekanntes flaggt dieses Modul nicht — dieselbe Richtung wie in `_ejs_untauglich`. Ein
    solcher Merker bleibt nicht liegen: der naechste Lauf ueberschreibt ihn.
    """
    try:
        with open(_pip_merker(), encoding="utf-8") as f:
            d = dt.date.fromisoformat(f.read(64).strip())
    except (OSError, ValueError):     # UnicodeDecodeError IST ein ValueError (#185/#190)
        return False
    return 0 <= (_heute() - d).days <= INTERVALL_TAGE
```

- [ ] **Schritt 4: Erfolg bestätigen**

```
E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_ytdlp_update.py -k "merker" -v
```
Erwartet: 8 × PASS.

- [ ] **Schritt 5: Mutationsprobe** (Anker wörtlich, danach sauber zurückspielen)

| Anker (eindeutig) | Mutation | erwartet rot |
|---|---|---|
| `return f"{_lockziel()}.{_venv_kennung()}.abbruch"` | → `return _lockziel() + ".abbruch"` | `…haengt_an_der_VENV…` |
| dieselbe Zeile | → `return os.path.join(_lockziel() + ".lock", "abbruch")` | `…liegt_NEBEN_der_sperre…` |
| `return 0 <= (_heute() - d).days <= INTERVALL_TAGE` | → `return True` | `test_setzen_und_loeschen…`, `…alter_merker…`, `…unlesbarer…` |
| dieselbe Zeile | → `return (_heute() - d).days <= INTERVALL_TAGE` (untere Schranke weg) | `…unlesbarer_oder_zukuenftiger…` |
| dieselbe Zeile | → `... < INTERVALL_TAGE` | `…am_rand_der_frist…` |
| `except (OSError, ValueError):     # Unicode…` | → `except OSError:` | `…unlesbarer_oder_zukuenftiger…` |
| `print(f"[ytdlp] Merker fuer den pip-Lauf nicht schreibbar: {e}", flush=True)` | Zeile samt `except OSError as e:` darüber entfernen | `…unschreibbarer_merker…` |
| `except FileNotFoundError:` (kommt in dieser Datei sonst **nicht** vor) | Zweig entfernen | `test_loeschen_ohne_merker_wirft_nicht` |

Danach `__pycache__` leeren, `git diff --stat` lesen — er muss genau die geplanten Zeilen zeigen.

- [ ] **Schritt 6: Commit**

```bash
git add webtool/ytdlp_update.py webtool/test_ytdlp_update.py
git commit -m "feat(ytdlp): venv-gebundener Merker fuer einen unterbrochenen pip-Lauf (#257/#258)"
```

---

## Aufgabe 2: `aktualisiere()` setzt und räumt ihn — innerhalb der Sperre

**Dateien:** Ändern `webtool/ytdlp_update.py` (`aktualisiere()`), Test
`webtool/test_ytdlp_update.py`.

**Schnittstellen:** verbraucht `_pip_merker_setzen()` / `_pip_merker_loeschen()`; die Signatur
`aktualisiere() -> tuple[bool, bool]` bleibt unverändert.

Die Regel in einem Satz: **der Merker überlebt genau dann, wenn der Prozess selbst stirbt.**
Kein Sonderfall für `TimeoutExpired`, kein Flag, keine Reihenfolge von `except`-Zweigen —
gelöscht wird nach **jedem** behandelten Ausgang.

- [ ] **Schritt 1: Die fehlschlagenden Tests schreiben**

```python
def test_der_merker_liegt_WAEHREND_des_pip_laufs(monkeypatch):
    """Er muss VOR pip gesetzt sein — das Fenster, um das es geht, ist der Kill mitten im
    Umschreiben. Gemessen wird IM Spion und danach ausgewertet: ein `assert` im Stub stuende
    innerhalb des `try`, um das `aktualisiere()` seine Ausnahmen legt, und der AssertionError
    wuerde von der geprueften Stelle selbst geschluckt (dieselbe Falle wie bei #185)."""
    gesehen = []

    def run(cmd, **kwargs):
        gesehen.append(yu._pip_unterbrochen())
        return subprocess.CompletedProcess(cmd, 0, "Successfully installed yt-dlp", "")

    monkeypatch.setattr(yu.subprocess, "run", run)
    yu.aktualisiere()
    assert gesehen == [True]


def test_der_merker_wird_INNERHALB_der_sperre_gesetzt(monkeypatch):
    """Nicht davor — sonst setzt ihn auch, wer nur WARTET, und ein zweiter Aktualisierer
    loescht beim Fertigwerden den Merker des ersten. Dessen pip laeuft danach ungedeckt: wird
    es abgewuergt, bleibt KEIN Merker zurueck und der Schaden wird nie erkannt. Zwei
    Aktualisierer gleichzeitig sind hier der Normalfall (Server + fetch-Subprozess, seit #254
    auch zwei Server)."""
    folge = []
    echte_sperre = yu.sperre.datei

    @contextlib.contextmanager
    def datei(pfad, stale=None, **kw):
        folge.append("sperre auf")
        with echte_sperre(pfad, stale=stale) as gehalten:
            yield gehalten
        folge.append("sperre zu")

    def run(cmd, **kwargs):
        folge.append("pip")
        return subprocess.CompletedProcess(cmd, 0, "ok", "")

    monkeypatch.setattr(yu.sperre, "datei", datei)
    monkeypatch.setattr(yu.subprocess, "run", run)
    monkeypatch.setattr(yu, "_pip_merker_setzen",
                        lambda: folge.append("merker gesetzt"))
    yu.aktualisiere()
    assert folge == ["sperre auf", "merker gesetzt", "pip", "sperre zu"]


def test_jeder_zurueckgekehrte_lauf_raeumt_den_merker_weg(monkeypatch):
    """Auch bei returncode != 0 und auch bei einer Zeitueberschreitung: in allen drei Faellen
    hat der Prozess UEBERLEBT und raeumt hinter sich auf. Bliebe der Merker bei einem Timeout
    liegen, liefe auf einer langsamen Leitung bei JEDEM Start ein 120-s-pip — genau der
    Dauerlauf, den dieses Modul ausschliesst."""
    for stub in (lambda cmd, **k: subprocess.CompletedProcess(cmd, 0, "ok", ""),
                 lambda cmd, **k: subprocess.CompletedProcess(cmd, 1, "ERROR", ""),
                 _wirft(subprocess.TimeoutExpired("pip", yu.PIP_TIMEOUT)),
                 _wirft(OSError("kein Interpreter"))):
        monkeypatch.setattr(yu.subprocess, "run", stub)
        yu.aktualisiere()
        assert yu._pip_unterbrochen() is False


def test_ein_wurf_den_niemand_faengt_laesst_den_merker_liegen(monkeypatch):
    """Der Fall, um den es geht — hier stellvertretend als `KeyboardInterrupt`: Ctrl+C schickt
    SIGINT an die ganze Vordergrund-Prozessgruppe, pip inklusive, also ist die Installation
    genauso halb wie nach einem `taskkill /F /T`. `except (OSError, SubprocessError)` faengt
    das bewusst nicht, und genau deshalb ueberlebt der Merker."""
    monkeypatch.setattr(yu.subprocess, "run", _wirft(KeyboardInterrupt()))
    with pytest.raises(KeyboardInterrupt):
        yu.aktualisiere()
    assert yu._pip_unterbrochen() is True
```

Dazu oben bei `_pip(...)` eine zweite Hilfe:

```python
def _wirft(fehler):
    """Ein `subprocess.run`-Ersatz, der wirft. Eigene Funktion, weil ein `lambda` mit `raise`
    nicht geht und vier Tests dieselbe Form brauchen."""
    def run(cmd, **kwargs):
        raise fehler
    return run
```

`import contextlib` steht bereits am Kopf der Datei.

- [ ] **Schritt 2: Fehlschlag bestätigen**

```
E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_ytdlp_update.py -k "WAEHREND or INNERHALB_der_sperre or zurueckgekehrte or wurf_den_niemand" -v
```
Erwartet: `…WAEHREND…` FAIL (`[False] != [True]`), `…INNERHALB_der_sperre…` FAIL (Reihenfolge
ohne „merker gesetzt"), `…wurf_den_niemand…` FAIL (`False is not True`).
`…zurueckgekehrte…` ist zunächst grün — es liegt ja nie einer. Genau deshalb ist seine
Mutationsprobe in Schritt 5 zwingend.

- [ ] **Schritt 3: `aktualisiere()` umbauen**

Im Rumpf von `aktualisiere()` bleibt alles vor `with sperre.datei(...)` unverändert. Innerhalb:

```python
    with sperre.datei(lockziel, stale=_lock_stale()) as gehalten:
        # INNERHALB der Sperre und unmittelbar um `subprocess.run` herum — beide Zeilen. Das
        # ist die ganze Erkennung: der Merker ueberlebt GENAU DANN, wenn dieser Prozess
        # zwischen den beiden Zeilen stirbt, und das ist #257/#258.
        #
        # Nicht VOR die Sperre: dann setzte ihn auch, wer nur WARTET, und der Fertigwerdende
        # loeschte den Merker des Wartenden — dessen pip liefe danach ungedeckt. Zwei
        # Aktualisierer gleichzeitig sind hier der Normalfall (Server + fetch-Subprozess, seit
        # #254 auch zwei Server). Ein `settings.save()` an dieser Stelle waere dagegen teuer
        # (zweite verschachtelte Sperre ⇒ `_lock_stale()` muesste um `frist()` wachsen, #207);
        # ein einfacher Dateischreibvorgang nimmt keine Sperre.
        _pip_merker_setzen()
        try:
            p = subprocess.run(cmd, capture_output=True, text=True, errors="replace",
                               timeout=PIP_TIMEOUT)
            ok = p.returncode == 0
            zeilen = (p.stdout or "").strip().splitlines() or (p.stderr or "").strip().splitlines()
            print(f"[ytdlp] {'ok' if ok else 'fehlgeschlagen'}: {zeilen[-1] if zeilen else ''}",
                  flush=True)
        except (OSError, subprocess.SubprocessError) as e:
            print(f"[ytdlp] Update fehlgeschlagen: {e}", flush=True)
        # Nach JEDEM behandelten Ausgang, ohne Fallunterscheidung: wer hier ankommt, hat
        # ueberlebt und raeumt hinter sich auf. Eine Sonderbehandlung fuer `TimeoutExpired`
        # („pip wurde ja abgewuergt") stand hier einmal und war die einzige Quelle eines
        # Dauerlaufs, den die Uhr nicht deckt: auf einer langsamen Leitung ueberschreitet pip
        # die 120 s bei JEDEM Start. Was das kostet, steht als Issue: ein selbst verursachter
        # Timeout MITTEN in der Installation bleibt unerkannt — heute genauso, also kein
        # Rueckschritt.
        #
        # VOR `_merken()`: das faengt nur `OSError`, ein anderer Wurf dort liesse den Merker
        # sonst liegen, obwohl pip sauber durchgelaufen ist.
        _pip_merker_loeschen()
        # INNERHALB der Sperre: der Kommentar behauptete das einmal, der Aufruf stand aber eine
        # Zeile darunter — womit der Test auf die verschiedenen Lock-Namen nichts prueffte.
        _merken()
    return ok, gehalten
```

Der Docstring von `aktualisiere()` bekommt einen Absatz:

```
    **Der Merker `_pip_merker()` deckt das Abwuergen von aussen** (#257/#258): gesetzt
    unmittelbar vor `subprocess.run`, geloescht unmittelbar danach, beides innerhalb der
    Sperre. Er ueberlebt damit genau dann, wenn DIESER Prozess dazwischen stirbt —
    `taskkill /F /T` beim Schliessen der Desktop-App, `jobs.cancel_all()` → SIGKILL auf die
    Prozessgruppe des fetch-Jobs beim Shutdown, oder ein Ctrl+C. `faellig()` holt daraufhin
    genau EINEN Reparaturlauf nach. Ohne ihn blieb yt-dlp halb installiert zurueck,
    `fassung()` gab None, `faellig()` bewusst False, und die Selbstaktualisierung war
    DAUERHAFT aus.
```

- [ ] **Schritt 4: Erfolg bestätigen**

```
E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_ytdlp_update.py -v
```

- [ ] **Schritt 5: Mutationsprobe**

| Anker (eindeutig) | Mutation | erwartet rot |
|---|---|---|
| `        _pip_merker_setzen()` (Aufrufzeile, 8 Leerzeichen — die `def`-Zeile hat keine) | vor `with sperre.datei` verschieben | `…INNERHALB_der_sperre…` |
| dieselbe Zeile | hinter `p = subprocess.run(...)` verschieben | `…WAEHREND_des_pip_laufs…` |
| `        _pip_merker_loeschen()` (Aufrufzeile) | entfernen | `…zurueckgekehrte_lauf…` |
| dieselbe Zeile | in ein `finally:` des `try` verschieben | `…wurf_den_niemand_faengt…` |
| `except (OSError, subprocess.SubprocessError) as e:` in `aktualisiere` | → `except BaseException as e:` | `…wurf_den_niemand_faengt…` |

- [ ] **Schritt 6: Commit**

```bash
git add webtool/ytdlp_update.py webtool/test_ytdlp_update.py
git commit -m "fix(ytdlp): ein abgewuergtes pip hinterlaesst seinen Merker (#257/#258)"
```

---

## Aufgabe 3: `faellig()` holt den unterbrochenen Lauf nach

**Dateien:** Ändern `webtool/ytdlp_update.py` (`faellig()`), Test `webtool/test_ytdlp_update.py`.

- [ ] **Schritt 1: Die fehlschlagenden Tests schreiben**

```python
def test_ein_unterbrochener_lauf_macht_faellig(monkeypatch):
    """#257/#258, der Kern. Fassung taufrisch, heute schon geprueft: nach jeder anderen Regel
    dieses Moduls waere das NICHT faellig. Der Merker schlaegt sie alle, weil eine halbe
    Installation im Kalender nicht vorkommt."""
    monkeypatch.setattr(yu, "fassung", lambda: "2026.8.12")
    settings.save({"ytdlp_geprueft": HEUTE.isoformat()})
    assert yu.faellig() is False                       # Negativkontrolle
    yu._pip_merker_setzen()
    assert yu.faellig() is True


def test_der_merker_schlaegt_auch_den_nicht_installiert_riegel(monkeypatch):
    """Ohne Merker heisst `fassung() is None` „nicht installiert — Sache des Setups" und
    verbietet jedes pip (`test_ohne_installiertes_yt_dlp_kein_update`). Genau dieser Riegel
    machte den Schaden dauerhaft: ein abgewuergtes pip LOESCHT die Metadaten, und danach hielt
    der Riegel die Reparatur auf. Der Merker muss deshalb VOR ihm stehen."""
    monkeypatch.setattr(yu, "fassung", lambda: None)
    assert yu.faellig() is False                       # Negativkontrolle
    yu._pip_merker_setzen()
    assert yu.faellig() is True


def test_beim_start_holt_einen_unterbrochenen_lauf_nach(monkeypatch):
    """Die Kette, an der beide Issues haengen: der naechste Serverstart repariert.
    `starte_hintergrund` gefaelscht, sonst liefe ein echter Faden mit echtem pip."""
    monkeypatch.setattr(yu, "fassung", lambda: "2026.8.12")
    settings.save({"ytdlp_geprueft": HEUTE.isoformat()})
    monkeypatch.setattr(yu, "laeuft_gerade", lambda *a: False)
    gestartet = []
    monkeypatch.setattr(yu, "starte_hintergrund", lambda: gestartet.append(1) or True)
    assert yu.beim_start() is False                    # Negativkontrolle
    yu._pip_merker_setzen()
    assert yu.beim_start() is True
    assert gestartet == [1]
```

Kein `_ejs_untauglich`-Pin in diesen Tests: die Fixture setzt ihn auf `False`, und ein `True`
wäre hier **inert** — die Negativkontrolle kehrt schon am `v is None`-Riegel um, die
Positivkontrolle am Merker davor. (In Fassung 1 stand er drin, mit einer Begründung, die das
Gegenteil dessen sagte, was ein `True` bewirkt.)

- [ ] **Schritt 2: Fehlschlag bestätigen**

```
E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/test_ytdlp_update.py -k "unterbrochener_lauf or nicht_installiert_riegel or beim_start_holt" -v
```
Erwartet: 3 × FAIL, jeweils an der Zusicherung nach `_pip_merker_setzen()`.

- [ ] **Schritt 3: `faellig()` erweitern**

Ganz am Anfang des Rumpfs von `faellig()`, **vor** `v = fassung()`:

```python
    if _pip_unterbrochen():
        # #257/#258: ein pip-Lauf ist abgewuergt worden — Windows `taskkill /F /T` auf den
        # Prozessbaum beim Schliessen der App, POSIX `jobs.cancel_all()` → SIGKILL auf die
        # Prozessgruppe des fetch-Jobs beim Shutdown. Was er hinterlaesst, sieht KEINE der
        # Regeln unten: die Metadaten koennen weg sein (dann haelt der „Sache des Setups"-
        # Riegel die Reparatur auf), oder sie stehen noch und nur die Dateien sind halb — dann
        # ist die Fassung taufrisch und der Kalender schweigt. Der Schaden heilte sich bis
        # hierher NICHT selbst.
        #
        # **VOR `fassung()`**, nicht danach: der Riegel unten ist genau der, der die Reparatur
        # verhinderte. Ein Test haelt die Reihenfolge fest.
        #
        # **Keine Tagesbremse.** Sie waere hier schaedlich: lief heute schon ein regulaeres pip
        # durch (`geprueft` = heute) und wurde DANACH eines abgewuergt — das ist #258s Ablauf —,
        # verschoebe sie die Reparatur auf morgen, also einen ganzen Tag ohne URL-Import.
        # Gedeckelt ist der Fall stattdessen am Merker selbst: `aktualisiere()` loescht ihn nach
        # jedem zurueckgekehrten Lauf, und `_pip_unterbrochen()` laesst ihn nach INTERVALL_TAGE
        # verfallen — falls `os.remove` ihn dauerhaft nicht wegbekommt.
        return True
```

- [ ] **Schritt 4: Erfolg bestätigen — ganze Suite**

```
E:\Git\Transkribor\.venv\Scripts\python.exe -m pytest webtool/ -q
```
Erwartet: alle grün. Referenz auf master: 754 passed, 1 skipped — plus die neuen. Zahl im
Bericht **nachmessen**, nicht abschreiben.

- [ ] **Schritt 5: Mutationsprobe**

| Anker (eindeutig) | Mutation | erwartet rot |
|---|---|---|
| `    if _pip_unterbrochen():` | Block ersatzlos entfernen | alle drei Tests aus Schritt 1 |
| derselbe Block | hinter `v = fassung()` / `if v is None: return False` verschieben | `…nicht_installiert_riegel…` |
| `        return True` **innerhalb dieses Blocks** (8 Leerzeichen; `return True` steht in dieser Datei mehrfach — Anker ist die Einrückung samt der Zeile `if _pip_unterbrochen():` darüber) | → `return g is None or g < heute` (mit vorgezogenem `g`/`heute`) | `…unterbrochener_lauf…` **und** `…beim_start_holt…` (beide setzen `geprueft` auf heute); `…nicht_installiert_riegel…` bliebe grün, weil dort `g is None` gilt |

- [ ] **Schritt 6: Satz in die Fixture-Doku**

In `webtool/test_ytdlp_update.py`, Docstring der `isoliert`-Fixture bzw. des Moduls:

```
`faellig()` haengt seit #257/#258 zusaetzlich an einer DATEI auf der Platte
(`_pip_merker()`, ueber `_lockziel()` an `TRANSKRIBOR_SETTINGS`). Wer kuenftig einen Test
schreibt, der `faellig()`/`beim_start()` ohne diese Fixture anfasst, bekommt auf einem
Entwicklerrechner ein True, sobald dort einmal ein pip abgewuergt wurde — und damit ein
ECHTES pip gegen dessen venv. Die CI sieht das nie (dort lief nie ein `aktualisiere()`).
```

- [ ] **Schritt 7: Commit**

```bash
git add webtool/ytdlp_update.py webtool/test_ytdlp_update.py
git commit -m "fix(ytdlp): unterbrochener Lauf wird beim naechsten Start nachgeholt (#257/#258)"
```

---

## Aufgabe 4: Lokaler Funktionstest am echten Pfad

Ein grüner Testlauf sagt, dass der Code tut, was die Attrappe erwartet — nicht, dass die
Funktion im echten Programm läuft. **Kein Commit von Code, nur ein Protokoll.**

- [ ] **Schritt 1: Wegwerf-venv wie Aufgabe 0, Schritt 2** — zusätzlich:

```powershell
$env:TRANSKRIBOR_SETTINGS = "$S\settings.json"
$env:PYTHONPATH = "E:\Git\Transkribor"
```

- [ ] **Schritt 2: Treiberskripte ins Scratchpad schreiben** (Dateien, nicht `-c`)

`<scratchpad>\lauf.py`:
```python
from webtool import ytdlp_update as yu
print(yu.aktualisiere())
```

`<scratchpad>\pruef.py`:
```python
from webtool import ytdlp_update as yu
print("merker:", yu._pip_merker())
print("unterbrochen:", yu._pip_unterbrochen())
print("fassung:", repr(yu.fassung()))
print("faellig:", yu.faellig())
```

- [ ] **Schritt 3: Echten Lauf abwürgen und messen**

```powershell
$p = Start-Process -PassThru -NoNewWindow "$S\Scripts\python.exe" -ArgumentList @("$PSScriptRoot\lauf.py")
Start-Sleep -Milliseconds 900
taskkill /F /T /PID $p.Id
Get-ChildItem $S -Filter "settings.json.ytdlp*" -Force | Select-Object Name
& "$S\Scripts\python.exe" "$PSScriptRoot\pruef.py"
```
Erwartet: eine Datei `settings.json.ytdlp.<8 Hex>.abbruch`, `unterbrochen: True`,
`faellig: True` — **unabhängig davon, was `fassung()` sagt.**

- [ ] **Schritt 4: Negativkontrolle auf `master`**

Denselben `pruef.py`-Lauf gegen den **unveränderten** Code (`git stash` bzw. ein zweites
Checkout) mit **derselben** kaputten venv: dort muss `faellig: False` stehen. Ohne diese
Gegenprobe ist Schritt 3 eine Positivkontrolle ohne Negativkontrolle — und dieses Repo führt
genau das als eigene Fehlerklasse.

- [ ] **Schritt 5: Reparatur fahren und prüfen, dass sie sich beendet**

```powershell
& "$S\Scripts\python.exe" "$PSScriptRoot\lauf.py"
& "$S\Scripts\python.exe" "$PSScriptRoot\pruef.py"
```
Erwartet: `unterbrochen: False`, `faellig: False`, und `import yt_dlp` läuft (über `zustand.py`
aus Aufgabe 0). Bliebe der Merker liegen, wäre der Fix ein Dauerlauf statt einer Reparatur.

- [ ] **Schritt 6: POSIX-Weg (#258) in WSL** — wie Aufgabe 0, Schritt 5, aber mit `lauf.py`
      statt nacktem pip, `TRANSKRIBOR_SETTINGS` in `/tmp` und
      `PYTHONPATH=/mnt/e/Git/Transkribor`; danach `pruef.py`.

- [ ] **Schritt 7: Aufräumen, Protokoll festhalten**

```powershell
Remove-Item -Recurse -Force $S
Remove-Item Env:TRANSKRIBOR_SETTINGS, Env:PYTHONPATH
```
Fällt ein Teil aus (WSL fehlt, PyPI nicht erreichbar), wird das als **fehlende Prüfung**
benannt, nicht als „läuft".

---

## Aufgabe 5: Dokumentation

- [ ] **Schritt 1: `webtool/CLAUDE.md`** — neuer Abschnitt
      `## Ein abgewürgtes pip heilt sich beim nächsten Start (#257/#258)`, mit genau den
      Punkten, die man **nicht aus dem Diff liest**:

- Das **Messprotokoll** aus Aufgabe 0 und 4, wörtlich — vor allem: *repariert ein zweiter
  pip-Lauf?* Ohne diese Zahlen ist der Abschnitt eine Behauptung.
- **Warum der Merker das EREIGNIS misst und nicht die FORM** (drei Kill-Fenster, drei
  verschiedene Zustände, einer davon für jede Prüfung im `v is None`-Zweig unsichtbar).
- **Warum er eine venv-Kennung trägt**: `settings.path()` ist pro Nutzer, der Schaden pro venv;
  ohne sie repariert der Entwicklerserver die falsche venv **und verbraucht dabei den Merker**
  (die #254-Lage).
- **Warum Setzen und Löschen INNERHALB der Sperre liegen** und was davor passierte: ein
  Wartender setzte den Merker, der Fertigwerdende löschte ihn — die Erkennungslücke.
- **Warum es keine Sonderbehandlung für `TimeoutExpired` gibt** und was das kostet.
- **Warum das Datum gelesen wird**: `os.remove` kann dauerhaft scheitern (gemessen: Read-only-
  Attribut weist auf Windows `remove` **und** `open(...,"w")` ab) — die Uhr ist der einzige
  Ausweg aus dem Flag ohne Ende.
- **Was NICHT behoben ist**, je mit Grund: das Abwürgen selbst; ein selbst verursachter Timeout
  mitten in der Installation; der #224-Fall auf POSIX, wo das pip-Kind **überlebt** und fertig
  installiert, während sein Merker liegen bleibt — das kostet **einen** überflüssigen Lauf beim
  nächsten Start. Der Grund gegen ein Aufräumen in `beim_ende()` gehört dazu: dort ist nicht zu
  wissen, ob das Kind noch fertig wird.
- **Was unter `sperre.datei`s fail-open weiterhin gilt:** zwei Prozesse im selben Abschnitt
  können sich am Merker in die Quere kommen. Dort laufen ohnehin zwei `pip install` in dieselbe
  venv — das grössere Problem, und es ist gemeldet (#236).

- [ ] **Schritt 2: README prüfen**

```bash
grep -n "yt-dlp\|Video-URL\|aktualisier\|nicht installiert" README.md
```
Geändert wird **nur**, wenn dort eine jetzt falsche Behauptung steht (z. B. ein Rat
„richte neu ein, wenn der URL-Import 'nicht installiert' meldet"). Reine Robustheit, die
niemand bemerkt, gehört nicht hinein. Die Entscheidung (geändert / bewusst nicht) wird im PR
benannt.

- [ ] **Schritt 3: Commit**

```bash
git add webtool/CLAUDE.md README.md
git commit -m "docs(ytdlp): warum der Merker das Ereignis misst und an der venv haengt (#257/#258)"
```

`CLAUDE.md` ist gitignoriert (#110) — `git add` mit explizitem Pfad geht, `git add -A` ist
gesperrt; vor einem Rebase aus Index/Stash nehmen.

---

## Aufgabe 6: Prüfen, PR, Issues

- [ ] **Schritt 1: Branch + PR** (Branch **vor** Aufgabe 1 anlegen)

```bash
git checkout -b fix/257-258-abgewuergtes-pip
git push -u origin fix/257-258-abgewuergtes-pip
gh pr create --base master --title "fix(ytdlp): ein abgewuergtes pip heilt sich beim naechsten Start (#257, #258)" --body-file <bericht>
```
Der PR-Text trägt das Messprotokoll aus Aufgabe 0 und 4 **und** die Mutationstabellen.

- [ ] **Schritt 2: `superpowers:requesting-code-review` — zuerst, immer.** Der Auftrag nennt
      ausdrücklich: die Frage „was erlaubt der Fix NEU?"; die bewusst nicht behobenen Punkte
      samt Begründung (Abwürgen selbst, Timeout-mitten-in-der-Installation, #224-Nebeneffekt),
      damit er sie nicht als Befund meldet; und die Aufforderung, gegnerisch zu lesen.

- [ ] **Schritt 3: CodeRabbit CLI**

```
wsl -d Ubuntu-22.04 -- bash -lc 'cd /mnt/e/Git/Transkribor && coderabbit review --agent --committed --base-commit c3e3bb8 -c CLAUDE.md'
```

- [ ] **Schritt 4: CodeRabbit-Bot — den KOMMENTAR lesen**

```
gh api repos/napoleonmm83/Transkribor/issues/<nr>/comments --jq '.[] | select(.user.login=="coderabbitai[bot]") | .body'
```

- [ ] **Schritt 5: Befunde gegenprüfen, nicht übernehmen.** Jeder Befund wird am Code
      nachgelesen; jeder daraus folgende Fix wird mutationsgeprüft.

- [ ] **Schritt 6: Issues** (vorher `gh issue list`, nichts doppeln)

**Schliessen:** #257 und #258, mit gemeinsamer Notiz — was gemessen wurde, welcher der drei
Wege gegangen wurde und warum, und was ausdrücklich offen bleibt (das Abwürgen selbst).

**Neu anlegen**, je mit Fundstelle / warum es zählt / wie gefunden:
1. *`test_pip_sperre_deckt_die_VERSCHACHTELTE_wartezeit_mit` kann seine Regel nicht verletzen
   sehen* — `test_ytdlp_update.py:1096` rechnet die Vergleichsgrösse aus **denselben**
   Konstanten wie `_lock_stale()`; nimmt jemand den 30-s-Zuschlag heraus, bleibt der Test grün
   (`frist(215)=220 > 215`). Die #207-Regel ist handgepflegt, nicht bewacht. `bug`. Gefunden im
   Gegenlauf zu diesem Plan.
2. *Ein selbst verursachter `TimeoutExpired` mitten in der Installation bleibt unerkannt* —
   bewusste Entscheidung (die Alternative war ein Dauerlauf auf langsamen Leitungen), samt
   Begründung. `bug`, klein.
3. *Die Einstellungsseite zeigt einen unterbrochenen Lauf nicht* — `zustand()` liefert bei einem
   halb installierten yt-dlp `version: null, unlesbar: false`, die Seite sagt „Nicht
   installiert", obwohl beim nächsten Start eine Reparatur ansteht. `enhancement`.
4. *#224 auf POSIX: das überlebende pip-Kind lässt den Merker liegen* — kostet beim nächsten
   Start einen überflüssigen Lauf. `bug`, klein.
5. Alles, was die Reviews geparkt haben.

- [ ] **Schritt 7: Merge**

```bash
gh pr merge <nr> --rebase --delete-branch
git checkout master && git pull --ff-only && git log --oneline -3
```

- [ ] **Schritt 8: MEMORY.md nachziehen** — master-SHA, Testzahlen **gegen master gemessen**,
      Wellenplan-Position, und die Lektion aus dieser Arbeit verlinken.

---

## Selbstprüfung

- **#257 abgedeckt:** Aufgabe 1–3; Windows-Kill gemessen in Aufgabe 0/4. ✔
- **#258 abgedeckt:** derselbe Mechanismus — der fetch-Subprozess schreibt den Merker in
  `aktualisiere()` (über `automatisch(erzwingen=True)`), SIGKILL lässt ihn liegen, der nächste
  Serverstart repariert. Gemessen in Aufgabe 0/4, jeweils WSL-Schritt. ✔
- **Keine Platzhalter:** jeder Codeschritt trägt Code, jeder Test seine Zusicherung, jede
  Mutation ihren eindeutigen Anker und ihren erwarteten roten Test.
- **Namenskonsistenz:** `_venv_kennung`, `_pip_merker`, `_pip_merker_setzen`,
  `_pip_merker_loeschen`, `_pip_unterbrochen`, Hilfe `_wirft` — in Aufgabe 1/2 definiert, in
  2/3 unter genau diesen Namen verwendet.
- **Offener Punkt, bewusst so:** ob ein zweiter pip-Lauf die abgewürgte Installation repariert,
  entscheidet Aufgabe 0. Der Entscheidungspunkt dort darf den Plan abbrechen.
