"""Anmeldung an den Abo-CLIs aus der App heraus — Status abfragen und Login fahren.

**Warum ueberhaupt:** `llm.available()` prueft fuer die Abo-Anbieter nur, ob das Programm auf
dem PATH liegt. Ein installiertes, aber nicht angemeldetes `claude` bekam damit gruenes Licht,
und die Korrektur scheiterte erst mitten im Lauf. Den Status kennen beide CLIs selbst.

**Warum ein eigenes Modul statt `jobs.py`:** zwei Gruende, beide gemessen.
1. Der Login braucht **stdin** (siehe unten). `jobs.py` startet ohne, und allen Jobs eine Pipe
   zu geben, die nie beschrieben wird, waere eine Verhaltensaenderung fuer Transkription und
   Korrektur.
2. `jobs.py` liest zeilenweise (`for line in proc.stdout`). Die Aufforderung
   `Paste code here if prompted > ` kommt **ohne Zeilenumbruch** und laege dort bis zur
   naechsten Ausgabe im Puffer.

**Die beiden Anbieter laufen unterschiedlich, sehen aber gleich aus:**
- `claude auth login --claudeai` druckt eine Authorize-URL und wartet dann auf einen Code,
  den der Nutzer aus dem Browser zurueckbringt (`redirect_uri` zeigt auf platform.claude.com,
  es gibt also KEINEN lokalen Callback, den wir abfangen koennten). → URL raus, Code rein.
- `codex login --device-auth` druckt URL **und** Code; eingegeben wird beides im Browser, die
  CLI pollt selbst und beendet sich. → nichts rein.
Darum kennt der Zustand unten beides: `url` immer, `code` nur wenn die CLI einen anzeigt, und
`braucht_code` sagt der Oberflaeche, ob sie ein Eingabefeld zeigen muss.

**Erfolg wird an `status()` gemessen, nicht am Exitcode** — dieselbe Regel wie bei
`correct._run_claude` (Datei) und `llm._run_codex` (Antwortdatei). Ein abgebrochener
Browser-Flow kann mit 0 enden, und `codex login status` meldet ohnehin verlaesslich.
"""
import re
import subprocess
import threading
import time

from . import llm
from .jobs import _CREATE_NO_WINDOW, _kill_tree, _popen_kwargs

# Wie fragt man den Status ab, und wie meldet man sich an? Nur Abo-CLIs stehen hier —
# API-Anbieter haben keinen Anmeldezustand, dort ist der Key die Anmeldung.
CLIS = {
    "claude-cli": {
        "status": ["auth", "status"],
        "login": ["auth", "login", "--claudeai"],
        "braucht_code": True,
    },
    "codex-cli": {
        "status": ["login", "status"],
        # --device-auth statt des Browser-Callbacks: der Code steht in der Ausgabe und laesst
        # sich anzeigen. Der Callback-Weg wollte einen lokalen Port oeffnen, den wir dem
        # Nutzer nicht erklaeren koennen.
        "login": ["login", "--device-auth"],
        "braucht_code": False,
    },
}

# Beide CLIs faerben ihre Ausgabe. Das muss RAUS, bevor irgendetwas darin gesucht wird —
# gemessen an `codex login --device-auth`, das so schreibt:
#     \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m
#     \x1b[94mIUO4-YVUNH\x1b[0m
# Ungefiltert frisst die URL-Regex das abschliessende \x1b[0m mit (kaputter Link), und die
# Wortgrenze vor dem Code scheitert am `m` aus `[94m` — zwischen zwei Wortzeichen gibt es
# keine. Der Code war also da und blieb unsichtbar; der Geraete-Flow konnte nie fertig werden.
_ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")
_URL = re.compile(r"https://[^\s\"'<>]+")
# Codex zeigt den Einmalcode als Gruppen aus Grossbuchstaben/Ziffern, meist mit Bindestrich.
_CODE = re.compile(r"\b([A-Z0-9]{4,8}-[A-Z0-9]{4,8})\b")

STATUS_TIMEOUT = 30       # s; die Statusabfrage ist ein lokaler Aufruf, der sofort antwortet
LOGIN_TIMEOUT = 600       # s; danach gilt der Versuch als abgelaufen und wird abgeraeumt

_lock = threading.Lock()
_lauf = None              # genau EIN Anmeldeversuch zugleich — mehr ergibt fuer einen
                          # lokalen Einzelnutzer keinen Sinn und macht den Zustand mehrdeutig


def _exe(provider: str) -> str:
    prov = llm.PROVIDERS.get(provider) or {}
    return llm._exe(prov)


def status(provider: str) -> dict:
    """{unterstuetzt, angemeldet, detail} fuer einen Abo-Anbieter.

    Wirft nie: die Einstellungsseite muss auch dann laden, wenn die CLI fehlt oder klemmt.
    """
    spec = CLIS.get(provider)
    if not spec:
        return {"unterstuetzt": False, "angemeldet": False, "detail": ""}
    exe = _exe(provider)
    if not exe:
        return {"unterstuetzt": True, "angemeldet": False,
                "detail": "Programm nicht gefunden — bitte zuerst installieren."}
    try:
        p = subprocess.run([exe] + spec["status"], capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=STATUS_TIMEOUT,
                           creationflags=_CREATE_NO_WINDOW)
    except (subprocess.TimeoutExpired, OSError) as e:
        return {"unterstuetzt": True, "angemeldet": False, "detail": f"Statusabfrage fehlgeschlagen: {e}"}
    roh = (p.stdout or "") + (p.stderr or "")
    return {"unterstuetzt": True, "angemeldet": p.returncode == 0, "detail": _detail(roh, p.returncode)}


def _detail(roh: str, rc: int) -> str:
    """Eine Zeile fuer den Menschen. `claude auth status` antwortet JSON, `codex login status`
    einen Satz — beides hier auf dieselbe Form bringen, statt zwei Anzeigen zu bauen."""
    roh = roh.strip()
    if roh.startswith("{"):
        try:
            import json
            d = json.loads(roh)
        except ValueError:
            return roh.splitlines()[0] if roh else ""
        if not d.get("loggedIn"):
            return "Nicht angemeldet."
        teile = [t for t in (d.get("email"), d.get("subscriptionType")) if t]
        return "Angemeldet" + (f" als {teile[0]}" if teile else "") + \
               (f" ({teile[1]})" if len(teile) > 1 else "")
    erste = roh.splitlines()[0] if roh else ""
    if erste:
        return erste
    return "Angemeldet." if rc == 0 else "Nicht angemeldet."


def _zustand_locked() -> dict:
    """Momentaufnahme fuer die Oberflaeche. Ohne `lines` im Rohzustand: die Ausgabe enthaelt
    Fortschrittszeichen und Farbcodes, gebraucht werden URL, Code und ein Ergebnis."""
    if _lauf is None:
        return {"laeuft": False}
    text = _ANSI.sub("", "".join(_lauf["ausgabe"]))
    url = _URL.search(text)
    code = _CODE.search(text)
    return {"laeuft": _lauf["laeuft"], "provider": _lauf["provider"],
            "url": url.group(0) if url else "",
            "code": code.group(1) if code else "",
            "braucht_code": _lauf["braucht_code"],
            "fertig": not _lauf["laeuft"],
            "ok": _lauf["ok"], "fehler": _lauf["fehler"],
            "ausgabe": text[-2000:]}


def zustand(provider: str = "") -> dict:
    """Zustand des laufenden Vorgangs. Mit `provider` nur, wenn er auch zu DIESEM Anbieter
    gehoert: wer waehrend einer Codex-Anmeldung auf das Claude-Abo umstellt, bekam sonst
    weiterhin die Codex-URL unter der Claude-Ueberschrift angezeigt."""
    with _lock:
        if provider and (_lauf is None or _lauf["provider"] != provider):
            return {"laeuft": False}
        return _zustand_locked()


def start(provider: str) -> dict:
    """Startet den Anmeldevorgang.

    Ein laufender Versuch **desselben** Anbieters wird nicht ersetzt — sonst raeumt ein
    Doppelklick den Versuch weg, in dessen Browser-Tab der Nutzer gerade tippt. Ein Versuch
    eines ANDEREN Anbieters ist dagegen gegenstandslos, sobald umgestellt wurde, und wird
    samt Prozessbaum beendet.
    """
    spec = CLIS.get(provider)
    if not spec:
        raise ValueError(f"{provider} kennt keine Anmeldung")
    exe = _exe(provider)
    if not exe:
        raise FileNotFoundError("Programm nicht gefunden — bitte zuerst installieren.")
    global _lauf
    with _lock:
        if _lauf is not None and _lauf["laeuft"]:
            # Derselbe Anbieter: laufen lassen. Ein Doppelklick darf nicht den Versuch
            # abraeumen, in dessen Browser-Tab der Nutzer gerade tippt.
            if _lauf["provider"] == provider:
                return _zustand_locked()
            alt = _lauf["proc"]        # anderer Anbieter: der alte Versuch ist gegenstandslos
            _lauf["fehler"] = "Anbieter gewechselt."
        else:
            alt = None
    if alt is not None:
        _kill_tree(alt)
    with _lock:
        _lauf = {"provider": provider, "laeuft": True, "ok": False, "fehler": "",
                 "ausgabe": [], "proc": None, "braucht_code": spec["braucht_code"],
                 "start": time.time()}
        meiner = _lauf
    threading.Thread(target=_fahre, args=(meiner, exe, spec, provider), daemon=True).start()
    # Kurz warten, damit der erste Poll die URL meist schon sieht — der Nutzer hat gerade
    # geklickt und schaut auf ein leeres Feld. Nicht laenger: der Browser-Flow dauert Minuten.
    for _ in range(60):
        with _lock:
            if _URL.search(_ANSI.sub("", "".join(meiner["ausgabe"]))):
                break
        time.sleep(0.05)
    return zustand(provider)


def _fahre(lauf: dict, exe: str, spec: dict, provider: str) -> None:
    try:
        proc = subprocess.Popen([exe] + spec["login"], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, encoding="utf-8", errors="replace",
                                creationflags=_CREATE_NO_WINDOW, **_popen_kwargs())
    except OSError as e:
        with _lock:
            lauf.update(laeuft=False, fehler=f"Start fehlgeschlagen: {e}")
        return
    with _lock:
        lauf["proc"] = proc
    # ZEICHENweise lesen, nicht zeilenweise: `Paste code here if prompted > ` kommt ohne
    # Zeilenumbruch und laege sonst bis zur naechsten Ausgabe im Puffer — der Nutzer saehe
    # die URL erst, wenn es zu spaet ist.
    try:
        while True:
            z = proc.stdout.read(1)
            if not z:
                break
            with _lock:
                lauf["ausgabe"].append(z)
    except (OSError, ValueError):
        pass
    proc.wait()
    # Erfolg an status() messen, nicht am Exitcode: ein abgebrochener Browser-Flow kann mit 0
    # enden, und die CLI weiss es selbst am besten.
    st = status(provider)
    with _lock:
        lauf["laeuft"] = False
        lauf["ok"] = bool(st["angemeldet"])
        if not lauf["ok"] and not lauf["fehler"]:
            lauf["fehler"] = st["detail"] or "Anmeldung nicht abgeschlossen."


def code(text: str) -> dict:
    """Den aus dem Browser zurueckgebrachten Code an die wartende CLI reichen."""
    with _lock:
        if _lauf is None or not _lauf["laeuft"] or _lauf["proc"] is None:
            raise RuntimeError("Es laeuft gerade keine Anmeldung.")
        proc = _lauf["proc"]
    try:
        proc.stdin.write(text.strip() + "\n")
        proc.stdin.flush()
    except (OSError, ValueError) as e:
        raise RuntimeError(f"Code konnte nicht uebergeben werden: {e}") from None
    return zustand()


def abbrechen() -> dict:
    """Bricht den Vorgang samt Prozessbaum ab (die CLIs starten Kindprozesse)."""
    with _lock:
        if _lauf is None or not _lauf["laeuft"] or _lauf["proc"] is None:
            # _zustand_locked, nicht zustand(): _lock ist nicht reentrant, und der Aufruf
            # von hier aus sperrte den Prozess gegen sich selbst.
            return _zustand_locked()
        proc = _lauf["proc"]
        _lauf["fehler"] = "Abgebrochen."
    _kill_tree(proc)
    return zustand()
