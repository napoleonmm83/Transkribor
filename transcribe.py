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
import sys, os, json, glob, time, argparse
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
        want = set(only)
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
    MIX_SCHWELLE = min(1.0, max(0.0, float(os.environ.get("TRANSKRIBOR_MIX_SCHWELLE") or 0.5)))
except ValueError:
    MIX_SCHWELLE = 0.5


class _Sprachschwelle:
    """Delegierender Proxy um das ct2-Modell: klemmt unsichere Sprachwechsel auf die
    Ankersprache.

    faster-whisper nimmt bei multilingual=True die beste Erkennung UNGEPRUEFT
    (faster_whisper/transcribe.py:1192) — eine Schwelle gibt es dort nicht.
    `language_detection_threshold` gilt nur der einmaligen Erkennung am Anfang, nicht der
    pro Fenster. Auf einem rein deutschen Video schaltete es dadurch bei p=0.289 auf
    Englisch um und schob einen Satz ein, den niemand gesagt hat.

    Anker None (Sprache 'auto'): die ERSTE Erkennung wird zum Anker, ungeachtet ihrer
    Konfidenz. Das ist bewusst nicht „die erste sichere": faster-whisper legt `info.language`
    an genau diesem ersten Fenster fest (Schwelle 0.5, also LOCKERER als unsere 0.7), und
    `correct._ziel_dialekt` loest 'auto' spaeter aus eben diesem `info.language` auf. Wuerden
    wir auf 0.7 warten, koennte ein Video mit englischem Vorspann als `de` in die Datei
    geschrieben werden, waehrend der Anker auf `en` einrastet — ab da klemmte jedes unsichere
    deutsche Fenster auf Englisch, und Roh-JSON und Anker widersprechen sich.

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
        vad_filter=False, log_progress=True,
    )
    if mehrsprachig:
        o["multilingual"] = True
        o["condition_on_previous_text"] = False
    return o


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
    return {"text": "".join(s["text"] for s in segs),
            "segments": segs,
            "language": info.language}


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


def transcribe_project(name, model, language, only=None):
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
        #
        # KEIN `and not mehr` hier: die Engine-Entscheidung faellt VOR der Schleife, `mehr`
        # gibt es erst pro Datei. Der Rueckfall gemischter Dateien auf faster-whisper liegt
        # in _transkribiere_datei und gehoert genau dorthin. Eine Bedingung mit `mehr` an
        # dieser Stelle stirbt mit UnboundLocalError — und zwar VOR dem try/except der
        # Schleife, also ohne ein einziges Transkript. Auf Windows/Linux faellt das nie auf,
        # weil `engine != "whisper.cpp"` das `and` kurzschliesst.
        print(f"[{name}] engine=whisper.cpp (Metal)", flush=True)
    else:
        device = devicemod.pick_asr()
        info = devicemod.describe(model)
        # Auf einem Mac ohne whisper.cpp meldet describe() "mps" (das gilt der
        # Diarisierung), die ASR laeuft aber auf der CPU. Das gehoert ins Log, sonst
        # sucht der Nutzer den Fehler bei sich.
        warum = (" — CTranslate2 kennt kein MPS, ASR rechnet auf der CPU"
                 if info["device"] == "mps" else "")
        print(f"[{name}] device={device} ({info['name']}){warum}", flush=True)
    print(f"[{name}] Modell {model}, {len(files)} Datei(en)", flush=True)
    # Das Modell erst laden, wenn feststeht, dass gerechnet wird — bei whisper.cpp
    # uebernimmt das transkribiere() pro Datei (der Unterprozess haelt nichts vor).
    m = None if engine == "whisper.cpp" else _modell(model, device)

    for f in files:
        base = os.path.splitext(os.path.basename(f))[0]
        out_json = os.path.join(out_dir, base + ".json")
        if os.path.exists(out_json):
            print(f"[{name}] skip (vorhanden): {base}", flush=True)
            continue
        print(f"[{name}] -> transkribiere {base} …", flush=True)
        t0 = time.time()
        try:
            # Der ganze MPS-Rueckfall stand hier: Modell auf CPU neu laden, pruefen ob es an
            # MPS oder an der Datei lag, Geraet wiederherstellen. Mit CTranslate2 gibt es den
            # Fall nicht mehr — pick_asr() liefert nur cuda oder cpu, und beide koennen alles.
            # Bleibt die Regel, die davon uebrig ist: eine kaputte Datei ueberspringen, der
            # Lauf geht weiter. Fuer whisper.cpp gilt sie genauso.
            sprache, mehr = _datei_sprachwahl(proj_dir, base, language)
            # Das Modell hier laden, nicht in _transkribiere_datei: geht der Lauf dort schief,
            # ginge es sonst mit der ausgefallenen Tupel-Zuweisung verloren und die naechste
            # Datei laed erneut ~3 GB. Auf einem whisper.cpp-Lauf entsteht es genau dann, wenn
            # die erste gemischte Datei kommt.
            if m is None and _braucht_faster_whisper(engine, mehr):
                m = _modell(model, devicemod.pick_asr())
            result = _transkribiere_datei(m, engine, f, sprache, mehr, model)
        except Exception as e:
            print(f"[{name}] FEHLER {base}: {e}", flush=True)
            continue
        dt = time.time() - t0
        with open(out_json, "w", encoding="utf-8") as fh:
            json.dump(result, fh, ensure_ascii=False, indent=1)
        with open(os.path.join(out_dir, base + ".raw.txt"), "w", encoding="utf-8") as fh:
            fh.write(result["text"].strip() + "\n")
        with open(os.path.join(out_dir, base + ".segments.txt"), "w", encoding="utf-8") as fh:
            for seg in result["segments"]:
                fh.write(f"[{fmt(seg['start'])} - {fmt(seg['end'])}] {seg['text'].strip()}\n")
        dur = result["segments"][-1]["end"] if result["segments"] else 0
        print(f"[{name}] fertig {base}: {dt:.0f}s, {len(result['segments'])} Segmente, "
              f"Audio {fmt(dur)}, {dur/max(dt,1):.1f}x", flush=True)

    print(f"[{name}] -> {out_dir}", flush=True)


def main():
    ap = argparse.ArgumentParser(description="Whisper-Transkription pro Projekt")
    ap.add_argument("projekt", nargs="?", help="Projektname (Ordner in projekte/)")
    ap.add_argument("--all", action="store_true", help="alle Projekte")
    ap.add_argument("--list", action="store_true", help="Projekte auflisten")
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
            transcribe_project(p, args.model, args.language)
    elif args.projekt:
        transcribe_project(args.projekt, args.model, args.language)
    else:
        ap.print_help()


if __name__ == "__main__":
    main()
