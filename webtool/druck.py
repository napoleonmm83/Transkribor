"""Zeilenweises Schreiben auf stdout — EIN `write` je Zeile statt zwei (#344).

`print(text, flush=True)` sind **zwei** Schreibvorgaenge: erst der Text, dann der Umbruch.
Gemessen (Py 3.13, Sammelstrom statt `sys.stdout`)::

    print(x, flush=True) -> 2 writes: ['[done] A', '\\n']
    write(x + "\\n")      -> 1 write : ['[done] A\\n']

`jobs.py` setzt `PYTHONUNBUFFERED=1`; der Binaerlayer ist damit roh und der Textlayer
write-through, jeder der beiden Vorgaenge geht also als eigenes `os.write` in die Pipe.
Zwischen den beiden kann die GIL wechseln — zwei Threads schreiben ineinander, und die Zeile,
die `jobs.py` liest, gehoert keinem von beiden.

**Das ist nicht nur Anzeige.** Seit #418 bucht `jobs.buche_aktive` `[active]`/`[done]` in
`active_bases`, und `betrifft(..., active_only=True)` ist der 409-Riegel von
`DELETE /api/projects/{p}/files/{base}`. Eine zerlegte `[done]`-Zeile trifft
`startswith(DONE_PREFIX)` noch, aber der Rest ist kein Basisname mehr — das `discard` laeuft ins
Leere, und **die Aufnahme bleibt bis Jobende gesperrt**. Ein verschlucktes `[active]` ist
derselbe Fall spiegelverkehrt: die Sperre fehlt still.

Am ECHTEN Pfad gemessen (`correct run`, 10 Dateien, `parallel=16`, toter Anbieter, ueber
`jobs.start()`; Werkzeug `.claude/skills/messstand/`): **106 Zeilen, 9 verstuemmelt, 24 leer** —
darunter `[done] S05[done] S02` und `[active] S03[active] S02`.

Die Huelle sammelt **je Thread** bis zum Umbruch und reicht die fertige Zeile in EINEM `write`
weiter. Sie aendert damit nur die GRUPPIERUNG der Schreibvorgaenge; Kodierung,
Fehlerbehandlung und Zeilenenden bleiben die des umhuellten Stroms.

Warum eine Huelle und nicht 132 umgeschriebene Druckstellen: `jobPhases.vertrag.test.ts` erntet
die Meldungsformen aus dem Quelltext ueber `print(`. Eine auf `sys.stdout.write` umgestellte
Zeile faellt aus dieser Ernte — bei einer Form mit mehreren Druckstellen (`[done]` hat acht,
`[active]` sechs) **ohne dass der Test rot wird**. Die Huelle laesst die Druckstellen in Ruhe,
also auch die Ernte.

GRENZEN, benannt statt verschwiegen:

* **`PIPE_BUF`.** Atomar ist ein Pipe-Schreibvorgang nur bis 4096 Byte (Linux). Die laengste
  Zeile ist `[scope]` mit allen Basisnamen — sie wird gedruckt, bevor ein zweiter Thread laeuft.
* **stderr bleibt aussen vor.** `jobs.py` mischt es per `stderr=STDOUT` in dieselbe Pipe. Die
  vier `file=sys.stderr`-Drucker tragen keine Marke; der faster-whisper-Fortschrittsbalken
  (`log_progress=True`) dagegen schreibt `\\r`-praefigierte Bruchstuecke OHNE Zeilenende, und
  eine Marke, die dort hineinfaellt, kommt als `67%|… [done] X` beim Leser an. Dieselbe
  Fehlerklasse, von dieser Huelle prinzipiell NICHT gedeckt — eigener Punkt.
* **`pytest -s`.** Dort setzt pytest `sys.stdout` nicht je Test zurueck, die Huelle bleibt also
  ueber Testgrenzen stehen. Die CI faehrt `-rs` (Skip-Report), nicht `-s`; kosmetisch.
"""
import threading


class Zeilenweise:
    """Sammelt je Thread bis zum Zeilenumbruch und schreibt die Zeile mit EINEM `write`."""

    def __init__(self, strom):
        self._strom = strom
        self._offen = threading.local()      # je Thread ein eigener Rest -> keine Verschraenkung

    def write(self, text):
        rest = getattr(self._offen, "text", "") + text
        i = rest.rfind("\n")
        if i < 0:                            # noch keine ganze Zeile -> zurueckhalten
            self._offen.text = rest
            return len(text)
        self._offen.text = rest[i + 1:]
        self._strom.write(rest[:i + 1])      # alles bis zum LETZTEN Umbruch, in einem Stueck
        return len(text)

    def writelines(self, zeilen):
        # Nicht an den Strom durchreichen: das ginge am Puffer vorbei und koennte eine
        # zurueckgehaltene Teilzeile ueberholen.
        for z in zeilen:
            self.write(z)

    def flush(self):
        # Eine Teilzeile (`print(..., end="")`) geht beim flush raus statt verloren. Beim
        # Herunterfahren ruft CPython `sys.stdout.flush()`, der Rest ist also nie verloren.
        rest = getattr(self._offen, "text", "")
        if rest:
            self._offen.text = ""
            self._strom.write(rest)
        self._strom.flush()

    def __getattr__(self, name):
        # Alles Uebrige (encoding, errors, fileno, isatty, reconfigure, buffer …) gehoert dem
        # umhuellten Strom. `self.__dict__["_strom"]` statt `self._strom`: fehlte das Attribut,
        # riefe der Zugriff wieder `__getattr__` und liefe in eine Rekursion.
        return getattr(self.__dict__["_strom"], name)


def zeilenweise(strom):
    """Huelle um `strom` — idempotent: zweimal aufgerufen entsteht keine zweite Lage.

    Die Wache ist noetig, weil die drei `main()` in Tests mehrfach laufen; ohne sie
    stapelten sich die Huellen ueber einen Testlauf hinweg.
    """
    return strom if isinstance(strom, Zeilenweise) else Zeilenweise(strom)
