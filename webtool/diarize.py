"""Akustische Sprecher-Diarisierung (Stufe 3): Audio -> Sprecher-Cluster pro Zeitspanne.

pyannote.audio (community-1) liefert anonyme Cluster; die Zuordnung Segment->Cluster per
grösster zeitlicher Überlappung (`assign_clusters`) ist reines, unit-getestetes Python.
Die torch/pyannote-Importe liegen bewusst INNERHALB der Funktionen (lazy) — `import
webtool.diarize` bleibt leicht und ohne installiertes pyannote lauffähig (Best-effort-Fallback
im Aufrufer)."""
import contextlib
import os

# Das Modell liegt IM Repo (models/, ~31 MB) und wird mit der App ausgeliefert, statt bei
# Hugging Face zu haengen: dessen Gate ist ein Kontaktformular, kein Lizenzhindernis
# (CC-BY-4.0), kostete den Nutzer aber Konto + Token + Haekchen im Browser — der einzige
# Einrichtungsschritt der Desktop-App, den kein Klick loesen konnte. Die config.yaml
# referenziert ihre Gewichte als `$model/...` und `$model` ist ihr eigenes Verzeichnis,
# der Ordner ist also unveraendert verschiebbar.
DIAR_MODEL = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                          "models", "speaker-diarization-community-1", "config.yaml")
_PIPELINE = None
# pyannote-Verfuegbarkeit, je Prozess EINMAL gemessen (#270). None = noch nicht gefragt.
_VERFUEGBAR: bool | None = None


def verfuegbar() -> bool:
    """Wird die Sprechertrennung in DIESER Umgebung rechnen können? (#270)

    Beantwortet zwei der drei Ausfallgründe — pyannote fehlt, Modelldatei fehlt — nicht
    aber den dritten (GPU voll / sonstiger Laufzeitfehler: der bleibt best-effort beim
    Lauf, ein Vorab-Test hiesse torch im Request-Pfad importieren). Fuer genau die zwei
    gemessenen Faelle reicht find_spec + Dateistat, und find_spec laedt torch NICHT.

    Zwei Fallen, beide gemessen (Wellenplan 3): find_spec('pyannote.audio') **wirft**
    ModuleNotFoundError, wenn schon das Parent-Paket fehlt — es liefert nicht None, ein
    ungeschuetzter Aufruf waere ein 500 im GET des Datei-Dialogs. Und der GET laeuft bei
    jedem Oeffnen des Dialogs: das Ergebnis wird deshalb je Prozess gecacht (Vorbild
    `_HARDWARE` in app.py). Die venv aendert sich zur Laufzeit nicht; die MODELLDATEI
    koennte es (Reparatur im laufenden Betrieb) — ein dann veralteter False sperrt das Feld
    bis zum Neustart, vernachlaessigbar gegen einen find_spec je GET.
    """
    global _VERFUEGBAR
    if _VERFUEGBAR is None:
        try:
            # Funktion-lokaler Import: nimmt (auch im Test) den aktuellen Attributstand
            # von importlib.util — und laedt pyannote/torch dabei zu keinem Zeitpunkt.
            from importlib.util import find_spec
            _VERFUEGBAR = (find_spec("pyannote.audio") is not None
                           and os.path.exists(DIAR_MODEL))
        except (ModuleNotFoundError, ValueError):
            # ValueError: ungueltiger Modulname — fuer falsche Eingaben reserviert, hier
            # unmoeglich, aber der Aufruf darf nie werfen (er sitzt in einem GET).
            _VERFUEGBAR = False
    return _VERFUEGBAR


def _pipeline():
    """Lazy-Singleton der pyannote-Pipeline (Modell aus models/; GPU falls vorhanden)."""
    global _PIPELINE
    if _PIPELINE is None:
        import torch
        from pyannote.audio import Pipeline
        if not os.path.exists(DIAR_MODEL):
            raise RuntimeError(f"Diarisierungsmodell fehlt: {DIAR_MODEL}")
        pipe = Pipeline.from_pretrained(DIAR_MODEL)
        if pipe is None:
            raise RuntimeError(f"pyannote-Pipeline nicht geladen ({DIAR_MODEL})")
        # Dasselbe Geraet wie die Transkription (webtool/device.py). Scheitert MPS hier,
        # bleibt es beim Best-effort-Verhalten: kein .diar.json, Korrektur laeuft wie vor
        # Stufe 3 weiter — die Sprechertrennung faellt aus, nicht der Lauf.
        from . import device as devicemod
        dev = devicemod.pick()
        if dev != "cpu":
            pipe.to(torch.device(dev))
        _PIPELINE = pipe
    return _PIPELINE


def _diagnose_sonden(pipe, diagnose):
    """Zwei Sonden in pyannotes Innereien, damit `<base>.diar.json` sagen kann, wie SICHER
    die Clusterung war (#275) — reine Diagnose, kein Verhaltenswechsel: beide Sonden reichen
    ihre Argumente unveraendert durch und geben das Original zurueck.

    Warum ueberhaupt ein Monkeypatch: beide Groessen wirft pyannote selbst weg.
    `clustering.py:609` bindet `q, sp = cluster_vbx(...)` LOKAL, und :669 gibt nur
    `(hard_clusters, soft_clusters, centroids)` zurueck — `sp` ist nicht dabei; auch
    `speaker_diarization.py:640` verwirft, was uebrig bleibt. Es gibt keinen Auslesepfad.

    **Zwei Sonden, zwei verschiedene Griffe — das ist keine Inkonsequenz:**
    - `cluster_vbx` ist ein MODULGLOBALER Name, den `clustering.py:34` zur Importzeit bindet
      (`from ...utils.vbx import cluster_vbx`). Wer `utils.vbx` patcht, patcht ins Leere. Der
      Griff ist prozessweit, deshalb steht der Rueckbau im `finally` — dieselbe Lehre wie beim
      `_Sprachschwelle`-Proxy in `transcribe.py`, wo ein haengengebliebener Patch die naechste
      Datei klemmte.
    - `filter_embeddings` ist eine METHODE mit dokumentierter Signatur. Gepatcht wird
      `type(pipe.clustering)` (= `VBxClustering`), nicht die Instanz: pyannotes
      `Pipeline.__setattr__` ist ueberschrieben und faengt Zuweisungen ab. Und nicht
      `BaseClustering`, wo die Methode definiert ist — der Override auf der Unterklasse ist
      der engere Griff. Weil `filter_embeddings` NICHT in `vars(VBxClustering)` steht, ist
      der Rueckbau ein `delattr`, kein Zurueckschreiben.

    **Best effort, weil es fremde Innereien sind:** fehlt ein Griffpunkt (pyannote hat sich
    geaendert), wird er ausgelassen — die Diarisierung laeuft, die Diagnose fehlt. Dieselbe
    Richtung wie der bestehende Sidecar-Rueckfall. Ein Waechtertest haelt fest, wann das
    eintritt (`test_diarize.py`), sonst faellt die Diagnose still weg.

    **Setzt voraus, dass `cmd_diarize` seriell bleibt.** Beide Griffe sind prozessweit; heute
    ist das gedeckt (jeder Job ist ein eigener Subprozess, und `cmd_diarize` laeuft als
    Schleife VOR dem ThreadPoolExecutor). Wer die Diarisierung je parallelisiert, bekommt
    Diagnosezahlen im falschen Sidecar — die Cluster bleiben richtig, weil die Sonden
    durchreichen.

    `pi` KANN fehlen, ohne dass etwas kaputt ist: `VBxClustering.__call__` steigt bei weniger
    als zwei Trainings-Embeddings vorzeitig aus (`clustering.py:588`) und ruft `cluster_vbx`
    dann nie.
    """
    if diagnose is None:                       # Default-Weg: KEIN Patch, byte-identisch
        return contextlib.nullcontext()
    return _Sonden(pipe, diagnose)


@contextlib.contextmanager
def _Sonden(pipe, diagnose: dict):
    cl = klass = vbx_alt = filter_alt = None
    try:
        from pyannote.audio.pipelines import clustering as cl
        vbx_alt = getattr(cl, "cluster_vbx", None)
        klass = type(pipe.clustering)
        filter_alt = getattr(klass, "filter_embeddings", None)
    except Exception:                          # pyannote anders gebaut -> ohne Diagnose weiter
        pass

    def sonde_vbx(*a, **kw):
        # Das ENTPACKEN gehoert in den suppress, nicht davor (beide Reviewer, unabhaengig).
        # `q, sp = vbx_alt(...)` schrieb die Aritaet als Konstante fest und warf bei einer
        # geaenderten Rueckgabeform MITTEN in pyannotes Clustering — ungeschuetzt, weil das
        # suppress erst eine Zeile spaeter begann. Der Wurf reist bis in `cmd_diarize`s
        # breites `except` und ergibt „SKIP … Korrektur ohne Cluster" fuer JEDE Datei des
        # Laufs: eine reine Protokollfunktion schaltet die Sprechertrennung ab, still, mit
        # Erfolgsmeldung. Genau der Tag, fuer den die Best-effort-Architektur gebaut ist.
        raus = vbx_alt(*a, **kw)
        with contextlib.suppress(Exception):
            diagnose["pi"] = [float(x) for x in raus[1]]
        return raus

    def sonde_filter(self, embeddings, *a, **kw):
        raus = filter_alt(self, embeddings, *a, **kw)
        with contextlib.suppress(Exception):
            # `slots` = Fenster-x-Sprecher-Paare, in denen UEBERHAUPT gesprochen wird;
            # `durchgelassen` = wie viele davon ins Clustering kamen (Laenge von chunk_idx).
            #
            # **Warum nicht einfach `embeddings.shape[0] * shape[1]`** — das waere kuerzer und
            # war die erste Fassung: es zaehlt auch die stillen Paare mit. Am echten Audio
            # gemessen: angeboten 48, mit Sprache 20, durchgelassen 16 — also **20 %**
            # verworfen gegen die Sprache, aber **67 %** gegen die angebotene Menge. Ein
            # stilles Paar ist keine verlorene Sprecherpraesenz, und zwei Zahlen unter einem
            # Namen sind eine Falle.
            #
            # **Die Groessenordnung passt zur Spec-Tabelle (1.6(j): 16-32 %) — GLEICH ist sie
            # nicht nachweisbar.** Wie dort „aktive Slots" gezaehlt wurde, ist nirgends
            # erhalten (Spec, Commit und Memory geprueft: nur die Tabelle ueberlebte). Auf der
            # einen hier beidseitig gezaehlten Datei fallen „mit Sprache" und „allein
            # gesprochen" zusammen, WEIL dort nichts ueberlappt — und ausgerechnet die
            # 32-%-Zeile der Spec ist ein Gruppeninterview. Wer die Zahlen vergleicht, misst
            # eine ueberlappende Datei vorher beidseitig nach.
            #
            # `d.sum(axis=1) > 0` ist KEIN Nachbau von pyannotes `single_active_mask` (die
            # Frage dort ist „allein gesprochen", hier nur „gesprochen") — es liest die
            # Segmentierung, deren Form `(chunks, frames, speakers)` im Docstring von
            # `filter_embeddings` steht. Fehlt `segmentations`, bleibt `slots` weg: eine
            # Ueberlebensquote ohne Nenner waere schlimmer als keine.
            # ERST beide rechnen, DANN beide setzen: sonst reist ein Nenner ohne Zaehler
            # ins Sidecar, wenn `raus[1]` scheitert (gemessen: `{"pi": …, "slots": 12}`).
            # Der Kommentar versprach bisher nur die eine Richtung.
            # Kein positionaler Rueckfall auf `a[0]`: der echte Aufruf ist Keyword
            # (`clustering.py:585`), der Zweig hatte NULL Abdeckung (Mutationsprobe: 107 Tests
            # blieben gruen) — und ein Zweig, der auch ohne seine Logik gruen bleibt, ist
            # Dekoration.
            slots = int((kw["segmentations"].data.sum(axis=1) > 0).sum())
            durchgelassen = int(len(raus[1]))
            diagnose["slots"], diagnose["durchgelassen"] = slots, durchgelassen
        return raus

    eigenes = klass is not None and "filter_embeddings" in vars(klass)
    # Das `try` faengt AUCH die Installation, nicht nur den `yield`. Wirft die zweite
    # Zuweisung, verliesse der Generator seinen Koerper davor — und der vbx-Patch bliebe
    # prozessweit stehen. Die naechste Datei laese dann die stehengebliebene Sonde als
    # Original, schriebe in das tote `diagnose` der Vorgaengerin, und das `finally` stellte
    # am Ende die Sonde statt der echten Funktion wieder her; die Kette waechst mit jeder
    # Datei. Dieselbe Klasse, die der `_Sprachschwelle`-Proxy in `transcribe.py` gekostet hat,
    # nur durch eine Tuer, die das `finally` nicht abdeckte. Heute nicht erreichbar
    # (`VBxClustering` ist eine gewoehnliche Klasse) — die Tuer kostet nichts.
    try:
        if vbx_alt is not None:
            cl.cluster_vbx = sonde_vbx
        if filter_alt is not None:
            klass.filter_embeddings = sonde_filter
        yield
    finally:
        if vbx_alt is not None:
            cl.cluster_vbx = vbx_alt
        if filter_alt is not None:
            if eigenes:
                klass.filter_embeddings = filter_alt
            else:
                with contextlib.suppress(AttributeError):
                    delattr(klass, "filter_embeddings")


def _load_waveform(audio_path: str) -> dict:
    """Audio -> {'waveform': (1,time) float32-Tensor, 'sample_rate': 16000} via
    faster_whisper.decode_audio. Umgeht das kaputte torchcodec-Decoding von pyannote —
    plattformunabhaengig, nicht als Windows-Sonderfall: auf Windows UND macOS gemessen,
    Linux nicht (#517).

    Bis #517 stand hier „auf Windows kaputt", und das war eine Falle: wer daraus schloss,
    der Umweg sei auf macOS verzichtbar, braeche jede frische Installation dort. Gemessen
    auf Apple Silicon, frische venv aus der Ersteinrichtung (2026-09-02): torchcodec 0.16.0,
    `torchcodec.ffmpeg_major_version` ist None, `AudioDecoder(...)` wirft `RuntimeError:
    Could not load libtorchcodec` — obwohl Homebrew-ffmpeg 8.1.2 installiert ist (die
    gewachsene venv derselben Maschine mit 0.15.0 fand es noch). pyannotes eigene Wache
    (`pyannote/audio/core/io.py:42-54`) faengt nur einen fehlschlagenden IMPORT; der gelingt,
    erst der Decoder scheitert — `TORCHCODEC_AVAILABLE` bleibt True, keine Warnung, leeres
    stderr. Linux ist ungeprueft, dieselbe Ursache liegt nahe. Der Test
    `test_load_waveform_liefert_die_wellenform_in_memory` haelt fest, dass die Wellenform
    hier in-memory entsteht und `diarize_file` genau sie an die Pipeline reicht.

    Vorher lief das ueber whisper.load_audio, das ffmpeg als BINARY per subprocess rief —
    weshalb hier ein eigenes _ensure_ffmpeg stand (winget legt fuer Gyan.FFmpeg keinen
    Link in WinGet\\Links, `where ffmpeg` findet es also nie). decode_audio dekodiert
    in-process ueber PyAV, das faster-whisper ohnehin mitbringt: kein Binary, kein
    PATH-Gefummel, ein Prozess weniger. Rueckgabe ist wie zuvor float32 numpy, 16 kHz mono."""
    import torch
    from faster_whisper import decode_audio
    samples = decode_audio(audio_path, sampling_rate=16000)
    return {"waveform": torch.from_numpy(samples).unsqueeze(0), "sample_rate": 16000}


def diarize_file(audio_path: str, min_speakers: int = 2, num_speakers: int | None = None,
                 diagnose: dict | None = None) -> list:
    """Diarisiert eine Audiodatei -> [{'start','end','cluster'}] (zeitlich sortiert).
    'cluster' ist das rohe pyannote-Label (z.B. 'SPEAKER_00'). Audio wird in-memory
    geladen (torchcodec-Bypass, auf jeder Plattform noetig — siehe _load_waveform, #517).

    `num_speakers` ist die vom Nutzer angegebene EXAKTE Sprecherzahl; `None` laesst pyannote
    schaetzen (Verhalten wie bisher).

    `diagnose` ist ein OPTIONALES dict, das der Aufrufer mitgibt und nach dem Lauf ausliest
    (#275): es fuellt sich mit `pi` (dem VBx-Gewichtsspektrum — das Eigengap-Analogon fuer
    "wie knapp war das?") und `slots`/`durchgelassen` (Ueberlebensquote des
    Embedding-Filters). `None` heisst "keine Diagnose" und setzt keinen Patch.

    „Embedding-Filter", nicht „`min_active_ratio`-Filter": `filter_embeddings` verwirft
    ausserdem NaN-Einbettungen (`clustering.py:120-124`). `slots - durchgelassen` vermischt
    also zwei Ursachen, und der engere Name behauptete eine Trennschaerfe, die es nicht gibt.

    **Fehlt `pi`, sagt `durchgelassen`, warum:** unter 2 steigt `VBxClustering.__call__`
    vorzeitig aus (`clustering.py:588`) und ruft `cluster_vbx` nie — die Diagnose ist dann
    vollstaendig, nur ohne Spektrum. Ab 2 hat der Griff versagt. Ohne diese Unterscheidung
    sind beide Faelle von aussen gleich, und der Block behauptete „gemessen" fuer einen, in
    dem nichts gemessen wurde.

    **Warum entweder-oder statt beides:** NICHT, weil pyannote das zurueckweisen wuerde — das
    stand hier und ist nachgemessen falsch. `pipelines/utils/diarization.py:58` macht
    `min_speakers = num_speakers or min_speakers or 1`, ueberschreibt die Untergrenze also
    kommentarlos („override {min|max}_num_speakers by num_speakers when available"), und
    pyannotes eigener Docstring sagt „Has no effect when `num_speakers` is provided". Beides
    zu schicken waere also wirkungslos, nicht fatal — und genau deshalb geht es nicht mit:
    ein mitgeschicktes `min_speakers` behauptete am Aufrufort eine Wirkung, die es nicht hat,
    und der naechste Leser suchte den Fehler dann in der falschen Zeile.

    **Warum die Zahl und nicht die Clustering-Parameter**, an Marcus' Rhyathlon-Material
    gemessen (Kameramikrofon, Schweizerdeutsch, 2 Dateien, Ground Truth 4 bzw. 5 Sprecher):
    `threshold` 0.60 → 0.55 → 0.50 lieferte **identische** Cluster — AHC ist bei VBxClustering
    nur die Initialisierung, die VB-Iteration zieht danach wieder zusammen. `Fb` wirkt, aber
    als Zerstaeuber: 0.3 ergab 4 bzw. **9**, 0.1 ergab 7 bzw. **13** Cluster. Nur die
    vorgegebene Zahl trifft, und zwar exakt — sie ist ausserdem die einzige Information, die
    ohnehin nur der Mensch hat, der dabei war.
    """
    grenzen = {"num_speakers": num_speakers} if num_speakers else {"min_speakers": min_speakers}
    pipe = _pipeline()
    # `diagnose=None` setzt KEINEN Patch. Das schuetzt Tests und Fremdaufrufer
    # (`tools/diar_eval.py`), NICHT die Produktion: `cmd_diarize` uebergibt immer ein dict,
    # der Patch ist im echten Lauf also die Regel. „Byte-identisch bei `diagnose=None`" waere
    # als Sicherheitsaussage ueber den Betrieb irrefuehrend — die Absicherung des echten Wegs
    # ist der Durchreich-Charakter der Sonden, nicht dieser Zweig.
    with _diagnose_sonden(pipe, diagnose):
        output = pipe(_load_waveform(audio_path), **grenzen)
    # pyannote 4.x/community-1 liefert ein DiarizeOutput-Objekt; die Annotation (mit
    # itertracks) steckt in .speaker_diarization. Ältere Versionen geben die Annotation
    # direkt zurück -> getattr-Fallback macht diarize_file robust gegen beide APIs.
    annotation = getattr(output, "speaker_diarization", output)
    turns = [{"start": float(t.start), "end": float(t.end), "cluster": spk}
             for t, _, spk in annotation.itertracks(yield_label=True)]
    turns.sort(key=lambda t: (t["start"], t["end"]))
    return turns


def assign_clusters(raw: dict, turns: list) -> dict:
    """Ordne jeder Roh-Segment-ID ein 'Sprecher N'-Label zu (N nach erster zeitlicher
    Erscheinung des Clusters). Zuordnung per grösster Gesamt-Überlappung; Segmente ohne
    Überlappung erben das vorige Label (bzw. den frühesten Cluster)."""
    order = {}                                   # cluster -> 1-basige Nummer nach erster Erscheinung
    for t in sorted(turns, key=lambda t: (t["start"], t["end"])):
        order.setdefault(t["cluster"], len(order) + 1)
    label = {c: f"Sprecher {n}" for c, n in order.items()}
    earliest = min(order, key=order.get) if order else None

    out, prev = {}, None
    for seg in raw.get("segments", []):
        s, e = seg.get("start"), seg.get("end")
        by_cluster = {}
        for t in turns:
            ov = max(0.0, min(e, t["end"]) - max(s, t["start"]))
            if ov > 0:
                by_cluster[t["cluster"]] = by_cluster.get(t["cluster"], 0.0) + ov
        if by_cluster:
            # Gleichstand (exakt gleicher Overlap) ist deterministisch: max() nimmt den ersten
            # Cluster in Turn-Reihenfolge. Real quasi nie, da Overlaps praktisch nie exakt gleich sind.
            spk = label[max(by_cluster, key=by_cluster.get)]
        else:
            spk = prev if prev is not None else (label[earliest] if earliest else "Sprecher 1")
        out[seg.get("id")] = spk
        prev = spk
    return out
