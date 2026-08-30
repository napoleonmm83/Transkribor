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

Warum eine Huelle und nicht ueber hundert umgeschriebene Druckstellen (die genaue Zahl haengt
an der Zaehlweise -- 106 `print(`-Zeilen allein in den drei Laeufern, 168 ueber alle
git-verfolgten `*.py` ohne Tests; hier stand eine Zahl ohne Grundgesamtheit):
`jobPhases.vertrag.test.ts` erntet
die Meldungsformen aus dem Quelltext ueber `print(`. Eine auf `sys.stdout.write` umgestellte
Zeile faellt aus dieser Ernte — bei einer Form mit mehreren Druckstellen (`[done]` hat acht,
`[active]` sechs) **ohne dass der Test rot wird**. Die Huelle laesst die Druckstellen in Ruhe,
also auch die Ernte.

GRENZEN, benannt statt verschwiegen:

* **`PIPE_BUF`.** Atomar ist ein Pipe-Schreibvorgang nur bis 4096 Byte (Linux). Die laengste
  BEKANNTE Zeile ist `[scope]` mit allen Basisnamen, und die ist unkritisch: sie wird
  gedruckt, bevor ein zweiter Thread laeuft (`transcribe.py:504` vor `:587`, `correct.py:1240`
  vor `:1356`). Was NICHT gemessen ist: Fehlerzeilen mit eingebetteter Ausnahme (`{e}`) — die
  laufen sehr wohl neben Poolthreads, und ihre Laenge haengt an fremdem Text.
* **stderr bleibt aussen vor.** `jobs.py` mischt es per `stderr=STDOUT` in dieselbe Pipe. Die
  vier `file=sys.stderr`-Drucker tragen keine Marke; der faster-whisper-Fortschrittsbalken
  (`log_progress=True`) dagegen schreibt `\\r`-praefigierte Bruchstuecke OHNE Zeilenende, und
  eine Marke, die dort hineinfaellt, kommt als `67%|… [done] X` beim Leser an. Dieselbe
  Fehlerklasse, von dieser Huelle prinzipiell NICHT gedeckt: das Problem ist nicht die
  Gruppierung UNSERER Schreibvorgaenge, sondern ein zweiter Schreiber auf derselben Pipe, der
  legitim Bruchstuecke ohne Zeilenende erzeugt. **#481**, mit Messung und Vorbehalt.
* **`pytest -s`.** Dort setzt pytest `sys.stdout` nicht je Test zurueck, die Huelle bleibt also
  ueber Testgrenzen stehen. Die CI faehrt `-rs` (Skip-Report), nicht `-s`; kosmetisch.
* **Die Teilzeile eines ARBEITSthreads gehoert ihm allein.** `threading.local` ist thread-lokal
  (das ist der Zweck) -- weder ein `flush()` aus einem anderen Thread noch der Flush beim
  Herunterfahren, der im HAUPTthread laeuft, erreicht sie. Endet ein Poolthread mit einer
  Teilzeile im Puffer, ist sie weg. Heute unerreichbar (kein `print(..., end="")` und kein
  `sys.stdout.write` ohne Umbruch im Produktivcode, gegrept), als Test festgehalten.
* **`isinstance(sys.stdout, io.TextIOBase)` ist ab jetzt `False`.** Im Repo fragt das niemand
  (gegrept); eine fremde Bibliothek koennte es.
"""
import threading


class Zeilenweise:
    """Sammelt je Thread bis zum Zeilenumbruch und schreibt die Zeile mit EINEM `write`."""

    def __init__(self, strom):
        """`strom` ist der echte Textstrom; die Huelle reicht alles an ihn durch."""
        self._strom = strom
        self._offen = threading.local()      # je Thread ein eigener Rest -> keine Verschraenkung

    def write(self, text):
        """Sammelt bis zum letzten Umbruch und gibt alles bis dahin in EINEM `write` weiter.

        Rueckgabe ist die Zahl der uebergebenen Zeichen (TextIOBase-Vertrag), nicht die der
        weitergereichten -- ein Aufrufer, der zaehlt, soll nicht merken, dass gepuffert wird.
        """
        rest = getattr(self._offen, "text", "") + text
        i = rest.rfind("\n")
        if i < 0:                            # noch keine ganze Zeile -> zurueckhalten
            self._offen.text = rest
            return len(text)
        self._offen.text = rest[i + 1:]
        self._strom.write(rest[:i + 1])      # alles bis zum LETZTEN Umbruch, in einem Stueck
        return len(text)

    def writelines(self, zeilen):
        """Wie `write` je Zeile — NICHT an den Strom durchgereicht."""
        # Durchgereicht ginge es am Puffer vorbei und koennte eine zurueckgehaltene Teilzeile
        # ueberholen.
        for z in zeilen:
            self.write(z)

    def flush(self):
        """Gibt einen angefangenen Rest DIESES Threads heraus und leert den echten Strom."""
        # Eine Teilzeile (`print(..., end="")`) geht beim flush raus statt verloren.
        #
        # GENAU LESEN: beim Herunterfahren ruft CPython `sys.stdout.flush()` im HAUPTthread,
        # und `threading.local` eines Arbeitsthreads ist von dort aus unsichtbar. Die
        # Teilzeile eines Arbeitsthreads, der ohne eigenen `flush` endet, ginge also
        # verloren. Heute unerreichbar (kein `print(..., end="")` auf stdout im Produktivcode,
        # gegrept) -- aber "der Rest ist nie verloren" gilt nur fuer den Hauptthread, und so
        # stand es hier zuerst.
        rest = getattr(self._offen, "text", "")
        if rest:
            self._offen.text = ""
            self._strom.write(rest)
        self._strom.flush()

    def __getattr__(self, name):
        """Alles, was die Huelle nicht selbst kennt, gehoert dem umhuellten Strom."""
        # Alles Uebrige (encoding, errors, fileno, isatty, reconfigure …) gehoert dem
        # umhuellten Strom. `self.__dict__["_strom"]` statt `self._strom`: fehlte das Attribut,
        # riefe der Zugriff wieder `__getattr__` und liefe in eine Rekursion.
        #
        # `buffer` ist der eine Sonderfall: wer ihn holt, schreibt an der Huelle VORBEI und
        # ueberholte damit eine zurueckgehaltene Teilzeile. Der Weg ist nicht theoretisch --
        # `yt_dlp.utils.write_string` nimmt genau ihn, und `YoutubeDL` laeuft in-process
        # (`fetch.py:449/456`), gebaut NACH der Umhuellung in `fetch.main`. Heute folgenlos
        # (`_ydl_opts` setzt quiet/no_warnings/noprogress, `fetch.main` ist einthreadig) --
        # aber das ist Konfiguration, nicht Konstruktion. Vor der Herausgabe wird deshalb
        # geleert; danach gibt es nichts mehr zu ueberholen.
        if name == "buffer":
            self.flush()
        return getattr(self.__dict__["_strom"], name)


def zeilenweise(strom):
    """Huelle um `strom` — idempotent, und ohne Strom passiert gar nichts.

    `None` kommt vor: unter `pythonw.exe` (kein Konsolen-Handle) ist `sys.stdout` None, und
    `print` ist dort ein stiller No-op. Umhuellt stirbt stattdessen JEDER `print` mit einem
    `AttributeError`, und der Flush beim Herunterfahren macht aus einem sauberen Lauf
    **Exit 120 — auch ohne einen einzigen `print`** (gemessen: vorher Exit 0). Ein Lauf ohne
    Ausgabe ist kein Grund fuer einen Fehlschlag; hier gibt es schlicht nichts zu buendeln.

    Die Idempotenz-Wache daneben ist noetig, weil die drei `main()` in Tests mehrfach
    laufen; ohne sie stapelten sich die Huellen ueber einen Testlauf hinweg.
    """
    if strom is None:
        return None
    return strom if isinstance(strom, Zeilenweise) else Zeilenweise(strom)
