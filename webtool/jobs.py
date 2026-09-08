"""Minimale In-Memory-Job-Registry für langlaufende Subprozesse (Transkription u.a.).

threading + subprocess.Popen; kein asyncio/Celery/Redis. Ein einzelner lokaler Nutzer.
Fortschritt = stdout-Zeilen im Job-Log; via GET /api/jobs/{id} gepollt.
"""
import os
import re
import signal
import subprocess
import sys
import threading
import time
import uuid

from . import settings

_jobs = {}                 # job_id -> record
_active = {}               # (project, kind) -> job_id (Dedupe: je Art einer pro Projekt)
# (project, kind, base) -> Vorgangsnummer. Genau EINE Vormerkung je Schluessel.
#
# Bis #381 war das ein `set`. Die Umstellung auf ein dict laesst JEDE bestehende Zusicherung
# buchstabengleich: `key in _pending` (request) und die beiden Iterationen in
# `transcribe_laeuft_oder_wartet` und `_run` lesen bei einem dict dieselben Schluessel
# wie bei einem set. Aus `discard(key)` wird `pop(key, None)` — dieselbe Zusicherung
# („weg, und es ist kein Fehler, wenn er schon weg war"), samt dem Leck-Riegel aus #417.
# Der Wert ist neu und wird von der Sperrlogik nirgends gelesen.
_pending = {}

# Vorgangsnummer -> Zustand der Vormerkung. Die zweite Struktur ist noetig, weil ein
# AUFGELOESTER Vorgang lesbar bleiben muss, nachdem `rerun` seinen Schluessel aus `_pending`
# geraeumt hat — bliebe er dort stehen, hielte `key in _pending` eine neue Vormerkung fuer
# schon vorhanden, und genau das ist die Zusicherung, die `_pending` traegt.
_vorgaenge: dict[str, dict] = {}
_VORGAENGE_MAX = 200
                           # DREITUPEL, nicht (project, kind) — die Zeile sagte das Falsche,
                           # und zwei Zusicherungen in `test_jobs.py` sind darauf hereingefallen
                           # (sie fragen ein Zweitupel ab und koennen nie rot werden).
_lock = threading.Lock()

_CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0
_PRUNE_AGE = 3600          # fertige Jobs nach 1h vergessen

# Womit ein Lauf seinen Wirkungsbereich meldet: eine tab-getrennte Liste von Basisnamen,
# gedruckt BEVOR er arbeitet (transcribe.py, correct.py, fetch.py). Eine eigene Zeile statt
# eines Nachbaus von jobPhases.ts: der Fortschritts-Dialekt sagt, wo ein Lauf GERADE steht —
# gebraucht wird, was er noch anfassen WIRD. Tab als Trenner, weil Dateinamen alles andere
# enthalten dürfen (der URL-Import legt "Video [dQw4w9].m4a" an), aber keinen Tabulator.
SCOPE_PREFIX = "[scope] "
# Der NACHTRAG zum Wirkungsbereich. `transcribe_project` scannt in jeder Runde neu und nimmt
# waehrend des Laufs hochgeladene Aufnahmen mit; die eine `[scope]`-Zeile ist da laengst
# gedruckt. Eine zweite `[scope]`-Zeile ginge nicht: beide Leser nehmen dort bewusst nur die
# erste (Haertung gegen ein Projekt namens "scope"). Additiv, nie ersetzend.
SCOPE_ADD_PREFIX = "[scope+] "
ACTIVE_PREFIX = "[active] "
DONE_PREFIX = "[done] "


def buche_aktive(aktive: dict, line: str, gesehen: set | None = None) -> None:
    """Eine Protokollzeile auf die Menge der GERADE bearbeiteten Aufnahmen anwenden.

    Herausgezogen aus `_run` (#418), damit ein Test dieselbe Regel fahren kann wie der
    Server. Nachgebaut im Test waere sie wertlos: genau daran ist #418 vorbeigelaufen —
    die vorhandenen Tests faelschen `cmd_diarize` mit einer stummen Attrappe und konnten
    deshalb nicht sehen, dass die echte Funktion die Aufnahme mit ihrem eigenen `[done]`
    freigibt, bevor sie in die Poolschlange kommt.

    Mehrere Drucker bedienen dieselbe Buchung (`transcribe.py`, `correct.py` in beiden
    Phasen), und dieselbe Aufnahme ist VERSCHACHTELT in ihnen aktiv — die Transkription
    haelt das Fenster, `cmd_diarize` und die KI-Korrektur je ein eigenes Paar darin. Als
    Menge hob jedes innere `[done]` die Marke des aeusseren Druckers auf: das Fenster
    zwischen zwei benachbarten Schreibvorgangen, gemessen 0,00 s, aber real (#452). Als
    ZAEHLER heben sie sich erst gemeinsam auf. Der Boden bei 0 ist der Nachfolger der
    alten `discard`-Idempotenz: ein unpaariges `[done]` bei Stand 0 ist folgenlos und
    vergiftet spaetere `[active]` nicht. Getragene Restgrenze: im VERSCHACHTELTEN Fenster
    (Stand >= 1) hebt ein unpaariges inneres `[done]` die aeussere Buchung frueher auf —
    erreichbar nur ueber eine verlorene/verstümmelte Marke (der Print ist einzeln
    zeilengebündelt), praktisch verstopft, aber nicht strukturell ausgeschlossen.

    `gesehen` ist die ZWEITE Menge und die Gegenrichtung: sie waechst nur (#475). Sie
    beantwortet "gehoerte zu diesem Lauf", nicht "wird gerade bearbeitet" - die Frage, an
    der seit #431 die Zustandsanzeige einer WAEHREND des Laufs hochgeladenen Aufnahme
    haengt. Das Frontend liest sie sonst aus der `[active]`-Zeile im Protokoll, und die ist
    nicht sicher: `fuege_zeile_an` deckelt den Puffer bei MAX_JOB_LINES und verdraengt
    Zeilen aus der MITTE. Ueber dem Deckel ueberlebt `[scope]` (die ersten zehn Zeilen sind
    geschuetzt), die `[active]`-Zeile nicht - das Urteil steht noch da und wird ohne
    Zulassung verworfen: der #431-Zustand, still zurueck. Die Zahlen dazu stehen NICHT hier,
    sondern in `test_gesehen_ueberlebt_den_zeilendeckel`: eine Zahl im Kommentar driftet
    unsichtbar, ein Test laeuft mit.

    `active_bases` kann das nicht leisten, obwohl es naheliegt und im Issue als Weg 1 stand -
    und zwar aus einem Grund, der von keiner Druckreihenfolge abhaengt: es ist eine
    LIVE-Menge, die Zulassung braucht eine MONOTONE. `jobPhases.test.ts` nagelt das als
    Vertrag fest ("behaelt die Zulassung ueber ein [done] hinweg"); dazu liest der Browser
    einen bis zu 1,5 s alten Schnappschuss und nach dem Lauf gar keinen mehr, waehrend das
    Urteil dauerhaft angezeigt bleiben muss. (Hier stand zuerst "die echte Reihenfolge ist
    [done] X VOR dem Urteil fuer X - gemessen". Das war FALSCH: gemessen war nur ein selbst
    gebauter Drucker, dessen Reihenfolge aus einer Testfixture stammte. Die echten Drucker
    machen es andersherum - `transcribe.py` druckt `fertig base` VOR `[done]`. Gefunden vom
    Review, und es ist genau die Fehlerklasse, die dieses Repo als seine haeufigste fuehrt.)
    """
    if line.startswith(ACTIVE_PREFIX):
        roh = line[len(ACTIVE_PREFIX):]
        if roh:
            aktive[roh] = aktive.get(roh, 0) + 1
        # BEIDE Mengen bekommen denselben UNGESTUTZTEN Namen (#477). Bis dahin buchte
        # `aktive` gestutzt, `gesehen` roh -- und genau diese Asymmetrie war der Riegel-Loch:
        # `aktive` treibt `betrifft()`, das gegen einen HTTP-Pfadparameter vergleicht, und
        # der kommt ROH an (`safe_name` laesst Randleerzeichen durch). Fuer eine Datei
        # " Probe" war `" Probe" in {"Probe"}` False -- der 409-Riegel griff fuer diese
        # Namensklasse nie, still. `gesehen` (Frontend-Rueckweg; die Endurteil-Regexe faengt
        # den Namen ROH aus der Zeile, `jobPhases.ts:348`) bucht schon seit #475 roh; jetzt
        # gilt fuer beide dasselbe Wort: der Schluessel ist der rohe Rest der Zeile. Die
        # Truthy-Pruefung spiegelt weiterhin die des Frontends (`if (b) gesehen.add(b)` auf
        # dem rohen `slice(9)`): ein Name aus lauter Leerzeichen ist dort wahr, hier auch.
        if gesehen is not None and roh:
            gesehen.add(roh)
    elif line.startswith(DONE_PREFIX):
        roh = line[len(DONE_PREFIX):]
        if roh:
            if aktive.get(roh, 0) <= 1:
                aktive.pop(roh, None)   # Boden 0 — Nachfolger der alten discard-Idempotenz
            else:
                aktive[roh] -= 1

_PROZENT_RE = re.compile(r"^\d+%(?:\||\s|$)")
MAX_JOB_LINES = 10_000


def ist_fortschrittszeile(zeile: str) -> bool:
    """Erkennt flüchtige tqdm-Fortschrittszeilen (z. B. '45%|...')."""
    return bool(_PROZENT_RE.match(zeile.strip()))


def fuege_zeile_an(lines: list, line: str) -> None:
    """Fügt eine Zeile an den Puffer an. Flüchtige Fortschrittszeilen (tqdm)
    werden in-place aktualisiert (#371)."""
    if lines and ist_fortschrittszeile(lines[-1]) and ist_fortschrittszeile(line):
        lines[-1] = line
        return
    if len(lines) >= MAX_JOB_LINES:
        # Erste 10 Zeilen (inkl. [scope]) schützen, älteste Zwischenzeile verwerfen
        del lines[10:11]
    lines.append(line)


def _popen_kwargs() -> dict:
    """Auf POSIX eine eigene Prozessgruppe — nur so erreicht der Abbruch spaeter auch die
    Kinder (whisper, claude). Auf Windows leistet das taskkill /T, siehe _kill_tree."""
    return {} if os.name == "nt" else {"start_new_session": True}

# Nur Whisper belegt die GPU dauerhaft und gross (large-v3, ganze Audiolaenge). `correct`
# haengt fast nur an Opus und braucht die GPU nur fuer den kurzen pyannote-Schritt — es hier
# mitzufuehren hiesse, dass eine 25-Minuten-Korrektur jede Transkription blockiert.
GPU_KINDS = ("transcribe",)

# Welche Job-Arten `[active]` ueberhaupt bedeuten duerfen - dieselbe Menge, die
# `jobPhases.ts` am Anfang seiner Schleife durchlaesst. Ohne diesen Filter buchte auch ein
# `fetch`-Lauf in `gesehen`, und genau dort kommt FREMDER Text in den Strom (yt-dlp-Rohausgabe,
# Videotitel eines importierten Videos). Der Parser liest `[active]` fuer diese Art bewusst
# nie; die Serverseite spiegelt das, statt ihm etwas zu schicken, was er wegwirft.
#
# GETRAGENE GRENZE, benannt statt behoben: `jobs.py` kennt den Fortschritts-Dialekt bewusst
# nicht (siehe SCOPE_PREFIX). In einem Projekt namens `active` praefixt `transcribe.py` JEDE
# Zeile mit `[active] `, und dann sammelt `gesehen` auch Zeilenbruchstuecke - das Frontend
# traegt dieselbe Verschmutzung seit #431 dokumentiert. Anzeige-Folgen hat das keine (die
# Muellschluessel treffen keinen Basisnamen), die Nutzlast je Poll waechst aber, und `gesehen`
# war bis K1 Glied 3 die einzige ungedeckelte Sammlung im Datensatz — seitdem gibt es mit
# `entfernt` eine zweite (gleiches Wachstum, gleiche Nutzlast-Frage). Siehe Issue.
ZULASSUNGS_KINDS = ("transcribe", "correct")

# Welche Job-Arten einen Bereichs-NACHTRAG drucken duerfen. Nur `transcribe_project` tut es
# (`correct.cmd_run` baut seine Liste einmal und scannt nicht neu), und `fetch` ist genau die
# Art, in der FREMDER Text im Strom steht — yt-dlp-Rohausgabe, Videotitel eines importierten
# Videos. Dieselbe Begruendung und dieselbe Form wie `ZULASSUNGS_KINDS` daruber; ein
# Injektionsweg ueber eine `fetch`-Zeile liess sich nicht demonstrieren, aber der Zweig war
# fuer diese Art scharf, ohne dass sie ihn je bedienen kann (Befund des kalten Diff-Lesers).
NACHTRAG_KINDS = ("transcribe",)

# Die Uebergabe an den Korrektur-Pool (#442). ZEICHENGLEICH mit dem Muster in
# `jobPhases.ts`, nicht-gierige Gruppe inklusive — damit die beiden Leser nicht auseinander
# laufen koennen, nicht weil die Gierigkeit hier etwas aendert. GEMESSEN: an
# `→ Eingereiht A (Korrektur) … (Korrektur) …` liefern gierig und nicht-gierig BEIDE
# `A (Korrektur) …`; der `$`-Anker zwingt in beiden Faellen das letzte Vorkommen als Endung.
# Die erste Fassung dieses Kommentars behauptete das Gegenteil.
#
# Der Basisname wird ROH genommen, mit Randleerzeichen — dieselbe Regel und derselbe Grund
# wie bei `gesehen` (#475/#477): `safe_name` laesst sie durch, und der Parser auf der anderen
# Seite fasst sie ebenfalls ungetrimmt. Gestutzt gebucht waere der Rueckweg fuer diese
# Namensklasse still wirkungslos.
#
# Dass hier ein ZWEITER Leser derselben Druckform entsteht, ist der Preis von #561 und
# gehoert benannt: aendert `transcribe.py` die Zeile, zwingt der Vertragstest das
# TS-Muster nach — dieses hier kennt er nicht. Der Riegel dagegen ist
# `test_eingereiht_muster_passt_auf_die_gedruckte_zeile`: er liest das Literal aus dem
# Quelltext von `transcribe.py` und laesst dieses Muster darauf laufen.
#
# NUR `transcribe` druckt sie (`NACHTRAG_KINDS` ist dieselbe Menge, aus demselben Grund wie
# bei `ZULASSUNGS_KINDS`: ein `fetch`-Lauf traegt FREMDEN Text im Strom). Dieselbe Menge
# schaltet auch den Gegenweg (`[done]` nimmt aus der Schlange heraus) — ein Lauf, dessen
# Einreih-Zeilen nicht zaehlen, darf seine Abschlussmarken erst recht nicht buchen.
EINGEREIHT_RE = re.compile(r"^→ Eingereiht (.+?) \(Korrektur\) …$")
EINGEREIHT_KINDS = ("transcribe",)


def _prune_locked():
    now = time.time()
    dead = [jid for jid, r in _jobs.items()
            if r["status"] in ("done", "error", "cancelled") and r.get("ended") and now - r["ended"] > _PRUNE_AGE]
    for jid in dead:
        _jobs.pop(jid, None)
    # Vorgaenge nach ANZAHL deckeln, nicht nach Alter: ein `vorgemerkt` hat kein `ended`, an
    # dem sich ein Alter messen liesse, und es darf beliebig lange warten (der Blocker
    # bestimmt, wie lange). Geworfen wird der aelteste ABGESCHLOSSENE — dict behaelt die
    # Einfuegereihenfolge, seit 3.7 zugesichert.
    #
    # NIEMALS ein offenes `vorgemerkt`: das ist per Konstruktion das aelteste (es wartet ja),
    # und ein rein zeitlicher Deckel haette ausgerechnet die Vormerkung geworfen, auf deren
    # Antwort noch jemand wartet — danach 404, und der Nachlauf faellt zurueck auf den
    # 4-Sekunden-Weg. Von zwei Pruefern unabhaengig gefunden (gegnerischer Subagent B3,
    # CodeRabbit-CLI major).
    #
    # Preis, benannt: gibt es NUR offene Vormerkungen, waechst die Menge ueber den Deckel.
    #
    # WORIN IHRE OBERGRENZE BESTEHT, HAT SICH MIT #557 GEAENDERT — hier stand bis dahin „die
    # Zahl verschiedener (Projekt, Art, Base) — dieselbe Menge, die `_pending` ohnehin haelt,
    # also nichts Neues", und beide Haelften stimmen seitdem nicht mehr. Solange Nummern
    # ausschliesslich in `request` entstanden, war jede offene an einen `_pending`-Schluessel
    # gebunden und je Schluessel gab es genau eine. `app.fetch_urls` ruft `vormerken` jetzt
    # bei JEDEM Import, und dieser Eintrag steht in keinem `_pending`. GEMESSEN: 250 Aufrufe
    # ergeben 250 offene Eintraege bei Deckel 200, 0 davon in `_pending`, bei EINEM
    # Schluessel — der alte Weg ergab bei fuenf Anfragen auf denselben Schluessel einen.
    #
    # Im Betrieb loest sich jede dieser Nummern auf (belegter Slot ⇒ sofort `verworfen`,
    # sonst ueber `then` bzw. dessen Gegenstueck `sonst`), gleichzeitig offen sind also nur
    # die Importe, die gerade laufen. Was sich geaendert hat, ist die SCHADENSSKALA eines
    # Lecks: ein liegengebliebener Eintrag kostete frueher hoechstens einen je Schluessel,
    # jetzt einen je Import. Der eine bekannte Leckweg (weitergereichtes `then`, dessen
    # Empfaenger scheitert) ist mit #579 zu — `sonst` wandert mit und quittiert dort.
    # Ein `gestartet`, dessen Job NOCH LAEUFT, ist genauso wenig raeumbar wie ein offenes
    # `vorgemerkt` — und das war es bis #557 nicht: die Bedingung fragte nur den Zustand der
    # VORMERKUNG, nicht den des Laufs. Der Grund, warum das jetzt zaehlt, ist die Ordnung:
    # geworfen wird der aelteste raeumbare, und ein Eintrag behaelt seine EINFUEGEposition,
    # auch wenn er erst spaeter `gestartet` wird — ein laufender Vorgang steht damit weit
    # vorn. Erreichbar wird das erst, seit `vormerken` je IMPORT einen Eintrag anlegt (siehe
    # oben); es braucht dafuer immer noch mehr als `_VORGAENGE_MAX` neue Eintraege, waehrend
    # der Lauf laeuft. Der Schaden waere der bekannte: `vorgang()` faende nichts, der Endpunkt
    # antwortete 404, die Oberflaeche liesse einen LAUFENDEN Job fallen — genau der stille
    # Ausfall, gegen den die Nummer gebaut ist. (CodeRabbit-Bot, major, hergeleitet.)
    #
    # Der Preis ist derselbe wie oben und schon benannt: sind alle Eintraege offen oder
    # laufend, waechst die Menge ueber den Deckel. Lieber zu gross als eine verlorene Nummer.
    def _noch_am_laufen(v):
        jid = v.get("job_id")
        return bool(jid) and (_jobs.get(jid) or {}).get("status") == "running"

    while len(_vorgaenge) > _VORGAENGE_MAX:
        raus = next((n for n, v in _vorgaenge.items()
                     if v["status"] != "vorgemerkt" and not _noch_am_laufen(v)), None)
        if raus is None:
            break
        _vorgaenge.pop(raus, None)
        # Ein Alias MUSS mit seinem Ziel gehen. Er bleibt `vorgemerkt` und ist damit oben
        # immun, sein Ziel wird `gestartet` und damit raeumbar — bliebe er allein zurueck,
        # zeigte er ins Leere: `vorgang()` faende nichts, der Endpunkt antwortete 404, und die
        # Oberflaeche liesse die Nummer fallen. Also genau der stille Ausfall, gegen den die
        # Nummer gebaut ist, durch die Hintertuer des Deckels. (CodeRabbit-Bot, major.)
        for n in [n for n, v in _vorgaenge.items() if v.get("alias") == raus]:
            _vorgaenge.pop(n, None)


def _vorgang_setzen(nummer, zustand, job_id=None):
    """Zustand einer Vormerkung fortschreiben. Aufrufer haelt `_lock` NICHT."""
    if not nummer:
        return
    with _lock:
        v = _vorgaenge.get(nummer)
        if v is None:
            return
        v["status"] = zustand
        if job_id is not None:
            v["job_id"] = job_id


def vormerken(project: str, kind: str, base: str | None = None) -> str:
    """Eine Vormerkung anlegen, BEVOR irgendetwas laeuft — und ihre Nummer zurueckgeben.

    `request` legt die Nummer erst an, wenn es den Slot belegt findet. Fuer den URL-Import
    reicht das nicht: dort entsteht der Transkriptions-Nachlauf in einem `then`-Rueckruf, also
    lange nachdem die Antwort des Endpunkts beim Browser war (#557). Der Rueckgabewert des
    Rueckrufs ist damit unlesbar, und die Oberflaeche erfuhr von diesem Nachlauf nie etwas.

    Die Nummer VOR dem Start anzulegen dreht das um: sie existiert, bevor der erste Prozess
    laeuft, kann also in der Antwort mitgehen. Sie wird ueber `request(..., vorgang=nummer)`
    weitergereicht; dort setzt `_vorgang_setzen` sie auf `gestartet`, sobald der Nachlauf
    wirklich anlaeuft, oder haengt sie als `alias` an eine bestehende Vormerkung.

    Kein `_prune_locked` hier: eine offene Vormerkung wird ohnehin nie geworfen (siehe dort),
    und ein Aufraeumlauf an dieser Stelle raeumte auf, bevor der Eintrag ueberhaupt steht.
    """
    nummer = uuid.uuid4().hex[:12]
    with _lock:
        _vorgaenge[nummer] = {"vorgang": nummer, "status": "vorgemerkt", "job_id": None,
                              "project": project, "kind": kind, "base": base}
    return nummer


def vorgang_verwerfen(nummer: str) -> bool:
    """Eine Vormerkung als `verworfen` schliessen — NUR solange sie noch offen ist.

    Der Riegel auf `vorgemerkt` ist Verteidigung gegen eine kuenftige Umordnung, NICHT gegen
    einen heute erreichbaren Ablauf — und hier stand bis zum gegnerischen Review das
    Gegenteil („tragend … auch dann, wenn der Nachlauf laengst angelaufen ist"). Gemessen: mit
    entferntem Riegel bleiben alle Flusstests gruen, rot wird nur der Test, der
    `_vorgang_setzen` von Hand ruft. Die Begruendung hat sich mit #579 GEAENDERT, das
    Ergebnis nicht: der einzige heutige Aufrufer, der ein `gestartet` treffen koennte, ist das
    `sonst` des URL-Imports — und `_run` fuehrt `then` und `sonst` desselben Auftrags nie
    beide aus. Vorher trug diese Stelle die Reihenfolge zwischen `next_runs` (Schritt 1) und
    `then` (Schritt 3) als Grund; beides sind Aussagen ueber `_run`, aber nicht dieselbe.

    EINE ZWEITE FASSUNG DIESES ABSATZES WAR SCHAERFER ALS DER CODE und ist hier korrigiert
    statt gestrichen: sie schrieb „nur `then` setzt die Nummer auf `gestartet` (ueber
    `request`)". Das stimmt fuer den URL-Import und fuer sonst nichts — `request` setzt
    `gestartet` SELBST, sobald der Lauf anlaeuft, und zwar bevor irgendein Rueckruf feuert.
    Ein ueber `request(vorgang=…, sonst=…)` gestarteter Job faende seine Nummer beim
    Scheitern also bereits auf `gestartet`, und dann ist dieser Riegel TRAGEND, nicht
    defensiv. Diesen Aufrufer gibt es heute nicht (`request(sonst=…)` ist nur durchgereicht);
    die Aussage gilt aber dem Mechanismus, nicht dem heutigen Aufruferkreis. (Zweiter
    Pruefer, B3.)

    Er bleibt also stehen — und ist je nach Weg Wache oder Riegel. Eine Wache, deren
    Bedingung heute nicht eintritt, gehoert benannt; eine, die auf einem gebauten Weg
    eintreten WUERDE, erst recht.

    Liefert True, wenn wirklich etwas geschlossen wurde — das macht den Zweig testbar, ohne
    den Zustand von aussen nachzulesen.
    """
    with _lock:
        v = _vorgaenge.get(nummer)
        if v is None or v.get("status") != "vorgemerkt":
            return False
        v["status"] = "verworfen"
        return True


def vorgang(nummer: str):
    """Der Zustand einer Vormerkung, oder None. Reiner Lesepfad fuer die Oberflaeche.

    Sie erfaehrt damit die Kennung des Nachlaufs, sobald er existiert — heute erfaehrt sie sie
    gar nicht: `request` liefert bei belegtem Slot die Kennung des BLOCKERS, und der KANN ueber
    die Einzel-GPU-Sperre einem fremden Projekt gehoeren (#381). „kann", nicht „oft": dass der
    Weg erreichbar ist, steht am Code (`start()` gibt fuer `GPU_KINDS` den laufenden Job eines
    BELIEBIGEN Projekts zurueck) — wie haeufig er vorkommt, hat niemand gemessen.

    Folgt einem `alias`: zwei Nummern koennen auf dieselbe Vormerkung zeigen, wenn im
    Sperrfenster von `rerun` eine andere Anfrage denselben Schluessel neu belegt hat (die
    Begruendung steht dort). Die Schleife ist gegen einen Ring gesichert — ein Zyklus waere
    hier ein Haenger UNTER dem Lock, also der teuerste Ausgang von allen."""
    with _lock:
        gesehen = set()
        v = _vorgaenge.get(nummer)
        while v is not None and v.get("alias") and v["alias"] not in gesehen:
            gesehen.add(v["alias"])
            v = _vorgaenge.get(v["alias"])
        return dict(v) if v else None


def transcribe_laeuft_oder_wartet(project: str) -> bool:
    """Laeuft im Projekt ein transcribe-Job — ODER ist einer vorgemerkt?

    Die zweite Haelfte ist der ganze Grund fuer diese Funktion (#496). `active_for` liest nur
    `_active`; ein bei belegtem Slot VORGEMERKTER Nachlauf steht dort nicht. Ein Korrekturlauf
    konnte deshalb genau in dieses Fenster hineinstarten und traf den Nachlauf spaeter an —
    zwei Laeufe, die einander mitkorrigieren, ueber den einen Weg, den `_laeuft_mitkorrektur`
    (#441) noch offen liess.

    Erreichbar ist das Fenster ueber die Einzel-GPU-Sperre: `start()` gibt fuer GPU_KINDS den
    laufenden Whisper-Job eines FREMDEN Projekts als Blocker zurueck (siehe dort). Dann hat
    Projekt P einen vorgemerkten Nachlauf, ohne dass in P ein transcribe-Job laeuft — und
    genau dann sieht die Oberflaeche fuer P auch nichts Laufendes.

    Fuer eine ENTSCHEIDUNG, nicht fuer eine Anzeige: die Antwort ist eine Momentaufnahme."""
    with _lock:
        for (proj, kind), jid in _active.items():
            if proj != project or kind != "transcribe":
                continue
            r = _jobs.get(jid)
            if r is not None and r["status"] == "running":
                return True
        return any(k[0] == project and k[1] == "transcribe" for k in _pending)


def start(project: str, cmd: list, cwd, kind: str, then=None, env=None, base: str = None,
          bases: set = None, sonst=None):
    """Startet den Job. `then` laeuft NACH erfolgreichem Abschluss (status 'done') im
    Job-Thread — damit haengt die Auto-Korrektur nach der Transkription nicht am Browser.
    `env` (dict) wird in die Subprozess-Umgebung gemischt; default None aendert nichts.

    `sonst` ist das GEGENSTUECK zu `then`: es laeuft genau dann, wenn dieses `then`
    endgueltig nicht laeuft. Es wandert mit dem `then` mit, wenn `_run` Schritt 2 es an
    einen Folge-Job weiterreicht — und darin liegt sein Zweck (#579). Vorher trug der
    Aufrufer diese Aufgabe selbst (`app._fetch_nachlauf_ausgang` ueber `when_done`), und
    das ging genau an der Weitergabe kaputt: der Rueckruf hing am Ausgang des ERSTEN
    Jobs, das `then` aber am Ausgang des ZWEITEN.

    Er liegt ab hier unter dem Lock im Datensatz. Damit gibt es das Fenster nicht mehr,
    das `when_done` offenliess (Job schon terminal, bevor der Aufrufer den Rueckruf
    anhaengen konnte)."""
    with _lock:
        _prune_locked()
        if (project, kind) in _active:
            return _active[(project, kind)], False
        if kind in GPU_KINDS:
            busy = next((jid for jid, r in _jobs.items()
                         if r["kind"] in GPU_KINDS and r["status"] == "running"), None)
            if busy is not None:
                return busy, False  # Einzel-GPU: nur ein Whisper-Lauf zugleich
        jid = uuid.uuid4().hex[:12]
        initial_bases = set(bases) if bases is not None else ({base} if base is not None else None)
        _jobs[jid] = {"id": jid, "project": project, "kind": kind, "status": "running",
                      # None = Wirkungsbereich noch unbekannt (Zeile noch nicht gedruckt)
                      # -> gilt als "faesst alles an". Siehe SCOPE_PREFIX.
                      "bases": initial_bases,
                      "active_bases": {},             # Zaehler je rohem Basisname (#452)
                      # Waechst nur, wird nie geraeumt - siehe buche_aktive (#475).
                      "gesehen": set(),
                      # Geloeschte Aufnahmen (remove_base) - die GEGENRICHTUNG zu `gesehen`:
                      # sie nimmt Urteile aus dem Strom, statt Anwesenheit zuzulassen
                      # (#479/#489). #490-ENTSCHEIDUNG: eine kuenftige serverseitige Heilung
                      # der perBase-Verdraengung muss `erreicht` UND diese Unterdrueckung
                      # mitnehmen — beides liegt damit schon serverseitig.
                      "entfernt": set(),
                      # Wer NOCH in der Korrektur-Schlange steht (#442/#561) — die DRITTE
                      # Wartequelle, und bis hierher die einzige ohne Rueckweg gegen den
                      # Zeilendeckel. LISTE, kein Set: ihre Reihenfolge IST die Schlangen-
                      # ordnung (der ThreadPoolExecutor arbeitet nach Submit-Reihenfolge),
                      # und `sorted()` wie bei `gesehen` zerstoerte genau die Auskunft, um
                      # die es geht („noch N vor dieser").
                      #
                      # Und anders als `gesehen`/`entfernt` waechst sie NICHT nur: die
                      # Einreih-Zeile legt an, `[done]` nimmt wieder heraus (beides in
                      # `_verarbeite`). Monoton gefuehrt haette der Rueckweg die sichere
                      # Richtung dieses Fehlers umgedreht — statt einer zu kleinen Zahl eine
                      # dauerhaft zu grosse, samt einer laengst fertigen Aufnahme, die fuer
                      # immer „wartet".
                      "eingereiht": [],
                      "lines": [], "returncode": None, "started": time.time(),
                      "ended": None, "pid": None, "cancelled": False,
                      "then": [then] if then else [],
                      "sonst": [sonst] if sonst else [],
                      # Von einem VORGAENGER uebernommen (`_run` Schritt 2), als PAARE
                      # `(then, sonst)`. Getrennt von den eigenen gefuehrt, weil sie eine
                      # andere Bedingung haben: ihr Ursprungsjob war erfolgreich, ihre Arbeit
                      # ist also geschuldet — der Ausgang DIESES Laufs entscheidet nur noch,
                      # ob sie nachgeholt (Fehler) oder zurueckgenommen wird (Abbruch).
                      #
                      # ALS PAAR, NICHT ALS ZWEI LISTEN, und das ist am ausgefuehrten Code
                      # belegt (kalter Diff-Leser, Befund 2): mit getrennten Listen feuerte
                      # EIN werfendes `then` ALLE geerbten `sonst` — auch die, deren `then`
                      # sauber durchgelaufen war. Gemessen hat er `sonstA` mit Rueckgabe True:
                      # es hat wirklich eine Vormerkung geschlossen, deren Nachlauf gerade
                      # anlief. Die naheliegende Reparatur (`zip`) traegt nicht — sie setzt
                      # index-parallele Listen voraus, und ein Job mit `then` ohne `sonst`
                      # bricht die Parallelitaet auf der Stelle.
                      "uebernommen": [],
                      "next_runs": []}
        _active[(project, kind)] = jid
    threading.Thread(target=_run, args=(jid, cmd, cwd, env), daemon=True).start()
    return jid, True


def request(project: str, cmd: list, cwd, kind: str, then=None, base: str = None,
            vorgang: str | None = None, sonst=None):
    """Startet den Job — oder merkt genau EINEN Nachlauf vor, wenn der Slot belegt ist.

    Ein Upload/Import soll immer zu einer Verarbeitung fuehren, auch wenn gerade eine laeuft:
    die kennt die eben hochgeladene Datei nicht. Ohne die _pending-Sperre wuerden fuenf
    Uploads fuenf Whisper-Laeufe hinter dem laufenden aufreihen — einer reicht, er sieht
    ohnehin alle inzwischen dazugekommenen Dateien.

    Liefert `(jid, started, vorgang)`. Bei `started` ist `jid` der gestartete Lauf; sonst ist
    `jid` die Kennung des BLOCKERS — die dem Aufrufer nichts nuetzt, weil sie ueber die
    Einzel-GPU-Sperre einem fremden Projekt gehoeren kann. Dafuer gibt es `vorgang`: eine
    Nummer, die der Vormerkung gehoert und unter der die Oberflaeche die Kennung des
    Nachlaufs erfaehrt, sobald er existiert (#381).

    `sonst` wird nur DURCHGEREICHT — an `start` und durch die Rekursion an `rerun`. Es hat
    heute so wenig einen Produktivaufrufer wie `then` (`grep -rn "jobs.request(" webtool/*.py`
    → zwei Aufrufer, keiner mit `then=` oder `sonst=`); es steht hier, damit ein kuenftiger
    Aufrufer sein Gegenstueck nicht STILL verliert. Der Preis ist benannt und NACHGEZAEHLT:
    **elf** Test-Attrappen tragen den Parameter, ohne ihn zu pruefen — `grep -c "sonst=None"`
    ueber `test_api.py` (6) und `test_jobs.py` (5). Der gegnerische Pruefer nannte acht (F4);
    die Richtung stimmte, die Zahl nicht.

    `vorgang` als PARAMETER ist der Weg durch die Rekursion: `rerun` ruft `request` erneut,
    und ist der Slot dann wieder belegt, entstuende sonst eine ZWEITE Nummer fuer denselben
    Schluessel — die erste, die die Oberflaeche kennt, bliebe ewig `vorgemerkt`. Am echten
    Ablauf getraced (Q blockt P und R, danach blockt P das R): add-Zaehlung 2 fuer denselben
    Schluessel, der zweite aus dem `_run`-Faden.
    """
    key = (project, kind, base)
    nummer = vorgang
    for _ in range(10):
        if base is not None:
            jid, started = start(project, cmd, cwd, kind, then=then, base=base, sonst=sonst)
        else:
            jid, started = start(project, cmd, cwd, kind, then=then, sonst=sonst)
        if started:
            # Traegt der Aufruf eine Nummer, ist er der Nachlauf DIESER Vormerkung — hier
            # erfaehrt die Oberflaeche die Kennung, auf die sie wartet.
            _vorgang_setzen(nummer, "gestartet", job_id=jid)
            return jid, True, nummer
        with _lock:
            if key in _pending:
                # schon vorgemerkt -> der Nachlauf nimmt die neuen Dateien mit. Der Aufrufer
                # bekommt die BESTEHENDE Nummer, nicht eine neue: es ist dieselbe Vormerkung.
                bestehende = _pending[key]
                if nummer is not None and nummer != bestehende:
                    # Wir kommen aus `rerun` und bringen eine Nummer mit — aber zwischen dem
                    # `pop` dort und dieser Zeile liegen DREI getrennte Sperr-Erwerbe, und in
                    # dem Fenster hat eine andere Anfrage denselben Schluessel neu belegt.
                    # Ohne diesen Zweig bliebe unsere Nummer fuer immer `vorgemerkt`, und die
                    # Oberflaeche fragte sie fuer die Lebensdauer des Tabs alle 1,5 s ab —
                    # ein Dauerpoll auf eine Nummer, die nie wieder etwas meldet.
                    # Ausgefuehrt reproduziert (kalter Pruefer, `N1 ORPHANED`).
                    # Beide zeigen jetzt auf DIESELBE Vormerkung.
                    v = _vorgaenge.get(nummer)
                    if v is not None:
                        v["alias"] = bestehende
                return jid, False, bestehende
            if nummer is None:
                nummer = uuid.uuid4().hex[:12]
            _pending[key] = nummer
            _vorgaenge.setdefault(nummer, {"vorgang": nummer, "status": "vorgemerkt",
                                           "job_id": None, "project": project,
                                           "kind": kind, "base": base})

        def rerun(_key=key, _jid=jid, _nummer=nummer):
            # Die Vormerkung wird IMMER geraeumt, der Neustart nur ausserhalb eines Abbruchs —
            # und die Reihenfolge ist der ganze Punkt. Bliebe der Schluessel liegen, waere der
            # Weg DAUERHAFT vergiftet: die Zeile `if key in _pending: return jid, False` weiter
            # oben steigt dann sofort aus, OHNE einen neuen Nachlauf zu registrieren. Gemessen —
            # nach einem Abbruch lag `('P','correct',None)` noch im Set, und jeder spaetere
            # Upload waehrend eines laufenden Laufs desselben Projekts wurde still verworfen,
            # bis zum Neustart des Servers. Es war also nicht EIN verlorener Nachlauf, sondern
            # jeder folgende.
            #
            # Der Abbruch-Riegel sitzt HIER und nicht in `_run`: dort ist der Schluessel nicht
            # bekannt (er steckt in diesem Abschluss), und ein Aufraeumen ueber `(projekt, art)`
            # traefe auch Vormerkungen fremder Basisnamen. Ein Abbruch ist eine Entscheidung —
            # denselben Lauf danach neu zu starten waere das Gegenteil dessen, worum gebeten
            # wurde; seine Vormerkung zu behalten waere schlicht ein Leck.
            #
            # ER GILT ABER NUR FUER DIE EIGENE ARBEIT, und das ist keine Feinheit: `start()`
            # gibt fuer `GPU_KINDS` den laufenden Whisper-Job eines BELIEBIGEN Projekts als
            # Blocker zurueck (Einzel-GPU, siehe `GPU_KINDS` in `start()`) — `_jid` ist dann ein
            # FREMDER Job. Ohne
            # den Projekt-/Art-Vergleich nahm der Abbruch von Projekt Q den vorgemerkten Lauf
            # von Projekt P mit, ueber das der Nutzer gar nichts gesagt hat: dessen eben
            # hochgeladene Aufnahme wurde nie transkribiert, ohne eine Zeile darueber.
            # Gemessen (Codex-Gegenreview): `gestartete Jobs: [('Q', …)]`, P fehlte.
            # „Ein Abbruch ist eine Entscheidung" gilt fuer die abgebrochene Arbeit; fuer alles,
            # was bloss dahinter in der Schlange stand, ist er eine fremde Nachricht.
            #
            # `base` wird BEWUSST nicht verglichen: innerhalb desselben (Projekt, Art) ist der
            # Blocker per Dedupe genau der Lauf, den der Nutzer gemeint hat.
            with _lock:
                _pending.pop(_key, None)
                blocker = _jobs.get(_jid) or {}
                abgebrochen = (blocker.get("status") == "cancelled"
                               and blocker.get("project") == project
                               and blocker.get("kind") == kind)
            if abgebrochen:
                # Der Nutzer hat DIESE Arbeit abgebrochen — der Vorgang ist damit erledigt,
                # nicht offen. Ohne diese Zeile fragte die Oberflaeche eine Nummer ab, die nie
                # wieder etwas meldet.
                _vorgang_setzen(_nummer, "verworfen")
                return
            # Die Nummer reist MIT: sonst legt der Aufruf bei erneuter Blockierung eine zweite
            # an, und die erste bleibt fuer immer `vorgemerkt` (siehe Docstring).
            request(project, cmd, cwd, kind, then=then, base=base, vorgang=_nummer, sonst=sonst)

        if when_done(jid, rerun):
            return jid, False, nummer
        with _lock:                       # jid wurde eben terminal -> Slot frei, gleich nochmal
            _pending.pop(key, None)
        time.sleep(0.05)
    print(f"Nachlauf fuer {project!r}/{kind} aufgegeben: Slot blieb belegt", file=sys.stderr)
    # Bisher endete dieser Weg nur in einer stderr-Zeile, die der Nutzer nie sieht.
    _vorgang_setzen(nummer, "aufgegeben")
    return None, False, nummer


def when_done(job_id: str, fn) -> bool:
    """Haengt `fn` an einen LAUFENDEN Job. False, wenn er unbekannt oder schon terminal ist —
    dann muss der Aufrufer selbst entscheiden (z.B. sofort erneut versuchen).

    **`fn` feuert bei JEDEM terminalen Ausgang — `done`, `error` UND `cancelled`.** Das ist
    nicht der Vertrag von `then` (das bleibt auf `done`) und war bis #417 auch nicht der von
    hier; wer den Rueckruf nur bei Erfolg laufen lassen will, fragt den Status SELBST ab.
    Der einzige Produktivaufrufer ist wieder `request`s `rerun`, und er fragt selbst. Der
    zweite (`app._fetch_nachlauf_ausgang`, #557) ist mit #579 weggefallen: er baute von
    aussen nach, was `then` ein Gegenstueck fehlte, und ging genau daran kaputt, dass ein
    weitergereichtes `then` am Ausgang eines ANDEREN Jobs haengt. Das kann ein Rueckruf, der
    an einer Job-Kennung haengt, nicht sehen — deshalb steht die Quittung jetzt als `sonst`
    im Datensatz und wandert mit. Wer hier einen anhaengt, fragt den Status ebenfalls selbst;
    wer eine Quittung fuer ein `then` braucht, nimmt `sonst` und nicht diese Funktion.

    Der Grund fuer den weiten Vertrag steht in `_run`: `rerun` raeumt seine Vormerkung aus
    `_pending`, und die muss auch nach einem Abbruch weg, sonst ist der Nachlauf-Weg dauerhaft
    vergiftet."""
    with _lock:
        r = _jobs.get(job_id)
        if r is None or r["status"] != "running":
            return False
        r.setdefault("next_runs", []).append(fn)
        return True


def _run(jid, cmd, cwd, env):
    _run_proc(jid, cmd, cwd, env)
    # Nachlauf AUSSERHALB von _run_proc: dessen finally hat den Slot in _active schon
    # freigegeben, sonst wuerde ein `then`, das denselben Projekt-Job startet, sich selbst
    # aussperren. Und ausserhalb von _lock, sonst blockiert es jobs.start() im Callback.
    # DREI Rueckrufarten, DREI Vertraege — `then` und `next_runs` hingen bis #417 an derselben
    # Bedingung (`status != "done"` -> return), und das war eine Verwechslung mit Datenverlust:
    #
    # `then` heisst „bei Erfolg weiter in der Kette". Der einzige Produktivnutzer ist
    # `app.fetch_urls` (fetch -> transcribe); eine Transkription ueber Dateien, die gar nicht
    # geladen wurden, waere sinnlos. Bleibt auf `done`.
    #
    # `sonst` heisst „mein `then` laeuft endgueltig nicht, raeum auf" (#579). Es ist an das
    # `then` gebunden, nicht an diesen Job: wird das `then` unten weitergereicht, wandert es
    # mit. Deshalb kann es nicht in `next_runs` liegen — die haengen an DIESEM Job.
    #
    # `next_runs` heisst „ich will von JEDEM Ausgang wissen" und traegt genau EINE Sache:
    # „jemand anders braucht einen Lauf, du warst besetzt" (`request`s `rerun`). Die zweite,
    # die #557 hier einhaengte („schliesse meine Vormerkung, falls du nicht gelingst"), ist
    # mit #579 als `sonst` in den Datensatz gewandert — sie gehoerte nie hierher: `next_runs`
    # haengt an DIESEM Job, die Quittung eines `then` aber an dem Job, bei dem das `then`
    # am Ende landet. Ein `fetch`-Job hat damit auch wieder keinen Eintrag hier.
    #
    # Der `rerun`-Fall ist der Weg, auf dem ein Upload WAEHREND eines laufenden Laufs
    # ueberhaupt verarbeitet wird. Der Ausgang DIESES Laufs ist dafuer ohne Bedeutung:
    # der Nachlauf haengt an einer FREMDEN Datei. Endete der laufende Job rot, ging er
    # ersatzlos verloren und die eben hochgeladene Aufnahme wurde nie transkribiert, ohne
    # eine Zeile darueber. Das Loch gibt es seit es `request` gibt (ein Absturz beim
    # Modell-Laden reichte); erreichbar wurde es mit #417, seit ein blosser Anbieterausfall
    # den Lauf rot enden laesst — und der ist Alltag, ein Absturz nicht.
    #
    # `cancelled` gehoert zu `next_runs` DAZU, obwohl danach nichts neu starten soll: der
    # Rueckruf raeumt seine Vormerkung aus `_pending`, und die muss auch nach einem Abbruch
    # weg (sonst ist der Weg dauerhaft vergiftet — die Begruendung samt Messung steht in
    # `request.rerun`, wo der Schluessel bekannt ist). Ob er danach neu startet, entscheidet
    # er selbst. Hier stehenzubleiben hiesse, den Riegel an der Stelle zu setzen, an der die
    # noetige Information fehlt.
    with _lock:
        r = _jobs.get(jid)
        if not r:
            return
        next_runs = list(r.get("next_runs", []))
        erfolg = r["status"] == "done"
        abgebrochen = r["status"] == "cancelled"
        # Die EIGENEN Rueckrufe haengen am Ausgang dieses Laufs: `then` bei Erfolg, `sonst`
        # sonst. Die UEBERNOMMENEN haengen am Ausgang ihres Ursprungsjobs, und der war
        # erfolgreich — sonst waeren sie nie weitergereicht worden (die Weitergabe unten
        # laeuft nur bei `erfolg`). Fuer sie entscheidet dieser Lauf deshalb nur noch, ob
        # die geschuldete Arbeit NACHGEHOLT oder ZURUECKGENOMMEN wird:
        #
        #   Fehler   -> nachholen. Der Download des Vorgaengers liegt auf der Platte; ihn
        #               liegenzulassen, weil ein FREMDER Folgeauftrag scheiterte, waere
        #               genau der Verlust aus #579. WAS DAS NEU ERLAUBT: `cancel_all()` fasst
        #               nur Jobs mit Status `running` an — ein Job, der gerade `error` wurde
        #               und hier steht, ist keiner mehr. Sein geerbtes `then` kann also NACH
        #               dem Herunterfahren noch einen Whisper-Lauf starten. Sehr schmal (es
        #               braucht die ganze Kette PLUS das Beenden in genau diesem Moment) und
        #               keine neue Klasse: `request.rerun` startet auf demselben Weg schon
        #               seit #417 nach einem Fehlschlag neu. (Gegnerischer Pruefer, F9.)
        #   Abbruch  -> zuruecknehmen (Entscheidung Marcus, 2026-09-08). „Ein Abbruch ist eine
        #               Entscheidung" steht auch in `request.rerun` — der Verweis ist aber nur
        #               zur HAELFTE ein Praezedenzfall, und die andere Haelfte gehoert genannt:
        #               `rerun` unterdrueckt den Nachlauf ausschliesslich bei GLEICHEM Projekt
        #               UND gleicher Art und sagt fuer alles andere ausdruecklich, ein Abbruch
        #               sei „eine fremde Nachricht". Hier gilt die erste Haelfte (der
        #               Empfaenger ist per `_active`-Schluessel dasselbe Paar), die zweite
        #               spricht dagegen: das geerbte `then` gehoert einem ANDEREN Import.
        #               GETRAGENER PREIS, benannt statt versteckt: bricht der Nutzer den
        #               zweiten Import ab, bleibt die schon geladene Tonspur des ersten
        #               unverarbeitet liegen, bis irgendetwas den naechsten Lauf ausloest —
        #               ohne eine Zeile darueber. Dagegen steht der Herunterfahr-Fall:
        #               `cancel_all()` bricht ALLE laufenden Jobs ab, ein hier gestarteter
        #               Nachlauf waere eine Waise mit belegter GPU. (Gegnerischer Pruefer, F2.)
        # Alles als PAARE `(then, sonst)`. `start` legt je hoechstens einen an; die Schleife
        # ueber die laengere der beiden Listen deckt auch ein `sonst` ohne `then` ab, statt es
        # still fallenzulassen.
        eigenes_then = list(r.get("then", []))
        eigenes_sonst = list(r.get("sonst", []))
        eigene_paare = [(eigenes_then[i] if i < len(eigenes_then) else None,
                         eigenes_sonst[i] if i < len(eigenes_sonst) else None)
                        for i in range(max(len(eigenes_then), len(eigenes_sonst)))]
        geerbte_paare = list(r.get("uebernommen", []))
        #
        # DASS DIESER SCHNAPPSCHUSS UNTEN NOCH GILT, haengt an einer Invariante, die nirgends
        # sonst steht (gegnerischer Pruefer, F7): `_run_proc`s `finally` nimmt den Job aus
        # `_active`, BEVOR dieser Block laeuft — und Schritt 2 eines fremden Jobs schreibt nur
        # in Datensaetze, die in `_active` stehen. Wer einen Job kuenftig bis zum Ende der
        # Rueckrufe in `_active` HAELT (naheliegend, damit `betrifft()` die Nachlaufphase
        # abdeckt — die Richtung von #451), verliert damit still jeden hier angehaengten
        # Rueckruf. Kein Test bekaeme das rot.
        project = r["project"]
        kind = r["kind"]

    # 1. Zuerst Folge-Läufe (rerun) ausführen, um den nächsten Batch-Teilschritt zu starten
    for fn in next_runs:
        try:
            fn()
        except Exception as e:
            with _lock:
                r = _jobs.get(jid)
                if r is not None:
                    fuege_zeile_an(r["lines"], f"NACHLAUF-FEHLER: {e}")

    # 2. Prüfen, ob noch Folge-Läufe für (Projekt, Art) aktiv oder vorgemerkt sind
    weitergereicht = False
    with _lock:
        folge_jid = _active.get((project, kind))
        hat_pending = any(k[0] == project and k[1] == kind for k in _pending)
        # NUR bei Erfolg weiterreichen. Fuer `then` ist das ein No-op (die Liste ist sonst
        # ohnehin leer), fuer `sonst`/`then_ueber` waere es der Unterschied zwischen
        # „nachholen" und „ein zweites Mal verschieben": ein gescheiterter Lauf hat seine
        # Rueckrufe hier und jetzt abzuarbeiten, nicht an den naechsten zu vererben.
        if erfolg and (folge_jid or hat_pending) and folge_jid != jid:
            # Nachlauf existiert -> `then` an den Folge-Job weiterreichen, damit autocorrect
            # erst nach Abschluss ALLER Transkriptionen des Projekts feuert (#Option1)
            if folge_jid and folge_jid in _jobs:
                folge = _jobs[folge_jid]
                # Das PAAR wandert, nie eine Haelfte allein — sonst haette der Empfaenger ein
                # geschuldetes `then` ohne Weg, dessen Ausfall zu quittieren (oder umgekehrt).
                #
                # Die Dedupe haengt am `then` und prueft BEIDE Ziellisten. Der EINE Fall, in
                # dem sie greift, ist `request`s `rerun`: es reicht dasselbe `then`-Objekt an
                # den Folge-Job weiter, das steht dort also schon. GETRAGENE GRENZE: scheitert
                # genau DER Job, faellt das `then` mit ihm (es liegt in seiner EIGENEN Liste).
                # Heute unerreichbar — `request(then=…)` hat keinen Produktivaufrufer.
                schon_da = list(folge["then"]) + [t for t, _ in folge["uebernommen"]]
                for paar in eigene_paare + geerbte_paare:
                    if paar[0] is not None and paar[0] in schon_da:
                        continue
                    folge["uebernommen"].append(paar)
                    schon_da.append(paar[0])
                weitergereicht = True

    # 3. Wenn die Kette komplett abgeschlossen ist: die faelligen Rueckrufe ausführen.
    #    Hat Schritt 2 weitergereicht, passiert hier gar nichts mehr — die Paare gehoeren
    #    dann dem Empfaenger.
    #
    #    HIER STAND EINE REIHENFOLGE-BEGRUENDUNG, und sie ist mit der Paarbildung
    #    GEGENSTANDSLOS geworden: „`then` vor `sonst`, sonst verwirft die Quittung eine
    #    gerade angelaufene Nummer" rettete den Fall, in dem ein `then` und ein FREMDES
    #    `sonst` dieselbe Vormerkung trafen. Mit Paaren kann das nicht mehr entstehen —
    #    jedes `sonst` gehoert genau einem `then` und feuert nur, wenn GENAU DAS ausfaellt.
    #    Der zweite Pruefer hatte die Ordnung als tragend-und-ungetestet gemeldet (B4); die
    #    bessere Antwort war, sie ueberfluessig zu machen statt sie zu testen.
    def _rufe(fn) -> bool:
        try:
            fn()
            return True
        except Exception as e:
            with _lock:
                rec = _jobs.get(jid)
                if rec is not None:
                    fuege_zeile_an(rec["lines"], f"NACHLAUF-FEHLER: {e}")
            return False

    # EIN `then`, DAS WIRFT, HAT SEIN ZIEL GENAUSO WENIG ERREICHT wie eines, das gar nicht
    # laeuft — also gehoert die Quittung auch hierher (CodeRabbit-CLI, minor). Ohne das
    # bleibt die Vormerkung des URL-Imports haengen, wenn `_start_transcribe` stirbt, und
    # `jobs.start` KANN werfen (`app.py` benennt den Faden-Start ausdruecklich als Wurfstelle).
    # Das Loch ist VORBESTEHEND und derselben Klasse wie #579; vorher gab es nur nichts, was
    # man haette nachziehen koennen. Ist das `then` unterwegs schon durchgekommen (`request`
    # hat `gestartet` gesetzt), prallt die Quittung am Riegel in `vorgang_verwerfen` ab —
    # genau dafuer ist er da.
    #
    # UND SIE GEHOERT ZU GENAU DIESEM `then`, nicht zu allen. Der erste Entwurf fuehrte zwei
    # getrennte Listen und feuerte bei EINEM werfenden `then` ALLE geerbten `sonst` — auch
    # die, deren `then` sauber durchlief. Der kalte Diff-Leser hat das AUSGEFUEHRT: `sonstA`
    # gab True zurueck, es hatte also wirklich eine Vormerkung geschlossen, deren Nachlauf
    # gerade anlief. Genau der Schaden, gegen den dieser PR gebaut ist, durch die Tuer, die
    # er selbst aufgemacht hatte.
    def _paar(then_fn, sonst_fn, then_faellig: bool) -> None:
        """Je Paar laeuft GENAU EINES: das `then`, oder — faellt es aus — sein `sonst`.

        „Faellt aus" heisst dreierlei: nicht faellig (der Ausgang gibt es nicht her), gar
        nicht vorhanden, oder geworfen. Der dritte Fall ist der, den man vergisst.
        """
        if then_faellig and then_fn is not None and _rufe(then_fn):
            return
        if then_faellig and then_fn is None:
            return                      # nichts geschuldet, also nichts zu quittieren
        if sonst_fn is not None:
            _rufe(sonst_fn)

    if not weitergereicht:
        for then_fn, sonst_fn in eigene_paare:
            _paar(then_fn, sonst_fn, then_faellig=erfolg)
        for then_fn, sonst_fn in geerbte_paare:
            # Der Ursprungsjob war erfolgreich, sonst gaebe es das Paar hier nicht. Nur ein
            # ABBRUCH nimmt die geschuldete Arbeit zurueck; ein Fehlschlag holt sie nach.
            _paar(then_fn, sonst_fn, then_faellig=not abgebrochen)


def _run_proc(jid, cmd, cwd, env=None):
    try:
        # settings.job_env() reicht die Whisper-Einstellungen durch: die .env laedt nur
        # webtool.ps1, in der Desktop-App gibt es keine. `env` (z.B. TRANSKRIBOR_FETCH_SPRACHE)
        # gewinnt gegen beide — der pro-Job-Wert ist spezifischer als der systemweite.
        full_env = {**os.environ, **settings.job_env(),
                    "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8",
                    **(env or {})}
        proc = subprocess.Popen(
            # stderr AM EIGENEN FADEN (#481), nicht mehr in stdout gemergt: tqdm schreibt
            # \r-Fragmente OHNE Zeilenende, und eine stdout-Marke, die auf gemergter Pipe in
            # ein offenes Fragment fiel, kam als `5%|… [done] X` an — discard ins Leere,
            # Aufnahme bis Jobende gesperrt. Getrennte Ströme teilen sich keine Zeile mehr;
            # das Fragment bleibt im Protokoll (Prozentquelle von jobPhases.ts). Gezahlter
            # Preis: die Reihenfolge zwischen den Strömen ist nicht mehr die des Kernels.
            cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace", bufsize=1,
            creationflags=_CREATE_NO_WINDOW, env=full_env, **_popen_kwargs(),
        )
        with _lock:
            _jobs[jid]["pid"] = proc.pid
            _jobs[jid]["proc"] = proc            # Handle für cancel() (nicht via get() ausgeliefert)
            cancelled = _jobs[jid]["cancelled"]
            # Einmal gelesen, die Art aendert sich ueber den Lauf nicht.
            zulassung = (_jobs[jid]["gesehen"]
                         if _jobs[jid]["kind"] in ZULASSUNGS_KINDS else None)
            nachtrag_an = _jobs[jid]["kind"] in NACHTRAG_KINDS
            eingereiht_an = _jobs[jid]["kind"] in EINGEREIHT_KINDS
        if cancelled:                            # cancel() kam an, bevor die pid gesetzt war -> selbst killen
            _kill_tree(proc)

        def _verarbeite(line):
            line = line.rstrip("\n")
            with _lock:
                fuege_zeile_an(_jobs[jid]["lines"], line)
                # Die Einreih-Zeile serverseitig buchen (#561) — NEBEN der if/elif-Kette
                # darunter, nicht als weiterer Zweig darin: die Kette entscheidet, wer
                # `buche_aktive` sieht, und diese Zeile soll daran nichts aendern.
                #
                # Der Server sieht jede Zeile, BEVOR sie in den gedeckelten Puffer wandert —
                # genau das ist der Rueckweg. `fuege_zeile_an` verdraengt bei MAX_JOB_LINES
                # aus der MITTE (geschuetzt sind nur die ersten zehn), und an einem echten
                # Lauf sind 10.560 Zeilen gemessen (#475): faellt eine Einreih-Zeile heraus,
                # verschwand die Aufnahme bisher aus der Schlange und die Zahl aller uebrigen
                # sank um eins.
                if eingereiht_an and (_m := EINGEREIHT_RE.match(line)):
                    liste = _jobs[jid]["eingereiht"]
                    # Dubletten verwerfen, wie der Parser: ihre Wirkung waere still und
                    # dauerhaft — jeder Nachfolger rutschte um eins, aus „noch 1 vor dieser"
                    # wuerde „noch 2".
                    if _m.group(1) not in liste:
                        liste.append(_m.group(1))
                elif eingereiht_an and line.startswith(DONE_PREFIX):
                    # Der GEGENWEG, und ohne ihn dreht der Rueckweg oben die sichere Richtung
                    # um (CodeRabbit-CLI, major): faellt spaeter auch die Abschlusszeile aus
                    # dem Puffer, haelt die Serverliste die Aufnahme fuer immer als „wartend"
                    # und schiebt jede nachfolgende Position um eins nach hinten. Vor #561 war
                    # die Zahl nur zu KLEIN — das waere zu GROSS gewesen, und dauerhaft.
                    #
                    # `[done] {base}` ist die Abschlussmarke der Aufnahme, nicht `apply:`:
                    # letzteres hat DREI Formen (edit.json / SKIP / FEHLT), also drei Muster,
                    # die neben `jobPhases.ts` her driften koennten. `[done]` liest dieselbe
                    # Zeile, die `buche_aktive` schon zerlegt, in derselben ROHEN Form (#477).
                    #
                    # Die REIHENFOLGE traegt es, nicht eine Zusicherung: `cmd_diarize` druckt
                    # sein eigenes `[active]`/`[done]`-Paar im HAUPTlauf, also VOR
                    # `ai_pool.submit` — zu dem Zeitpunkt steht die Base gar nicht in der
                    # Liste, das Entfernen ist ein No-op. Jedes `[done]` NACH der Einreih-Zeile
                    # kommt aus `correct_ai_single`s `finally` oder dem Rueckruf, und beide
                    # feuern erst, wenn die Korrektur vorbei ist (`transcribe.py:_freigeben`).
                    #
                    # Der Parser darf eine entfernte Base nicht wieder einsetzen, und das ist
                    # eine BEDINGUNG an ihn, keine Folge der Chronologie: hier stand zuerst
                    # „ist das `[done]` verdraengt, ist die aeltere Einreih-Zeile es zwingend
                    # auch" — schaerfer als der Code (gegnerischer Pruefer, F6). `fuege_zeile_an`
                    # verdraengt zwar chronologisch, nimmt aber `lines[10:11]`: die ersten ZEHN
                    # Zeilen bleiben fuer immer stehen, und dort liegt die erste Einreih-Zeile
                    # eines Laufs (gemessen Index 8). `jobPhases.ts` nimmt den Zeilenpfad
                    # deshalb nur noch, wenn das Feld GANZ fehlt (aelterer Server); die
                    # Begruendung steht dort bei `serverKennt`.
                    roh = line[len(DONE_PREFIX):]
                    liste = _jobs[jid]["eingereiht"]
                    if roh in liste:
                        liste.remove(roh)
                # Nur die ERSTE Zeile zaehlt: der Lauf druckt sie, bevor er arbeitet, und
                # spaeter kaeme sie hoechstens aus Transkripttext, der so beginnt.
                if _jobs[jid]["bases"] is None and line.startswith(SCOPE_PREFIX):
                    _jobs[jid]["bases"] = {b for b in line[len(SCOPE_PREFIX):].split("\t") if b}
                # Nachtrag: NUR wenn der Erstbereich schon steht. Ohne ihn gibt es nichts zu
                # ergaenzen, und ein Nachtrag als Erstbereich waere eine Zusage, die der Lauf
                # nie gegeben hat — `bases is None` heisst fuer `betrifft()` "allumfassend",
                # also die vorsichtige Seite; ein halber Bereich waere die unvorsichtige.
                #
                # Gleichzeitig die REAKTIVIERUNG von `entfernt` (#479/#489) — und zwar HIER
                # und nicht im Parser: ein parser-seitiges Lift an der Marke war ordnungsblind
                # (Review W1 zu K1 Glied 3): im zweiten Loeschzyklus stand die Marke des
                # ERSTEN Reuploads noch im Puffer, hob beim Replay die frisch gebuchte
                # Unterdrueckung der ZWEITEN Loeschung auf, und die Aufnahme dahinter erbte
                # wieder ein Fremd-Urteil (am echten Parser gemessen: erreicht 'edit' ueber
                # Nur-Audio). Der Server sieht jede Zeile, BEVOR sie in den gedeckelten Puffer
                # wandert — sein discard ist deckelfest und gilt ab EINTREFFEN der Marke; der
                # Parser tilgt an derselben Marke alles bis dahin und braucht kein Lift mehr.
                elif (nachtrag_an and _jobs[jid]["bases"] is not None
                      and line.startswith(SCOPE_ADD_PREFIX)):
                    _jobs[jid]["bases"].update(
                        b for b in line[len(SCOPE_ADD_PREFIX):].split("\t") if b)
                    for b in line[len(SCOPE_ADD_PREFIX):].split("\t"):
                        if b:
                            _jobs[jid]["entfernt"].discard(b)
                            # ... und aus der Korrektur-Schlange, aus einem Grund, den erst
                            # #561 geschaffen hat (gegnerischer Pruefer, F2): eine geloeschte
                            # und gleichnamig neu hochgeladene Aufnahme wird vom Pool HINTEN
                            # angehaengt, ihre zweite Einreih-Zeile faellt aber am
                            # Dublettenriegel oben aus — sie behielte also ihren ALTEN Platz.
                            # Vorher heilte das der Deckel von selbst (war die alte Zeile
                            # verdraengt, galt die neue); jetzt steht die Serverliste VORN und
                            # nagelte den alten Platz bis Jobende fest.
                            #
                            # Entfernen statt Umsortieren: den neuen Platz kennt erst die
                            # zweite Einreih-Zeile, und die kommt, sobald der Pool sie hat.
                            # Bis dahin lieber keine Auskunft als eine falsche — dieselbe
                            # sichere Richtung wie `imBereich` im Frontend.
                            #
                            # NUR hier, nicht zusaetzlich im Parser (so lautete die Empfehlung
                            # des Pruefers) — am echten `jobPhases.ts` gemessen: die
                            # Vorbelegung steht vorn, und der `includes`-Riegel des
                            # Zeilenparsers laesst die ueberlebende ALTE Zeile nicht wieder
                            # nach vorn. Mit Serverwert kommt `["B","A"]` heraus (Schlange
                            # B vor A), ohne ihn `["A","B"]` — also genau der Vorzustand, kein
                            # neuer Fehler. Ein zweiter Ort fuer dieselbe Regel waere die
                            # Drift, gegen die dieses Repo sonst ueberall argumentiert.
                            if b in _jobs[jid]["eingereiht"]:
                                _jobs[jid]["eingereiht"].remove(b)
                else:
                    buche_aktive(_jobs[jid]["active_bases"], line, zulassung)

        def _lese_stderr():
            try:
                for line in proc.stderr:
                    _verarbeite(line)
            except Exception as e:   # dasselbe Muster wie der Hauptpfad: kein Zombie 'running'
                with _lock:
                    r = _jobs.get(jid)
                    if r is not None:
                        fuege_zeile_an(r["lines"], f"JOB-FEHLER: {e}")
                # Endet der Faden hier, laeuft die stderr-Pipe voll und der Kind blockiert
                # im naechsten write — der stdout-Loop erreichte nie EOF, der Job bliebe
                # dauerhaft 'running' (409-Riegel stehen). Also den Baum killen: stdout
                # endet, und der aeussere Handler setzt den terminalen Status (Kaltreview
                # zu #481; Wächter: test_stderr_faden_beendet_den_job_statt_ihn_haengen_zulassen).
                _kill_tree(proc)

        stderr_faden = threading.Thread(target=_lese_stderr, daemon=True)
        stderr_faden.start()
        for line in proc.stdout:
            _verarbeite(line)
        # joined VOR proc.wait() der Ordnung halber: die letzten stderr-Zeilen sollen den
        # Statuswechsel typischerweise nicht ueberdauern. Ein Deadlock kann aus der
        # Reihenfolge NICHT entstehen — der Daemon-Faden entleert die Pipe unabhängig vom
        # Join, und der Timeout deckelt ihn gegen einen haengenden Enkel, der das
        # stderr-Handle offen haelt (EOF kaeme dann erst nach dem Kind).
        stderr_faden.join(timeout=30)
        proc.wait()
        with _lock:
            _jobs[jid]["returncode"] = proc.returncode
            _jobs[jid]["status"] = "cancelled" if _jobs[jid]["cancelled"] \
                else ("done" if proc.returncode == 0 else "error")
            _jobs[jid]["ended"] = time.time()
    except Exception as e:  # Launch-Fehler etc. -> kein Zombie 'running'
        with _lock:
            fuege_zeile_an(_jobs[jid]["lines"], f"JOB-FEHLER: {e}")
            _jobs[jid]["status"] = "cancelled" if _jobs[jid]["cancelled"] else "error"
            _jobs[jid]["ended"] = time.time()
    finally:
        with _lock:
            key = (_jobs[jid]["project"], _jobs[jid]["kind"])
            if _active.get(key) == jid:
                _active.pop(key, None)


def _kill_tree(proc):
    if os.name == "nt":
        # /T killt den ganzen Prozessbaum (python -> [claude.cmd] -> claude/node -> MCP-Kinder);
        # ein blosses terminate() liesse den claude-Subtree verwaisen (vgl. correct.py:147-149).
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                       capture_output=True, creationflags=_CREATE_NO_WINDOW)  # exit!=0 (schon weg) ist ok
        return
    # Dasselbe auf POSIX: die Prozessgruppe aus _popen_kwargs() abraeumen. Ein blosses
    # terminate() liesse whisper/claude als Waisen mit belegter GPU zurueck.
    try:
        sigkill = getattr(signal, 'SIGKILL', 9)  # ponytail: Rueckfall auf 9 nur fuer Tests auf Windows-als-posix
        os.killpg(os.getpgid(proc.pid), sigkill)
    except (ProcessLookupError, PermissionError, OSError):
        proc.terminate()


def cancel(job_id: str):
    """Bricht einen laufenden Job samt Prozessbaum ab. None wenn unbekannt/schon terminal."""
    with _lock:
        r = _jobs.get(job_id)
        if r is None or r["status"] != "running":
            return None
        r["cancelled"] = True                 # Flag IMMER setzen -> deckt den pid=None-Race in _run ab
        proc = r.get("proc")
    if proc is not None and proc.poll() is None:  # poll-gate: nur killen, wenn proc noch lebt (kein PID-Recycling)
        _kill_tree(proc)
    return True


def cancel_all():
    """Alle laufenden Jobs abbrechen — fuer das Herunterfahren des Servers.

    Auf POSIX erreicht das SIGTERM beim Beenden der App nur uvicorn selbst: die Kinder
    sitzen bewusst in eigenen Sitzungen (_popen_kwargs), also erreicht sie auch kein
    Gruppensignal. Ohne diesen Aufruf liefe whisper nach dem Schliessen des Fensters
    als Waise mit belegter GPU weiter. Auf Windows raeumt schon taskkill /T auf.
    """
    with _lock:
        laufend = [jid for jid, r in _jobs.items() if r["status"] == "running"]
    for jid in laufend:
        cancel(jid)
    return laufend


def get(job_id: str):
    with _lock:
        r = _jobs.get(job_id)
        if r is None:
            return None
        snap = dict(r)
        snap["lines"] = list(r["lines"])
        snap.pop("proc", None)                # Popen-Handle ist nicht JSON-serialisierbar
        snap.pop("then", None)                # Callables sind nicht JSON-serialisierbar
        snap.pop("sonst", None)               # dito — und alle drei muessen HIER stehen:
        snap.pop("uebernommen", None)         # FastAPIs Encoder wirft nicht, er bildet eine
                                              # Funktion auf {} ab. Ein vergessener Schluessel
                                              # gaebe also 200 mit `sonst: [{}]` — in einer
                                              # Nutzlast, die alle 1,5 s gepollt wird.
        snap.pop("next_runs", None)           # Callables sind nicht JSON-serialisierbar
        snap.pop("active_bases", None)        # Zaehler-dict ist nicht JSON-serialisierbar
                                               # und verlaesst den Server nie (test_jobs.py)
        if isinstance(snap.get("bases"), set):
            snap["bases"] = list(snap["bases"])
        # `gesehen` geht MIT (anders als active_bases): es ist der Rueckweg des Frontends,
        # wenn die `[active]`-Zeile aus dem gedeckelten Puffer gefallen ist (#475).
        #
        # `sorted()` ist hier TRAGEND, nicht Kosmetik: `snap = dict(r)` ist flach, im Rumpf
        # laege sonst das LEBENDE Set. FastAPI serialisiert es ausserhalb von `_lock`,
        # waehrend `_run_proc` weiterschreibt -- gemessen (Block entfernt, echter Subprozess
        # mit 200.000 `[active]`-Zeilen, Dauerpoll): `RuntimeError: Set changed size during
        # iteration`. Wer die Umwandlung aus dem Lock HERAUSschoebe, statt sie zu entfernen,
        # bekaeme dasselbe Rennen bei gruener Suite zurueck. Dass die Reihenfolge dabei
        # stabil wird, ist die Zugabe.
        if isinstance(snap.get("gesehen"), set):
            snap["gesehen"] = sorted(snap["gesehen"])
        # `entfernt` reist mit, aus demselben Grund wie `gesehen`: der Parser liest den
        # gedeckelten Puffer neu, das Loeschen selbst druckt aber KEINE Zeile — ohne diesen
        # Rueckweg bliebe das Fenster bis zum `[scope+]`-Reannoncement offen (Minuten,
        # #479/#489). `sorted()` im Lock, aus demselben tragenden Grund wie eine Zeile
        # hoeher.
        if isinstance(snap.get("entfernt"), set):
            snap["entfernt"] = sorted(snap["entfernt"])
        # `eingereiht` reist mit, aus demselben Grund wie `gesehen` und `entfernt` — es ist
        # die DRITTE Wartequelle und war bis #561 die einzige ohne Rueckweg: `eingereiht`
        # entstand allein aus Zeilen, und der Puffer verliert sie.
        #
        # `list()` INNERHALB des Locks, weil `snap = dict(r)` flach ist: ohne die Kopie laege
        # im Rumpf die LEBENDE Liste, und FastAPI serialisiert sie ausserhalb von `_lock`,
        # waehrend `_run_proc` weiterschreibt. NICHT sortiert — die Reihenfolge IST die
        # Auskunft.
        #
        # ABER NICHT aus demselben tragenden Grund wie das `sorted()` zwei Zeilen hoeher, und
        # genau das stand hier zuerst — eine Begruendung, die schaerfer war als der Mechanismus
        # (gegnerischer Pruefer, F4). Beim Set ist es ein ABSTURZ: `RuntimeError: Set changed
        # size during iteration`, in drei Runden reproduziert. Eine Liste unter nebenlaeufigem
        # `append` zu serialisieren wirft NICHT (fuenf Runden gegen drei Millionen appends,
        # kein Fehler). Was die Kopie hier traegt, ist die SCHNAPPSCHUSS-Treue: kein Eintrag,
        # der nach dem Lock dazukam — und keine Auskunft, die zur `entfernt`-Menge derselben
        # Antwort nicht mehr passt.
        if isinstance(snap.get("eingereiht"), list):
            snap["eingereiht"] = list(snap["eingereiht"])
        return snap


def remove_base(project: str, base: str) -> None:
    """Entfernt eine gelöschte Aufnahme sofort aus dem Wirkungsbereich aller laufenden Jobs.

    `entfernt` ist die GEGENRICHTUNG zu `gesehen` (#479/#489): der Zeilenpuffer behält die
    Urteile der gelöschten Aufnahme (`fertig X:`, `apply: X -> edit.json`), und der Parser
    liest den GANZEN Puffer neu, nicht nur den Schwanz — ohne diese Menge erbte eine unter
    gleichem Namen neu hochgeladene Datei das Urteil der alten. Gültig bis zum
    `[scope+]`-REANNONCEMENT: `_verarbeite` räumt die Base beim EINTREFFEN der Marke aus
    der Menge (deckelfest — der Server sieht jede Zeile, BEVOR sie in den gedeckelten
    Puffer wandert). Ein Räumen im Parser an der Puffer-Marke wäre ordnungsblind gewesen:
    im zweiten Löschzyklus hätte die alte Marke des ersten Reuploads die frisch gebuchte
    Unterdrückung wieder aufgehoben (Review W1, am echten Parser gemessen).
    """
    with _lock:
        for (proj, _kind), jid in _active.items():
            if proj != project:
                continue
            r = _jobs.get(jid)
            if r is not None:
                if r.get("bases") is not None:
                    r["bases"].discard(base)
                # `gesehen` bleibt bewusst stehen: das ist eine Historie ("gehoerte zu
                # diesem Lauf"), kein Wirkungsbereich - sie aendert sich nicht dadurch,
                # dass eine Datei geloescht wird, und kein Riegel haengt daran
                # (`zugelassen()` im Frontend ist reine Anzeige).
                if r.get("active_bases") is not None:
                    r["active_bases"].pop(base, None)
                # Bedingungslos, auch wenn die Base nie in `bases` stand: ein correct-Lauf
                # ohne diese Aufnahme im Bereich soll trotzdem nichts Altes über ihren
                # Namen zeigen.
                r["entfernt"].add(base)


def betrifft(project: str, base: str, active_only: bool = False) -> dict | None:
    """Der laufende Job, der GENAU DIESE Aufnahme anfasst — sonst None.

    Ein Lauf druckt seinen Wirkungsbereich als erste Zeile (`SCOPE_PREFIX`), bevor er
    arbeitet: `transcribe` die noch nicht transkribierten Aufnahmen, `correct` die des
    Laufs, `fetch` gar keine (er legt neue an).

    Mit `active_only=True` (für `delete_file`) wird nur blockiert, wenn die Aufnahme
    in genau diesem Moment aktiv bearbeitet/geschrieben wird (`[active]`).
    Mit `active_only=False` (für `rename_file`, `retranscribe_file`) gilt der gesamte geplante
    Scope UND die gerade aktiven Aufnahmen — `active_only=False` ist die OBERMENGE von
    `active_only=True`, nicht der andere Zweig.

    Dass das eine Obermenge sein MUSS, ist neu und gemessen (#451): bis #450 galt
    `active_bases ⊆ bases`, seitdem nicht mehr — der Glossar-Schritt meldet korpusweit
    `[active]`, während `[scope]` bei einem Einzeldatei-Lauf nur die eine Aufnahme trägt.
    Ohne den dritten Term kam `POST …/files/{base}/transcribe` bzw. `…/rename` für eine
    solche Aufnahme durch und zerbrach an der offenen Datei: 500, halb gelöscht bzw. halb
    umbenannt (beides am echten Pfad reproduziert). Die engere Frage durfte nie mehr
    sperren als die weitere.

    PREIS, und er trifft POSIX HÄRTER als Windows: der Schaden, gegen den gesperrt wird, ist
    Windows-eigen (dort verhindert ein offener Griff rename und unlink, auf macOS/Linux nicht).
    Diese Sperre wirkt aber plattformunabhängig — auf macOS/Linux bekommen `rename_file` und
    `retranscribe_file` während des Glossar-Lesefensters jetzt 409 für Aufnahmen, an denen dort
    nie etwas kaputtgehen konnte. Bewusst so: EIN Verhalten auf allen Plattformen ist mehr wert
    als ein Zweig, den niemand testet, und die Datei WIRD in dem Moment gelesen.
    """
    with _lock:
        for (proj, _kind), jid in _active.items():
            if proj != project:
                continue
            r = _jobs.get(jid)
            if r is None or r["status"] != "running":
                continue
            if active_only:
                if base in r.get("active_bases", {}):
                    return {"id": r["id"], "kind": r["kind"]}
            else:
                if (r["bases"] is None or base in r["bases"]
                        or base in r.get("active_bases", {})):
                    return {"id": r["id"], "kind": r["kind"]}
    return None


def active_for(project: str) -> list:
    """[{'id','kind', 'bases'}, …] der laufenden Jobs des Projekts — transcribe und correct duerfen
    gleichzeitig laufen, deshalb eine Liste."""
    with _lock:
        out = []
        for (proj, _kind), jid in _active.items():
            if proj != project:
                continue
            r = _jobs.get(jid)
            if r is not None and r["status"] == "running":
                item = {"id": r["id"], "kind": r["kind"]}
                if r.get("bases") is not None:
                    item["bases"] = list(r["bases"])
                out.append(item)
        return sorted(out, key=lambda j: j["kind"])
