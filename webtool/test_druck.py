"""Die Huelle aus #344: eine Zeile ist EIN Schreibvorgang, und zwei Threads verschraenken sich
nicht.

Kein Test haengt an einem Rennen (eine Zahl stand hier und war nach zwei Reviewrunden falsch —
in einem Kommentar driftet sie unsichtbar). Das ist Absicht: der
Fehler, den die Huelle behebt, IST ein Rennen, und ein Test, der ihn per Rennen nachstellt,
waere in der CI mal gruen und mal rot. Gemessen wird stattdessen die Eigenschaft, die das
Rennen ueberhaupt erst moeglich macht — die Zahl der Schreibvorgaenge.
"""
import threading

from . import druck


class _Binaer:
    """Der `buffer`-Zweig eines Textstroms — der Weg, den `yt_dlp.utils.write_string` nimmt."""

    def __init__(self, oben):
        self._oben = oben

    def write(self, roh):
        self._oben.stuecke.append(roh.decode("utf-8"))
        return len(roh)


class Sammler:
    """Zeichnet JEDEN einzelnen `write` auf — genau die Aufloesung, um die es geht.

    `capsys` taugt hier nicht: es liefert den zusammengesetzten Text und kann nicht sagen, ob
    er in einem oder in zwei Vorgaengen entstanden ist.
    """

    def __init__(self):
        self.stuecke = []
        self.fluesse = 0
        self.encoding = "utf-8"
        self.buffer = _Binaer(self)

    def write(self, text):
        self.stuecke.append(text)
        return len(text)

    def flush(self):
        self.fluesse += 1


def test_eine_zeile_ist_ein_schreibvorgang():
    """`print(x, flush=True)` ist ohne Huelle ZWEI writes (Text, Umbruch) — gemessen. Unter
    `PYTHONUNBUFFERED=1` ist jeder davon ein eigenes `os.write` in die Job-Pipe, und dazwischen
    kann ein anderer Thread schreiben."""
    s = Sammler()
    ohne = Sammler()
    print("[done] A", file=ohne, flush=True)
    assert ohne.stuecke == ["[done] A", "\n"], "Praemisse geaendert — print ist nicht mehr 2 writes"

    print("[done] A", file=druck.zeilenweise(s), flush=True)
    assert s.stuecke == ["[done] A\n"]


def test_zwei_threads_verschraenken_sich_nicht():
    """Die Verschraenkung wird ERZWUNGEN statt erhofft: beide Threads legen ihre Teilzeile ab,
    bevor einer von beiden seinen Umbruch schreibt. Ohne `threading.local` traegt die Huelle
    einen gemeinsamen Puffer, und der erste Umbruch schiebt `[done] A[done] B\\n` raus — genau
    die Zeile, an der `jobs.buche_aktive` blind wird."""
    s = Sammler()
    h = druck.zeilenweise(s)
    a_steht, b_steht, a_fertig = threading.Event(), threading.Event(), threading.Event()

    def eins():
        h.write("[done] A")
        a_steht.set()
        b_steht.wait(5)
        h.write("\n")
        a_fertig.set()

    def zwei():
        a_steht.wait(5)
        h.write("[done] B")
        b_steht.set()
        a_fertig.wait(5)
        h.write("\n")

    t1, t2 = threading.Thread(target=eins), threading.Thread(target=zwei)
    t1.start()
    t2.start()
    t1.join(5)
    t2.join(5)

    assert s.stuecke == ["[done] A\n", "[done] B\n"]
    # Und die Eigenschaft, an der der 409-Riegel haengt, ausdruecklich: keine Marke steht
    # irgendwo anders als am Anfang ihres Stuecks.
    for stueck in s.stuecke:
        assert "[done] " not in stueck[1:], stueck


def test_teilzeile_geht_beim_flush_raus():
    """Eine Zeile ohne Umbruch (`print(..., end="")`) darf nicht im Puffer verhungern.

    GENAU LESEN: das gilt fuer den Thread, der auch flusht. Der Flush beim Herunterfahren
    laeuft im HAUPTthread und erreicht die Teilzeile eines Arbeitsthreads nicht — dafuer der
    Test darunter, der diese Grenze festhaelt statt sie zu behaupten."""
    s = Sammler()
    h = druck.zeilenweise(s)
    h.write("halbe Zeile")
    assert s.stuecke == []            # zurueckgehalten, wie beabsichtigt
    h.flush()
    assert s.stuecke == ["halbe Zeile"]
    assert s.fluesse == 1
    h.flush()                          # kein zweites Mal schreiben
    assert s.stuecke == ["halbe Zeile"]


def test_ohne_strom_wird_nicht_umhuellt():
    """Unter `pythonw.exe` ist `sys.stdout` None und `print` ein stiller No-op. Umhuellt
    stirbt stattdessen jeder `print`, und der Flush beim Herunterfahren macht aus einem
    sauberen Lauf Exit 120 — gemessen, auch ohne einen einzigen `print`."""
    assert druck.zeilenweise(None) is None


def test_zweimal_umhuellen_ergibt_eine_huelle():
    """Die drei `main()` laufen in Tests mehrfach; ohne die Wache stapelten sich die Lagen."""
    s = Sammler()
    h = druck.zeilenweise(s)
    assert druck.zeilenweise(h) is h
    # Und alles, was die Huelle nicht selbst kennt, gehoert dem umhuellten Strom.
    assert h.encoding == "utf-8"


def test_teilzeile_eines_arbeitsthreads_bleibt_liegen():
    """Eine gemessene GRENZE, kein Wunsch — festgehalten, damit sie sichtbar bleibt.

    `threading.local` ist thread-lokal, und genau das ist der Zweck. Die Folge: die Teilzeile
    eines Arbeitsthreads erreicht kein `flush()` aus einem anderen Thread — auch nicht der
    Flush beim Herunterfahren, der im Hauptthread laeuft. Endet ein Poolthread mit einer
    Teilzeile, ist sie weg. Heute unerreichbar (kein Drucker ohne Umbruch auf stdout); wer
    einen einbaut, macht diesen Test hoffentlich zuerst rot.
    """
    s = Sammler()
    h = druck.zeilenweise(s)
    t = threading.Thread(target=lambda: h.write("Rest ohne Umbruch"))
    t.start()
    t.join(5)
    h.flush()                          # Hauptthread — sieht den fremden Rest NICHT
    assert s.stuecke == []
    assert s.fluesse == 1              # geflusht wurde, es war nur nichts da


def test_buffer_ueberholt_die_teilzeile_nicht():
    """`yt_dlp.utils.write_string` schreibt ueber `out.buffer` — an der Huelle vorbei. `YoutubeDL`
    laeuft in-process (`fetch.py:449/456`), gebaut NACH der Umhuellung in `fetch.main`. Ohne
    Leeren vor der Herausgabe ueberholte die direkt geschriebene Zeile unsere Teilzeile."""
    s = Sammler()
    h = druck.zeilenweise(s)
    h.write("Teilzeile")               # zurueckgehalten
    h.buffer.write("direkt\n".encode("utf-8"))
    assert s.stuecke == ["Teilzeile", "direkt\n"]


def test_writelines_geht_durch_den_puffer():
    """Am Strom vorbeigereicht ueberholte `writelines` eine zurueckgehaltene Teilzeile."""
    s = Sammler()
    h = druck.zeilenweise(s)
    h.write("Rest")
    h.writelines(["A\n", "B\n"])
    assert s.stuecke == ["RestA\n", "B\n"]
