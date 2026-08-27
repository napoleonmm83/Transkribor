#!/usr/bin/env python
"""Transkribor - Whisper-Transkription pro Projekt.

Nutzung:
    python transcribe.py <projekt>        # projekte/<projekt>/audio -> transkripte
    python transcribe.py --all            # alle Projekte
    python transcribe.py --list           # Projekte auflisten

Audio liegt in  projekte/<projekt>/audio/  (oder direkt in projekte/<projekt>/).
Ergebnis in     projekte/<projekt>/transkripte/  als .json / .raw.txt / .segments.txt
Optionaler Kontext: projekte/<projekt>/kontext.md — geht NICHT mehr an Whisper (als
initial_prompt kostete er ganze Passagen, siehe _opts), sondern nur in die LLM-Korrektur.

Umgebungsvariablen: WHISPER_MODEL (default large-v3), WHISPER_LANG (default de).
"""
import sys, os, json, glob, math, time, argparse, re
from shutil import which

ROOT = os.path.dirname(os.path.abspath(__file__))
# Gepackt liegen die Projekte in userData, nicht neben dem Code (Program Files ist
# schreibgeschuetzt): backend.js setzt TRANSKRIBOR_PROJEKTE, webtool/paths.py liest es.
# Hier bewusst gespiegelt statt importiert — das Skript muss ohne webtool laufen.
PROJEKTE = os.environ.get("TRANSKRIBOR_PROJEKTE") or os.path.join(ROOT, "projekte")
AUDIO_EXT = (".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma", ".mp4")
# Homebrew-Pfade: GUI-Apps erben auf macOS ein anderes PATH als die Shell — per brew
# installiertes ffmpeg ist im Terminal da und fuer die App unsichtbar.
POSIX_FFMPEG_DIRS = ("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin")


def ensure_ffmpeg():
    """ffmpeg auf PATH sicherstellen (Whisper braucht das Binary)."""
    if which("ffmpeg"):
        return True
    if sys.platform == "win32":
        for d in glob.glob(os.path.expandvars(
                r"%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*\ffmpeg*\bin")):
            if os.path.exists(os.path.join(d, "ffmpeg.exe")):
                os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
                return True
        print("WARN: ffmpeg nicht gefunden. Installiere: winget install Gyan.FFmpeg",
              file=sys.stderr)
        return False
    for d in POSIX_FFMPEG_DIRS:
        if os.path.exists(os.path.join(d, "ffmpeg")):
            os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
            return True
    hinweis = ("brew install ffmpeg" if sys.platform == "darwin"
               else "sudo apt install ffmpeg")
    print(f"WARN: ffmpeg nicht gefunden. Installiere: {hinweis}", file=sys.stderr)
    return False


def fmt(t):
    m, s = divmod(int(t), 60)
    h, m = divmod(m, 60)
    return (f"{h:d}:{m:02d}:{s:02d}" if h else f"{m:d}:{s:02d}")


def audio_dir(proj_dir):
    a = os.path.join(proj_dir, "audio")
    return a if os.path.isdir(a) else proj_dir


def list_projects():
    if not os.path.isdir(PROJEKTE):
        return []
    return sorted(d for d in os.listdir(PROJEKTE)
                  if os.path.isdir(os.path.join(PROJEKTE, d)))


def find_audio(proj_dir, only=None):
    """Audiodateien des Projekts. only=[basisnamen] beschraenkt auf genau diese
    (URL-Import: nur das eben Geladene transkribieren, nicht das ganze Projekt)."""
    ad = audio_dir(proj_dir)
    files = [f for f in sorted(glob.glob(os.path.join(ad, "*")))
             if f.lower().endswith(AUDIO_EXT)]
    if only is not None:
        want = {only} if isinstance(only, str) else set(only)
        files = [f for f in files
                 if os.path.splitext(os.path.basename(f))[0] in want]
    return files


try:
    # 0.5, und dieser Wert hat eine Geschichte, die man kennen muss.
    #
    # Zuerst stand hier 0.7, kalibriert an SYNTHETISCHEM Testaudio (TTS-Englisch, sauberer
    # Studioton): dort wird Englisch mit p=0.938 erkannt. An echtem Material stimmt das
    # nicht. Gemessen an einem echten Beitrag (12:24, deutscher Sprecherton mit einem
    # englischen Interview bei 4:00), Erkennung je 30-s-Fenster:
    #
    #     echtes Deutsch, 26 Fenster    p = 0.980 … 1.000
    #     echtes Englisch (mit Publikum) p = 0.565      <- die Passage, um die es geht
    #     Stille / Abspann               p = 0.289
    #
    # Mit 0.7 wurde die englische Passage zurueck auf Deutsch geklemmt — die Funktion
    # versagte an genau dem Video, fuer das sie gebaut wurde. Die brauchbare Spanne ist
    # (0.29 … 0.57]; 0.5 liegt darin.
    #
    # Die eigentliche Lehre steht nicht in der Zahl: die Trennung laeuft NICHT zwischen
    # "sichere" und "unsichere" Erkennung, sondern zwischen "sicherem Deutsch" (>=0.98) und
    # allem anderen. Echtes fremdsprachiges Interviewaudio ist fuer den Detektor knapp —
    # 0.565 gegen 0.327 fuer Deutsch. Wer diesen Wert anfasst, misst an ECHTEM Material,
    # nicht an TTS.
    #
    # Auf [0,1] geklemmt, nicht nur ValueError abgefangen: TRANSKRIBOR_MIX_SCHWELLE=2 haette
    # JEDEN Sprachwechsel still abgeschaltet (nichts erreicht je die Schwelle), =0 die
    # Klemmung — und window_languages saehe in beiden Faellen unauffaellig aus.
    #
    # isfinite ZUSAETZLICH, weil `float("nan")` KEIN ValueError wirft: nan faellt durch beide
    # Vergleiche (jeder Vergleich mit nan ist falsch), `max(0.0, nan)` liefert 0.0, und damit
    # waere die Klemmung genau so still abgeschaltet, wie der Absatz darueber es als Fehler
    # beschreibt. Gleiches gilt fuer inf/-inf.
    _roh = float(os.environ.get("TRANSKRIBOR_MIX_SCHWELLE") or 0.5)
    MIX_SCHWELLE = min(1.0, max(0.0, _roh)) if math.isfinite(_roh) else 0.5
except ValueError:
    MIX_SCHWELLE = 0.5


class _Sprachschwelle:
    """Delegierender Proxy um das ct2-Modell: klemmt unsichere Sprachwechsel auf die
    Ankersprache.

    faster-whisper nimmt bei multilingual=True die beste Erkennung UNGEPRUEFT
    (faster_whisper/transcribe.py:1192) — eine Schwelle gibt es dort nicht.
    `language_detection_threshold` gilt nur der einmaligen Erkennung am Anfang, nicht der
    pro Fenster. Gemessen an einem echten Beitrag meldete die Erkennung ueber dem Abspann
    (keine Sprache) „Englisch" mit p=0.289 — dort ist ein Sprachwechsel sinnlos. Die Schwelle
    haelt solche Faelle heraus, ohne echte Wechsel zu verschlucken; wo sie liegen darf, steht
    bei MIX_SCHWELLE.

    Anker None (Sprache 'auto'): die ERSTE Erkennung wird zum Anker, ungeachtet ihrer
    Konfidenz — bewusst nicht „die erste sichere".

    Der Grund ist die Uebereinstimmung mit der Roh-JSON: faster-whisper legt `info.language`
    am ersten Fenster fest und nimmt dort die beste Erkennung, sobald sie
    `language_detection_threshold` (0.5) erreicht. `correct._ziel_dialekt` loest 'auto'
    spaeter aus eben diesem `info.language` auf. Wartete der Anker stattdessen auf ein
    besonders sicheres Fenster, koennte er auf einer SPAETEREN Sprache einrasten als der,
    die in der Datei steht — bei einem Video mit fremdsprachigem Vorspann liefen Anker und
    Roh-JSON auseinander, und ab da klemmte jedes unsichere Fenster auf die falsche Sprache.
    Die erste Erkennung zu nehmen haelt beide zusammen, unabhaengig davon, wo MIX_SCHWELLE
    gerade steht.

    `fenster` protokolliert [erkannt, p, benutzt] je Aufruf — reine Diagnose. Eine strenge
    Zuordnung Fenster -> Segment ist damit NICHT moeglich: ein stilles Fenster verbraucht
    eine Erkennung, ohne ein Segment zu erzeugen, und Segment hat kein language-Feld.
    """

    def __init__(self, echt, anker, schwelle):
        self._echt, self._anker, self._schwelle = echt, anker, schwelle
        self.fenster = []

    def detect_language(self, enc):
        r = self._echt.detect_language(enc)
        tok, p = r[0][0]
        code = tok[2:-2]
        if self._anker is None:
            self._anker = code          # erste Erkennung = Anker, wie faster-whispers info.language
        elif code != self._anker and p < self._schwelle:
            self.fenster.append([code, round(p, 3), self._anker])
            return [[(f"<|{self._anker}|>", 1.0)]]
        self.fenster.append([code, round(p, 3), code])
        return r

    def __getattr__(self, name):
        return getattr(self._echt, name)


def _opts(language, mehrsprachig=False):
    """Decoder-Parameter an einer Stelle. Identisch zur frueheren openai-whisper-Fassung,
    bis auf zwei Namenswechsel: `fp16` ist bei faster-whisper das `compute_type` des
    Konstruktors (siehe _modell), und `verbose=False` heisst hier `log_progress=True` —
    beides erzeugt denselben tqdm-Balken, aus dem das Frontend die Prozente liest.

    `vad_filter=False` steht ausdruecklich da: es ist zwar der Default, wuerde aber Stille
    ueberspringen und damit die Segmentzeiten gegen das Audio verschieben — der Editor
    synchronisiert Text und Wiedergabe ueber genau diese Zeiten.

    KEIN `initial_prompt`, und das ist die wichtigste Zeile hier. Er stand einmal darin
    ("Interview auf Schweizerdeutsch …", bzw. der Inhalt von kontext.md) und brachte den
    Decoder dazu, ein 30-Sekunden-Fenster VORZEITIG zu beenden; Whisper schiebt den
    Lesezeiger daraufhin um das ganze Fenster weiter, und die restliche Sprache darin wird
    nie angeschaut. Kein falsches Wort, sondern gar keines — und nichts im Ergebnis, woran
    man es saehe. Gemessen am selben Audio, ganze Dateien, sonst identische Parameter:

        01172464 (9:27)   mit Prompt 1226 Woerter / 492s   ohne 1346 / 528s
        C0701    (3:26)   mit Prompt  454 Woerter / 156s   ohne  590 / 163s
        C0761    (0:52)   mit Prompt  140 Woerter /  45s   ohne  158 /  45s

    In deinem Beispielfall fehlten damit 18 s am Stueck — ausgerechnet die Antwort auf die
    erste Frage. 17 von 37 vorhandenen Aufnahmen trugen die Signatur.

    Seinen erklaerten Zweck erfuellte er dabei nicht: Schweizerdeutsch-Marker (isch, nöd,
    gsi, öppis, …) kamen in KEINEM der Laeufe vor, mit Prompt wie ohne — Whisper normalisiert
    Deutsch von sich aus. Mit kontext.md schadete er zusaetzlich, weil deren Markdown-Stil
    abfaerbte (kleingeschrieben, ohne Satzzeichen). `condition_on_previous_text` ist NICHT
    beteiligt, das wurde getrennt geprueft (auf False bleibt die Luecke bestehen).

    Ein falsch gehoertes Wort holt die LLM-Korrektur mit dem gemeinsamen Glossar zurueck;
    eine Passage, die Whisper nie gelesen hat, kann niemand mehr zurueckholen. kontext.md
    bleibt erhalten und geht unveraendert als `context` in die Korrektur (webtool/correct.py).

    `mehrsprachig=True` setzt ZWEI Parameter, und die gehoeren untrennbar zusammen:
    `multilingual=True` laesst faster-whisper die Sprache pro 30-s-Fenster neu erkennen —
    aber ohne `condition_on_previous_text=False` bleibt das WIRKUNGSLOS. faster-whisper
    setzt zwar den Tokenizer pro Fenster um (faster_whisper/transcribe.py:1197), setzt aber
    `prompt_reset_since` nicht zurueck; der deutsche Vorlauf reist als Prompt mit und
    schlaegt das <|en|>-Token, worauf Whisper uebersetzt statt zu transkribieren.
    Gemessen an echtem Audio mit 40 s englischem Einschub, sonst gleiche Parameter:

        nur multilingual   "Ich kam hier aus Manchester mit meinem Klub."
        beides             "I came here from Manchester with my club."

    Nur fuer als mehrsprachig markierte Dateien: auf einsprachigem Material ist es messbar
    schlechter (dort blieben von 206 Segmenttexten nur 89 identisch, und ein Fenster mit
    p=0.289 kippte auf Englisch samt eingeschobenem Satz)."""
    o = dict(
        language=language, task="transcribe",
        word_timestamps=True, beam_size=5, best_of=5,
        temperature=(0.0, 0.2, 0.4, 0.6, 0.8, 1.0),
        condition_on_previous_text=True,
        repetition_penalty=1.1,
        vad_filter=False, log_progress=True,
    )
    if mehrsprachig:
        o["multilingual"] = True
        o["condition_on_previous_text"] = False
    return o


def bereinige_wiederholungs_schleifen(segmente: list, max_wiederholungen: int = 2) -> list:
    """Filtert ausufernde ASR-Wiederholungsschleifen (Halluzinationen über Musik/Stille).

    Behaelt bis zu `max_wiederholungen` aufeinanderfolgende Kopien eines identischen Satzes,
    kappt darueber hinausgehende Wiederholungen und nummeriert die Segment-IDs durchgehend neu.
    """
    if not segmente:
        return []
    out = []
    letzter_norm = None
    wiederholungs_zaehler = 0

    for seg in segmente:
        norm = re.sub(r"[^\w\s]", "", (seg.get("text") or "").lower()).strip()
        if not norm:
            out.append(seg)
            letzter_norm = None
            wiederholungs_zaehler = 0
            continue
        if norm == letzter_norm:
            wiederholungs_zaehler += 1
            if wiederholungs_zaehler < max_wiederholungen:
                out.append(seg)
        else:
            letzter_norm = norm
            wiederholungs_zaehler = 0
            out.append(seg)

    for i, s in enumerate(out):
        if isinstance(s, dict) and "id" in s:
            s["id"] = i
    return out


def _cuda_dlls_auf_pfad():
    """cuBLAS/cuDNN fuer CTranslate2 auffindbar machen — sonst stirbt der erste GPU-Lauf mit
    "Library cublas64_12.dll is not found or cannot be loaded".

    CTranslate2 bringt diese Bibliotheken NICHT mit, torch (cu128) schon. Gemessen:
    `os.add_dll_directory()` reicht NICHT — CTranslate2 laedt per plainem LoadLibrary, das
    die add_dll_directory-Liste nicht konsultiert. Nur PATH wirkt.
    Auf POSIX loest der Lader beim Laden auf; dort genuegt, dass torch vorher importiert
    ist (seine .so sind dann schon im Prozess)."""
    try:
        import torch
    except ImportError:
        return
    datei = getattr(torch, "__file__", None)   # fehlt bei Namespace-/eingefrorenen Paketen
    if not datei:
        return
    lib = os.path.join(os.path.dirname(datei), "lib")
    if sys.platform == "win32" and os.path.isdir(lib):
        os.environ["PATH"] = lib + os.pathsep + os.environ.get("PATH", "")


def _modell(model, device):
    _cuda_dlls_auf_pfad()                       # VOR dem Import: so lief der gepruefte Fall
    from faster_whisper import WhisperModel
    # int8 auf der CPU: float16 ist dort teils gar nicht implementiert und sonst langsam.
    #
    # `cpu_threads` bleibt beim Default (4) — das ist gemessen, nicht vergessen. Auf einem
    # M1 Pro (6 Performance-, 2 Effizienzkerne, 2.0 Min Audio, large-v3):
    #     4 Threads (Default)  82s   1.45x    <- schnellste Variante
    #     6 Threads           104s   1.14x
    #     8 Threads           171s   0.70x
    # Alle Kerne zu nehmen halbiert den Durchsatz: CTranslate2 synchronisiert je Schicht,
    # und sobald Threads auf den Effizienzkernen landen, wartet der ganze Block auf sie.
    # int8_float32 lag bei gleicher Threadzahl im Rauschen (101.7s gegen 104.4s).
    return WhisperModel(model, device=device,
                        compute_type="float16" if device == "cuda" else "int8")


def _ergebnis(segmente, info):
    """(Segment-Generator, TranscriptionInfo) -> genau die dict-Form, die openai-whisper
    lieferte. `<base>.json` ist das Roh-Dokument, aus dem `edit_model.build_edit_doc` und
    `tag_uncertain_segments` lesen — die Struktur ist ein Vertrag, kein Zwischenformat.
    `asdict` uebernimmt auch seek/tokens/temperature, damit nichts still wegfaellt."""
    from dataclasses import asdict
    segs = [asdict(s) for s in segmente]        # ERST hier laeuft die Transkription (lazy)
    segs = bereinige_wiederholungs_schleifen(segs)
    return {"text": "".join(s["text"] for s in segs),
            "segments": segs,
            "language": info.language,
            # Die Laenge der AUFNAHME, nicht die des Transkripts — ohne sie ist ein
            # uebersprungenes Fenster am DATEIENDE nicht bemerkbar (siehe `luecken`).
            "duration": info.duration}


# Ab welcher Laenge ein Abschnitt ohne Segment gemeldet wird. Whispers Fenster ist 30 s; der
# belegte Verlust aus #82 war ein Stueck von 18 s. Darunter liegt der Alltag: eine Denkpause,
# ein Themenwechsel, das Umsetzen des Mikrofons. Die Zahl soll jemanden HINSCHAUEN lassen,
# nicht selbst entscheiden — eine Luecke ist nicht automatisch Stille (im belegten Fall war der
# uebersprungene Abschnitt mit -30 bis -40 dB LAUTER als der transkribierte davor mit -45 dB).
LUECKE_MIN_S = 15.0


def luecken(segmente, dauer=None, schwelle=LUECKE_MIN_S):
    """Abschnitte ohne Segment, die MINDESTENS `schwelle` lang sind -> [{start, end, dauer}].

    `>=`, nicht `>`: die Konstante heisst `LUECKE_MIN_S`, das Issue sagt „ab 15 s" und die
    README „laenger als eine Viertelminute" — mit `>` faellt genau die Grenze heraus, und
    eine Wache, deren Beschriftung schaerfer ist als ihr Code, ist der haeufigste Fehler in
    diesem Repo (CodeRabbit an PR #212). Praktisch entscheidet es nichts (exakt 15,000 s ist
    bei Fliesskomma-Zeiten ein Sonderfall) — die Uebereinstimmung entscheidet es.

    **Der einzige Weg, einen uebersprungenen Whisper-Block zu sehen (#83).** Whisper kann ein
    30-Sekunden-Fenster ungelesen weiterschieben, ohne dass irgendetwas im Ergebnis darauf
    hinweist: kein Flag, keine Warnung, kein auffaelliger `avg_logprob`. Genau das tat der
    `initial_prompt` (#82) — **17 von 37** Aufnahmen trugen den Schaden ueber Wochen, und
    bemerkt wurde er erst, als ein Nutzer beim Lesen die fehlende Antwort auf die erste Frage
    vermisste. **Qualitaetsschwellen taugen dafuer nicht**: es gibt dort kein schlechtes
    Segment, es gibt gar keines. Nur die Abdeckung sieht fehlenden Inhalt.

    Der Prompt ist weg, die Klasse nicht — die no-speech-Schwelle und degenerierte
    Decoder-Zustaende ueberspringen ebenso, und jede kuenftige Parameteraenderung kann
    dasselbe stille Loch erzeugen.

    Reine Funktion: der Wert der Wache haengt an den Raendern (Anfang vor dem ersten Segment,
    Ende nach dem letzten, ein Ergebnis ganz OHNE Segmente), und die will man ohne 3 GB Modell
    und echtes Audio pruefen koennen. `dauer=None` (unbekannt) heisst: das Dateiende bleibt
    ungeprueft, alles davor nicht.
    """
    # **Sortiert, und das ist kein Vorsichtsmassnahme-`sorted`.** Beide Engines liefern ihre
    # Segmente heute der Reihe nach; kommt trotzdem etwas Unsortiertes an (von Hand
    # bearbeitete `<base>.json`, eine kuenftige Engine), meldete die Schleife eine Luecke, die
    # es nicht gibt: bei [30-40, 0-12] laeuft die Marke erst auf 40 und sieht das spaetere
    # 0-12 nie — Ergebnis waere „0-30 fehlt" statt richtig „12-30". Ein Waechter gegen stillen
    # Verlust, der selbst Falsches meldet, verbraucht genau das Vertrauen, von dem er lebt.
    # (Der Kommentar hier behauptete das vorher schon, ohne dass der Code es konnte —
    # CodeRabbit-CLI an PR #212.)
    paare = sorted((s["start"], s["end"]) for s in segmente
                   # ein Segment ohne Zeiten sagt ueber Abdeckung nichts
                   if isinstance(s.get("start"), (int, float))
                   and isinstance(s.get("end"), (int, float)))
    stand, raus = 0.0, []
    for start, ende in paare:
        if start - stand >= schwelle:
            raus.append({"start": stand, "end": start, "dauer": start - stand})
        # `max`, nicht `ende`: ein KUERZERES Segment innerhalb eines laengeren (Whisper
        # liefert das beim Temperatur-Rueckfall) darf die Marke nicht ZURUECKziehen — sonst
        # meldete ausgerechnet dichtes Material Luecken.
        stand = max(stand, ende)
    if isinstance(dauer, (int, float)) and dauer - stand >= schwelle:
        raus.append({"start": stand, "end": dauer, "dauer": dauer - stand})
    return raus


def _datei_sprachwahl(proj_dir, base, fallback):
    """(Whisper-Sprach-Code, mehrsprachig) fuer EINE Datei aus projekt.json.

    EIN Lesevorgang fuer beide Werte (projekt.datei_einstellungen) — zwei Einzelaufrufe
    laden projekt.json zweimal, pro Datei, in einer Schleife ueber ein ganzes Projekt.
    Lazy import wie schon `from webtool import device`: das Grund-Skript laeuft ohne das
    Paket, nur die Aufloesung braucht es. Fehlt projekt.json, gilt `fallback`
    (= WHISPER_LANG, Legacy-Verhalten) und nicht mehrsprachig. 'auto' -> None (Whisper
    erkennt selbst)."""
    try:
        from webtool import projekt as _p, sprachen as _s
        sprache, mehr = _p.datei_einstellungen(os.path.basename(proj_dir), base)
        return _s.whisper_code(sprache), mehr
    except Exception:
        return fallback, False


def _braucht_faster_whisper(engine, mehr):
    """Laeuft DIESE Datei ueber faster-whisper statt whisper.cpp?

    whisper.cpp ruft whisper-cli mit einem FESTEN -l und kennt keine Erkennung pro Fenster.
    Eine gemischte Datei faellt deshalb auf faster-whisper zurueck — der VIERTE dokumentierte
    Rueckfall (neben: kein Apple Silicon, whisper-cli fehlt, keine GGML-Datei). Langsamer,
    aber richtig; ein einsprachiges Transkript ohne jede Fehlermeldung waere schlechter.

    Eigene Funktion, weil zwei Stellen dieselbe Frage stellen: der Aufrufer, um das Modell
    rechtzeitig zu laden, und _transkribiere_datei, um den Weg zu waehlen. Zweimal
    ausgeschrieben waeren es zwei Wahrheiten.
    """
    return engine != "whisper.cpp" or mehr


def _transkribiere_datei(m, engine, f, sprache, mehr, model):
    """EINE Aufnahme transkribieren -> Ergebnis-dict.

    Das Modell wird hier NICHT erzeugt, sondern vom Aufrufer erwartet. Zuerst tat es das und
    gab `m` zurueck — dann ging das Modell bei jeder Ausnahme verloren, weil die
    Tupel-Zuweisung beim Aufrufer ausfiel: auf einem Mac mit mehreren fehlerhaften gemischten
    Dateien laed jeder Versuch erneut ~3 GB.

    Eigene Funktion und nicht inline in transcribe_project: die Schleife dort ist schon lang,
    und dies ist die einzige Stelle, an der ein Mac ein anderes Ergebnis bekommt als ein PC —
    die will man am Stueck lesen und einzeln pruefen koennen, ohne echtes Audio und 3 GB Modell.
    """
    if not _braucht_faster_whisper(engine, mehr):
        from webtool import whispercpp
        return whispercpp.transkribiere(f, model, sprache)
    proxy = _Sprachschwelle(m.model, sprache, MIX_SCHWELLE) if mehr else None
    if proxy is not None:
        m.model = proxy
    try:
        result = _ergebnis(*m.transcribe(f, **_opts(sprache, mehr)))
    finally:
        # Zwingend im finally: eine kaputte Datei ueberspringt der Lauf und macht weiter
        # (die Regel steht im Aufrufer). Das Modell wird von allen Dateien geteilt — ein
        # haengengebliebener Proxy klemmte die naechste, einsprachige Datei auf eine
        # fremde Ankersprache.
        if proxy is not None:
            m.model = proxy._echt
    if proxy is not None:
        result["window_languages"] = proxy.fenster
        # Der einzige Fehlermodus des Features sind grundlose Sprachwechsel — ohne diese Zeile
        # hat er keine sichtbare Ausgabe: window_languages liest sonst niemand.
        fremde = sorted({f[2] for f in proxy.fenster} - {sprache})
        geklemmt = sum(1 for f in proxy.fenster if f[0] != f[2])
        print(f"  {os.path.splitext(os.path.basename(f))[0]}: {len(proxy.fenster)} Fenster, "
              f"Fremdsprachen: {', '.join(fremde) or 'keine'}, {geklemmt} unsicher geklemmt",
              flush=True)
    return result


def _einzeilig(text) -> str:
    r"""Fremdtext auf EINE Zeile zwingen, bevor er in einen Job-Strom geht.

    `jobPhases.ts` liest die Job-Ausgabe zeilenweise. Ein Zeilenumbruch in einer
    Anbietermeldung oder einem Ausnahmetext macht aus einer Zeile zwei — und die zweite
    begaenne mit FREMDEM Inhalt am Zeilenanfang, koennte also jedes der ~20 `^`-verankerten
    Muster bedienen. Das faellt hier weg.

    DIE ZWEITE KLASSE liegt woanders und ist dort behoben: ein EINZEILIGER Fremdtext mit
    einem `]` darin liess `^\[.+?\] fertig …` ueber das echte Praefix hinweg backtracken.
    Dagegen half kein Falten — der Riegel sitzt jetzt im Parser (`^\[[^\]]+\] `,
    `jobPhases.ts`), weil ihn dort EINE Aenderung fuer alle 13 Klammer-Drucker schliesst,
    statt 13 Riegel zu brauchen, von denen der naechste neue fehlt.

    Diese Funktion bleibt trotzdem noetig, und zwar fuer eine Klasse, die der Parser-Riegel
    NICHT deckt: ein Zeilenumbruch gibt Fremdtext den ZEILENANFANG, und daran haengen die
    praefixlosen Muster (`^apply:`, `^→ Diarisiere`, `^✗ FEHLT/ungueltig:`) sowie
    `jobs.py`s `[scope]`/`[active]`/`[done]`. Zwei Schichten, zwei verschiedene Klassen.
    """
    return " ".join(str(text).split())


def _autocorrect_an() -> bool:
    """`TRANSKRIBOR_AUTOCORRECT` — der dokumentierte Kill-Switch der Korrektur nach der
    Transkription. Gelesen wird er im Subprozess, nicht im Server: `jobs._run_proc` reicht
    `os.environ` durch, und `settings.job_env()` fasst die Variable nicht an — der Lauf sieht
    also denselben Wert wie der Server, und der CLI-Weg sieht ihn ebenfalls."""
    return (os.environ.get("TRANSKRIBOR_AUTOCORRECT") or "1").lower() not in ("0", "false", "no")


def transcribe_project(name, model, language, only=None, autocorrect: bool = False):
    proj_dir = os.path.join(PROJEKTE, name)
    if not os.path.isdir(proj_dir):
        print(f"Projekt nicht gefunden: {name}", file=sys.stderr)
        return
    out_dir = os.path.join(proj_dir, "transkripte")
    os.makedirs(out_dir, exist_ok=True)
    files = find_audio(proj_dir, only)
    if not files:
        print(f"[{name}] keine Audiodateien in {audio_dir(proj_dir)}")
        return
    # Angefasst werden nur die Aufnahmen OHNE .json — die uebrigen ueberspringt die Schleife
    # unten ohnehin. Genau diese Liste meldet der Lauf als seinen Wirkungsbereich, bevor er
    # anfaengt: jobs.py laesst danach das Loeschen/Umbenennen aller anderen zu (Issue #80).
    offen = [b for b in (os.path.splitext(os.path.basename(f))[0] for f in files)
             if not os.path.exists(os.path.join(out_dir, b + ".json"))]
    print("[scope] " + "\t".join(offen), flush=True)
    # Vor dem Modell pruefen, ob ueberhaupt etwas offen ist: seit ein Upload die Transkription
    # selbst ausloest, laufen Leerlauf-Runden regelmaessig, und load_model kostet ~30s + 3 GB.
    if not offen:
        print(f"[{name}] nichts zu tun — {len(files)} Datei(en) bereits transkribiert", flush=True)
        return

    # kontext.md wird hier NICHT mehr gelesen: als Whisper-Prompt kostete sie Inhalt
    # (Begruendung samt Messung in _opts). Fuer die Korrektur liest correct.py sie selbst.
    from webtool import device as devicemod
    engine = devicemod.asr_engine(model)
    if engine == "whisper.cpp":
        # Apple Silicon: Metal statt CPU. Gemessen 5.29x gegen 0.81x realtime — die
        # Begruendung steht in webtool/whispercpp.py.
        print(f"[{name}] engine=whisper.cpp (Metal)", flush=True)
    else:
        device = devicemod.pick_asr()
        info = devicemod.describe(model)
        warum = (" — CTranslate2 kennt kein MPS, ASR rechnet auf der CPU"
                 if info["device"] == "mps" else "")
        print(f"[{name}] device={device} ({info['name']}){warum}", flush=True)
    print(f"[{name}] Modell {model}, {len(files)} Datei(en)", flush=True)

    t_phase = time.monotonic()
    n_ok = audio_gesamt = 0
    m = None if engine == "whisper.cpp" else _modell(model, device)

    ai_pool = None
    ai_futures = []
    _wait_futures = None
    if autocorrect and not _autocorrect_an():
        # Der Riegel sass bis v0.48.0 in `app._autocorrect`; die gestaffelte Pipeline haengt
        # die Korrektur seitdem direkt hier an und liess ihn dabei fallen (#406). Er gehoert
        # hierher und nicht in `app._start_transcribe`: der CLI-Weg
        # (`transcribe.py <projekt> --autocorrect`) geht nicht durch den Server, und ein Grund
        # im Protokoll ist mehr wert als ein weggelassenes Flag, das niemand sieht.
        # Abgeschaltet heisst die GANZE Kette: `cmd_diarize` kostet pyannote-Minuten auf der
        # GPU, und wer die Maschine ohne KI faehrt, will genau die nicht.
        print("[autocorrect] uebersprungen — TRANSKRIBOR_AUTOCORRECT=0", flush=True)
        autocorrect = False
    if autocorrect:
        try:
            from webtool import llm, correct as _correct
            ok_ai, grund_ai = llm.available()
            if ok_ai:
                from concurrent.futures import ThreadPoolExecutor, wait as _wait_futures
                ai_pool = ThreadPoolExecutor(max_workers=_correct.CLAUDE_PARALLEL)
            else:
                # Diarisierung und Prep laufen weiter: ihr Sidecar ist idempotent und spart
                # dem spaeteren `correct run` genau diese GPU-Minuten
                # (test_transcribe_project_diarize_runs_even_if_ai_unavailable haelt das fest).
                # Nur die LLM-Phase faellt aus — und sie sagt, warum. Vorher schwieg sie.
                print(f"[autocorrect] KI-Phase uebersprungen — {_einzeilig(grund_ai)}", flush=True)
        except Exception as ex:
            # Gefangen wird hier ein Wurf aus `llm.available()` oder ein Importfehler von
            # `webtool.correct` — NICHT ein fehlendes webtool-Paket: `webtool.device` wird
            # 33 Zeilen weiter oben bedingungslos importiert, ohne das Paket stirbt der Lauf
            # also laengst davor. Frueher verschwand der Fall in einem `pass` und schlug erst
            # je Datei als "Autocorrect-Fehler" auf.
            print(f"[autocorrect] KI-Phase uebersprungen — {_einzeilig(ex)}", flush=True)

    initial_files = list(files)
    processed = set()
    failed_bases = set()
    try:
        while True:
            current_files = find_audio(proj_dir, only)
            all_known = set(current_files)
            for f in initial_files:
                base = os.path.splitext(os.path.basename(f))[0]
                if base not in processed and base not in failed_bases and not os.path.exists(f):
                    all_known.add(f)
            pending = [
                f for f in all_known
                if os.path.splitext(os.path.basename(f))[0] not in processed
                and os.path.splitext(os.path.basename(f))[0] not in failed_bases
                and not os.path.exists(os.path.join(out_dir, os.path.splitext(os.path.basename(f))[0] + ".json"))
            ]
            if not pending:
                break
            pending.sort(key=lambda p: os.path.basename(p))
            f = pending[0]
            base = os.path.splitext(os.path.basename(f))[0]
            if not os.path.exists(f):
                print(f"[{name}] skip (Audio nicht mehr vorhanden): {base}", flush=True)
                failed_bases.add(base)
                continue
            out_json = os.path.join(out_dir, base + ".json")
            print(f"[active] {base}", flush=True)
            print(f"[{name}] -> transkribiere {base} …", flush=True)
            t0 = time.monotonic()
            try:
                sprache, mehr = _datei_sprachwahl(proj_dir, base, language)
                if m is None and _braucht_faster_whisper(engine, mehr):
                    m = _modell(model, devicemod.pick_asr())
                result = _transkribiere_datei(m, engine, f, sprache, mehr, model)
                dt = time.monotonic() - t0
                result["luecken"] = luecken(result.get("segments") or [], result.get("duration"))
                with open(os.path.join(out_dir, base + ".raw.txt"), "w", encoding="utf-8") as fh:
                    fh.write(result["text"].strip() + "\n")
                with open(os.path.join(out_dir, base + ".segments.txt"), "w", encoding="utf-8") as fh:
                    for seg in result["segments"]:
                        fh.write(f"[{fmt(seg['start'])} - {fmt(seg['end'])}] {seg['text'].strip()}\n")
                with open(out_json, "w", encoding="utf-8") as fh:
                    json.dump(result, fh, ensure_ascii=False, indent=1)
                dur = result.get("duration") or (result["segments"][-1]["end"] if result["segments"] else 0)
                n_ok += 1
                audio_gesamt += dur
                print(f"[{name}] fertig {base}: {dt:.0f}s, {len(result['segments'])} Segmente, "
                      f"Audio {fmt(dur)}, {dur/max(dt,1):.1f}x", flush=True)
                if result["luecken"]:
                    orte = ", ".join(f"{fmt(x['start'])}-{fmt(x['end'])}" for x in result["luecken"])
                    print(f"[{name}] ⚠ {base}: {len(result['luecken'])} Abschnitt(e) ohne Transkript "
                          f"({orte}) — bitte im Ton gegenhoeren", flush=True)

                if autocorrect:
                    try:
                        from webtool import correct as _correct
                        # 1. Diarisierung & Prep direkt auf der GPU in der Hauptschleife (Hardware geschützt):
                        _correct.cmd_diarize(name, [base])
                        _correct.prep_single(name, base)
                        # 2. Datei sofort parallel an den Cloud-KI-Threadpool übergeben:
                        if ai_pool is not None:
                            ai_futures.append(ai_pool.submit(_correct.correct_ai_single, name, base))
                    except Exception as ex:
                        # Derselbe Riegel wie oben, und hier naeher am Angreifer: `cmd_diarize`/
                        # `prep_single` lesen Transkripte, ein Wurf kann deren Inhalt zitieren.
                        print(f"[{name}] Autocorrect-Fehler bei {base}: {_einzeilig(ex)}", flush=True)
            except Exception as e:
                print(f"[{name}] FEHLER {base}: {_einzeilig(e)}", flush=True)
                failed_bases.add(base)
                continue
            finally:
                processed.add(base)
                print(f"[done] {base}", flush=True)
    finally:
        if ai_pool is not None:
            if ai_futures:
                print(f"[{name}] Warte auf verbleibende KI-Korrekturen…", flush=True)
                if _wait_futures is not None:
                    _wait_futures(ai_futures)
            ai_pool.shutdown(wait=True)

    # Der Faktor gilt dem GANZEN Lauf, Modell-Ladezeit eingerechnet — er ist damit kleiner
    # als die Einzelwerte oben und genau deshalb der ehrliche Vergleichswert.
    dt_phase = time.monotonic() - t_phase
    print(f"⏱ [{name}]: {n_ok} Datei(en) transkribiert in {dt_phase:.0f}s "
          f"(Audio {fmt(audio_gesamt)}, {audio_gesamt/max(dt_phase, 1):.1f}x)", flush=True)
    print(f"[{name}] -> {out_dir}", flush=True)


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass
    ap = argparse.ArgumentParser(description="Whisper-Transkription pro Projekt")
    ap.add_argument("projekt", nargs="?", help="Projektname (Ordner in projekte/)")
    ap.add_argument("--all", action="store_true", help="alle Projekte")
    ap.add_argument("--list", action="store_true", help="Projekte auflisten")
    ap.add_argument("--only", help="nur diese Datei (Basisname) transkribieren")
    ap.add_argument("--autocorrect", action="store_true",
                    help="Nach Whisper sofort Diarisierung und parallele KI-Korrektur streamen")
    ap.add_argument("--model", default=os.environ.get("WHISPER_MODEL", "large-v3"))
    ap.add_argument("--language", default=os.environ.get("WHISPER_LANG", "de"))
    args = ap.parse_args()

    if args.list:
        for p in list_projects():
            n = len(find_audio(os.path.join(PROJEKTE, p)))
            print(f"  {p}  ({n} Audio)")
        return
    ensure_ffmpeg()
    if args.all:
        for p in list_projects():
            transcribe_project(p, args.model, args.language, autocorrect=args.autocorrect)
    elif args.projekt:
        transcribe_project(args.projekt, args.model, args.language, only=args.only,
                           autocorrect=args.autocorrect)
    else:
        ap.print_help()


if __name__ == "__main__":
    main()
