"""whisper.cpp mit Metal — die ASR-Engine auf Apple Silicon.

Gemessen am 2026-08-09 (M1 Pro, 8.7 Min Interview, dieselbe Datei, dieselben
Decoder-Einstellungen wie der Produktionspfad):

    faster-whisper  large-v3  CPU int8  beam5   650s   0.81x   <- bisher auf dem Mac
    mlx-whisper     large-v3  Metal     greedy  494s   1.06x
    whisper.cpp     large-v3  Metal     beam5    99s   5.29x   <- diese Datei

Damit ist die "Offene Messung" aus docs/superpowers/specs/2026-08-08-transkribor-
cross-platform-design.md beantwortet. Ausschlaggebend war nicht nur der Faktor 6.6:
whisper.cpp ist die einzige der drei Varianten, die schneller wird, OHNE Qualitaet
einzutauschen — sie faehrt vollen Beam-Search (mlx-whisper kann nur greedy, es wirft
bei jedem beam_size != None ein NotImplementedError) und liegt im Wortvergleich mit
89.5% naeher am bisherigen Ergebnis als jede Alternative.

**Warum ein Unterprozess und keine Bibliothek.** whisper.cpp kommt als Binary aus
Homebrew, so wie ffmpeg auch. Ein pip-Paket (pywhispercpp) baut aus dem Quelltext,
braucht die Xcode-Kommandozeilenwerkzeuge und schaltet Metal nur bei passender
Umgebung ein — auf einer Nutzermaschine ist das mehr Angriffsflaeche als ein
`brew install whisper-cpp` neben dem, was setup.js ohnehin schon vorschlaegt.

**Flash Attention an, DTW aus.** `--dtw` liefert genauere WORT-Zeitstempel, ist mit
Flash Attention unvereinbar und halbiert den Durchsatz (gemessen: 216s statt 99s,
2.42x statt 5.29x). Gekauft waere damit wenig: `Word.start/end` ist im Frontend
`number | null`, die Arbeit leistet dort `probability` (uncertainty.ts und die
`[[Wort|0.pp]]`-Markierung fuer die LLM-Korrektur). Die SEGMENT-Zeiten — die, ueber
die der Editor Audio und Text synchronisiert — sind in beiden Modi exakt.
"""
import json
import math
import os
import re
import shutil
import ssl
import subprocess
import tempfile
import urllib.error
import urllib.request
import zlib

from . import paths

BINAER = "whisper-cli"

# Nur die Stufen aus settings.WHISPER_CHOICES. large-v3 und turbo bewusst als q5_0:
# quantisiert kostet es 7% Tempo (106s statt 99s), ist im Wortvergleich aber gleichauf
# (89.4% gegen 89.5%) — und bleibt mit 1.01 GB unter der 2-GB-Grenze fuer
# GitHub-Release-Assets. Erst das macht den Mac-Pfad frei von Hugging Face.
MODELL_DATEIEN = {
    "tiny": "ggml-tiny.bin",
    "small": "ggml-small.bin",
    "medium": "ggml-medium.bin",
    "turbo": "ggml-large-v3-turbo-q5_0.bin",
    "large-v3-turbo": "ggml-large-v3-turbo-q5_0.bin",
    "large-v3": "ggml-large-v3-q5_0.bin",
}

# Dieselbe Quelle, aus der electron-updater ohnehin schon laedt (package.json:publish).
# Kein Hugging Face: dessen Gate kostete bei pyannote Konto und Token, und das Repo hat
# sich davon bewusst geloest (models/ liegt im Repo). Ein zweiter Dienst, der ausfallen
# oder drosseln kann, waere ein Rueckschritt.
QUELLE = ("https://github.com/napoleonmm83/Transkribor/releases/download/"
          "modelle-v1/{datei}")


def ssl_kontext():
    """CA-Bundle fuer den Modell-Download — oder None fuer Pythons Vorgabe.

    Von python.org installiertes Python nutzt auf macOS NICHT die System-Keychain,
    sondern ein eigenes Bundle, das ohne den Schritt "Install Certificates.command"
    fehlt. urlopen scheitert dort mit CERTIFICATE_VERIFY_FAILED — und genau so ein
    Python legt electron/setup.js die venv an. Der Fehler traf also nicht nur eine
    Entwicklermaschine, sondern jeden Mac-Nutzer.

    Aufgefallen ist er erst beim ersten Download vom echten Release: die uebrigen
    Downloads dieses Projekts laufen ueber requests (huggingface_hub), das certifi
    von sich aus mitbringt. Hier gibt es kein requests — also holen wir das Bundle
    selbst. certifi steht deshalb in requirements.txt, obwohl es ohnehin transitiv
    hereinkaeme: eine Abhaengigkeit, auf die man sich verlaesst, gehoert benannt.
    """
    try:
        import certifi
    except ImportError:
        return None
    return ssl.create_default_context(cafile=certifi.where())


def quelle(datei: str) -> str:
    """URL des GGML-Modells. TRANSKRIBOR_GGML_URL (mit {datei}-Platzhalter) gewinnt —
    fuer Tests und fuer Nutzer hinter einem Spiegel."""
    vorlage = os.environ.get("TRANSKRIBOR_GGML_URL") or QUELLE
    return vorlage.replace("{datei}", datei)


def modelle_dir() -> str:
    """Wo die GGML-Modelle liegen. Gepackt zeigt TRANSKRIBOR_GGML nach userData —
    neben der .app darf nichts geschrieben werden, und ein Update ersetzt das
    Verzeichnis (dieselbe Regel wie TRANSKRIBOR_PROJEKTE, siehe electron/paths.js)."""
    return os.environ.get("TRANSKRIBOR_GGML") or os.path.join(paths.ROOT, "models", "ggml")


def binaer() -> str:
    """Pfad zu whisper-cli, oder "" wenn es fehlt. Leer heisst: diese Engine faellt aus,
    der Aufrufer nimmt faster-whisper."""
    return shutil.which(BINAER) or ""


def unterstuetzt(modell: str) -> bool:
    """Kennen wir eine GGML-Datei fuer diese Whisper-Stufe? Exotische Namen aus
    KNOWN_WHISPER_MODELS (large-v1, die .en-Varianten) liegen nicht am Release —
    fuer die bleibt faster-whisper zustaendig, statt hier mit 404 zu scheitern."""
    return modell in MODELL_DATEIEN


def verfuegbar(modell: str) -> bool:
    """Laeuft die Transkription dieser Stufe ueber whisper.cpp? Prueft NICHT, ob das
    Modell schon heruntergeladen ist — das erledigt modell_datei() beim ersten Lauf."""
    return bool(binaer()) and unterstuetzt(modell)


def modell_datei(modell: str, onLine=None) -> str:
    """Pfad zur GGML-Datei; laedt sie beim ersten Mal herunter (1.01 GB fuer large-v3).

    Laedt nach .teil und benennt erst nach vollstaendigem Download um: ein Abbruch
    hinterlaesst sonst eine halbe Datei, die beim naechsten Start "da" aussieht und
    whisper-cli mit einem unverstaendlichen Fehler sterben laesst.
    """
    sag = onLine or (lambda z: print(z, flush=True))
    datei = MODELL_DATEIEN[modell]
    ziel = os.path.join(modelle_dir(), datei)
    if os.path.exists(ziel):
        return ziel

    os.makedirs(modelle_dir(), exist_ok=True)
    url = quelle(datei)
    teil = ziel + ".teil"
    sag(f"Lade Sprachmodell {datei} …")
    try:
        with urllib.request.urlopen(url, context=ssl_kontext()) as antwort, \
                open(teil, "wb") as fh:
            gesamt = int(antwort.headers.get("Content-Length") or 0)
            geladen = 0
            letzte = -1
            while True:
                block = antwort.read(1024 * 1024)
                if not block:
                    break
                fh.write(block)
                geladen += len(block)
                if gesamt:
                    pct = geladen * 100 // gesamt
                    if pct != letzte and pct % 5 == 0:
                        sag(f"{pct}%| Sprachmodell")   # Format wie jobPhases.ts es liest
                        letzte = pct
        # Eine abgeschnittene Antwort beendet die Schleife regulaer — ohne diese Pruefung
        # wanderte die halbe Datei ueber os.replace() in den Cache, und JEDER folgende
        # Start haette sie als fertig akzeptiert. whisper-cli stirbt daran dauerhaft, und
        # niemand kaeme auf die Idee, ein "vorhandenes" Modell zu loeschen.
        if gesamt and geladen != gesamt:
            raise OSError(f"Abbruch nach {geladen} von {gesamt} Bytes")
    except (urllib.error.URLError, OSError) as e:
        if os.path.exists(teil):
            os.remove(teil)
        raise RuntimeError(f"Sprachmodell {datei} nicht ladbar von {url}: {e}") from e
    os.replace(teil, ziel)
    return ziel


def _wav(audio: str, ziel: str) -> None:
    """whisper.cpp liest ausschliesslich 16-kHz-Mono-WAV. mp3/m4a/… muessen also
    vorher durch ffmpeg — dasselbe Binary, das transcribe.ensure_ffmpeg() ohnehin
    auf den PATH holt."""
    subprocess.run(["ffmpeg", "-v", "error", "-i", audio, "-ac", "1", "-ar", "16000",
                    "-c:a", "pcm_s16le", "-y", ziel], check=True)


FORTSCHRITT = re.compile(r"progress\s*=\s*(\d+)%")


def fortschritt(zeile: str):
    """whisper.cpps Fortschrittszeile -> Prozentzahl, sonst None.

    Gekappt bei 100: whisper.cpp zaehlt ueber das Ende hinaus (gemessen: 5, 11, …, 97,
    103), und ein Balken, der 103% anzeigt, sieht nach Fehler aus.
    """
    m = FORTSCHRITT.search(zeile)
    return min(int(m.group(1)), 100) if m else None


def _worte(tokens: list) -> list:
    """Sub-Word-Tokens -> Woerter, wie faster-whisper sie liefert.

    Whisper toknisiert " Vorarlberger" als " Vor" + "arl" + "berger"; ein neues Wort
    beginnt also genau dort, wo ein Token mit Leerzeichen anfaengt. Sondertokens
    ([_BEG_], [_TT_123]) sind keine Sprache und fliegen raus.

    Die Wort-Wahrscheinlichkeit ist das MITTEL der Token-Werte. Gemessen an 62 Woertern
    gegen faster-whisper auf derselben Datei: Mittel markiert 9.4% der Woerter als
    unsicher (Median 0.866), faster-whisper 6.5% (Median 0.873) — Minimum und Produkt
    lagen bei 15.6% und haetten UNCERTAIN_TAG_THRESHOLD=0.5 still entkalibriert, also
    den Editor mit Falschwarnungen geflutet.
    """
    out = []
    for t in tokens:
        text = t.get("text", "")
        if text.startswith("[_") and text.endswith("]"):
            continue
        if text.startswith(" ") or not out:
            out.append({"text": text, "ps": [t.get("p", 1.0)],
                        "von": t["offsets"]["from"], "bis": t["offsets"]["to"]})
        else:
            out[-1]["text"] += text
            out[-1]["ps"].append(t.get("p", 1.0))
            out[-1]["bis"] = t["offsets"]["to"]
    return [{"word": w["text"], "start": w["von"] / 1000.0, "end": w["bis"] / 1000.0,
             "probability": sum(w["ps"]) / len(w["ps"])} for w in out]


def _kompressionsrate(text: str) -> float:
    """len(text) / len(zlib(text)) — die Formel, mit der Whisper Halluzinationen
    erkennt (edit_model.compute_flags liest das Ergebnis). whisper.cpp meldet sie
    nicht, also rechnen wir sie identisch zu Upstream nach."""
    roh = text.encode("utf-8")
    if not roh:
        return 0.0
    return len(roh) / len(zlib.compress(roh))


def _segment(nr: int, seg: dict) -> dict:
    """Ein whisper.cpp-Segment -> die dict-Form, die `<base>.json` verlangt.

    `no_speech_prob` und `temperature` meldet whisper.cpp nicht. Beide stehen trotzdem
    drin, mit 0.0: die Form ist ein Vertrag (edit_model.build_edit_doc liest daraus),
    und ein fehlender Schluessel faellt spaeter irgendwo als KeyError auf statt hier.
    Gelesen wird ohnehin keiner von beiden — die "silence"-Flagge, die no_speech_prob
    brauchte, ist entfernt (siehe compute_flags).
    """
    tokens = seg.get("tokens", [])
    echte = [t for t in tokens
             if not (t.get("text", "").startswith("[_") and t.get("text", "").endswith("]"))]
    ps = [t.get("p", 1.0) for t in echte if t.get("p", 0) > 0]
    text = seg.get("text", "")
    return {
        "id": nr,
        "seek": seg["offsets"]["from"] // 10,          # Centisekunden, wie bei Whisper
        "start": seg["offsets"]["from"] / 1000.0,
        "end": seg["offsets"]["to"] / 1000.0,
        "text": text,
        "tokens": [t.get("id") for t in echte],
        "temperature": 0.0,
        "avg_logprob": sum(math.log(p) for p in ps) / len(ps) if ps else 0.0,
        "compression_ratio": _kompressionsrate(text),
        "no_speech_prob": 0.0,
        "words": _worte(tokens),
    }


def wav_dauer(pfad: str):
    """Sekunden eines von `_wav` geschriebenen 16-kHz-Mono-s16-WAV, oder None.

    Aus der DATEIGROESSE, nicht durch ein zweites Dekodieren: das Format steht fest (siehe
    `_wav`), also 44 Byte Kopf und 2 Byte je Abtastwert bei 16000 Hz. Gebraucht wird sie fuer
    `transcribe.luecken` — ohne Dauer bliebe ausgerechnet ein uebersprungenes Fenster am
    DATEIENDE unbemerkt, und das ist auf diesem Pfad die einzige Auskunft darueber (anders als
    faster-whisper liefert whisper-cli keine `duration`).

    None bei einer nicht lesbaren oder zu kleinen Datei: eine geratene Dauer waere schlimmer
    als keine — sie erfaende eine Luecke oder verdeckte eine.
    """
    try:
        roh = os.path.getsize(pfad) - 44
    except OSError:
        return None
    return roh / 32000 if roh > 0 else None


def bereinige_wiederholungs_schleifen(segmente: list, max_wiederholungen: int = 2) -> list:
    """Filtert ausufernde ASR-Wiederholungsschleifen (Halluzinationen über Musik/Stille)."""
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


def ergebnis(roh: dict, sprache: str, dauer=None) -> dict:
    """whisper.cpp-JSON -> exakt das Dokument, das transcribe._ergebnis() sonst aus
    faster-whisper baut. Reine Funktion, damit der Adapter ohne Binary pruefbar ist.

    sprache=None ('auto'): dann hat whisper-cli selbst erkannt, das Ergebnis steht in
    roh["result"]["language"]. Ueber build_edit_doc wandert es ins Dokument und damit in
    die Prompt-Zielsprache der Korrektur — fehlt es (oder result), gilt 'de' als
    Fallback, wie edit_model es bei fehlender Sprache ohnehin tun wuerde."""
    segmente = [_segment(i, s) for i, s in enumerate(roh.get("transcription", []))]
    segmente = bereinige_wiederholungs_schleifen(segmente)
    sprache = sprache or (roh.get("result") or {}).get("language") or "de"
    return {"text": "".join(s["text"] for s in segmente),
            "segments": segmente,
            "language": sprache,
            "duration": dauer}


def _cmd(binaer_pfad: str, gguf: str, wav: str, praefix: str, sprache) -> list:
    """whisper-cli-Argumente. -l nur bei konkreter Sprache: bei None ('auto') erkennt
    whisper-cli selbst, und None in der Arg-Liste wuerde subprocess.Popen werfen lassen.
    Reine Funktion, damit der cmd-Bau ohne Binary pruefbar ist."""
    cmd = [binaer_pfad, "-m", gguf, "-f", wav]
    if sprache:
        cmd += ["-l", sprache]
    cmd += ["-bs", "5", "-bo", "5", "-mc", "64", "-pp", "-ojf", "-of", praefix]
    return cmd


def transkribiere(audio: str, modell: str, sprache: str, onLine=None) -> dict:
    """Transkribiert eine Datei ueber whisper.cpp und liefert das `<base>.json`-Dokument.

    Die Decoder-Parameter spiegeln transcribe._opts(): beam_size 5, best_of 5,
    Temperatur-Rueckfall (whisper.cpps Default 0.0 mit Schritt 0.2). Kein VAD — es wuerde
    Stille ueberspringen und die Segmentzeiten gegen das Audio verschieben, ueber die der
    Editor synchronisiert.

    Und kein `--prompt`. Auf dem faster-whisper-Pfad ist der Grund ein MECHANISMUS: der
    Prompt beendet ein 30-Sekunden-Fenster vorzeitig, der Lesezeiger rueckt um das ganze
    Fenster weiter, und die restliche Sprache darin wird nie gelesen (Messung in
    transcribe._opts).

    **Auf DIESEM Pfad war das zuerst nur MITGEZOGEN** — die Messung stammte ausschliesslich
    vom faster-whisper-Pfad auf CUDA, waehrend auf Apple Silicon ausschliesslich dieser hier
    laeuft. Am 2026-09-02 auf einem M1 Pro nachgeholt (#84): C0761 aus PR #82 (54,77 s),
    dieselben Decoder-Einstellungen, je zwei Laeufe:

        mit --prompt   22 Segmente   49,76 s Abdeckung (90,9 %)   143 Woerter
        ohne --prompt  26 Segmente   52,30 s Abdeckung (95,5 %)   160 Woerter

    **Was das belegt:** den VERLUST. 17 Woerter und 2,5 s Abdeckung, dieselbe Richtung und
    Groessenordnung wie auf dem faster-whisper-Pfad (dort 140 -> 158 an derselben Datei).
    Die Frage aus #84 — folgenlos oder echte Verbesserung — ist damit in Richtung echte
    Verbesserung entschieden. Mit Prompt fehlt der Soundcheck am Anfang („Ja, wir hoeren uns
    an. Ist gut? Ja."), und der Satz davor wird verstuemmelt.

    **Was es NICHT belegt: den Mechanismus.** Die Signatur des uebersprungenen Fensters fehlt
    — das erste Wort liegt in BEIDEN Varianten bei 0,00 s (bei C0709 auf dem
    faster-whisper-Pfad waren es 8,82 gegen 10,04 s), `transcribe.luecken` meldet in keiner
    Variante etwas, und der Gesamtverlust betraegt 5,01 s statt eines ganzen 30-s-Fensters.
    Der Verlust ist hier verteiltes Abschneiden. Ausgerechnet C0761 ist dabei die EINE Datei
    aus PR #82, die auch dort keinen Fenstersprung zeigte (transcribe.py:189, Abdeckung
    45 s -> 45 s bei 140 -> 158 Woertern). Der Seek-Weg existiert in whisper.cpp
    (`single_timestamp_ending` in src/whisper.cpp rueckt um das ganze Fenster weiter),
    gemessen ist er auf diesem Pfad weiterhin nicht.

    **Wer ihn nachweisen will**, nimmt eine Datei, bei der er auf dem anderen Pfad AUFTRAT
    (C0709, dort war das ganze erste Fenster weg) und misst Wortzahl UND Abdeckung UND den
    Text. Keines der drei allein reicht: an C0761 sah die Abdeckung auf dem
    faster-whisper-Pfad die 18 verlorenen Woerter NICHT, und `luecken` (Schwelle 15 s) sieht
    bei 5 s Gesamtverlust ohnehin nichts — „keine Luecke gemeldet" ist dort keine Aussage,
    sondern eine Tautologie.

    Reproduzierbar ist der Lauf, weil whisper.cpp einen festen RNG-Seed setzt
    (`std::mt19937(j)`), nicht wegen `-bs 5`; je zwei Laeufe lieferten dasselbe Ergebnis.

    Waechter gegen den Wiedereinbau, an ZWEI Stellen: `test_cmd_gibt_whisper_cpp_KEINEN_prompt`
    fuer den cmd-Bau (beide Sprachzweige) und eine Zusicherung in
    `test_transkribiere_RECHNET_die_dauer_aus_und_reicht_sie_durch` fuer die AUFRUFSTELLE.
    Die zweite ist nicht doppelt gemoppelt: ein Prompt, der erst am Popen-Aufruf an die Liste
    kommt — oder ueber einen optionalen `prompt`-Parameter von `_cmd` —, laeuft an der ersten
    vorbei. Beides mit Popen-Sonde nachgestellt, beides kam durch.
    """
    sag = onLine or (lambda z: print(z, flush=True))
    gguf = modell_datei(modell, sag)
    with tempfile.TemporaryDirectory(prefix="transkribor-") as tmp:
        wav = os.path.join(tmp, "audio.wav")
        _wav(audio, wav)
        praefix = os.path.join(tmp, "out")
        proc = subprocess.Popen(_cmd(binaer(), gguf, wav, praefix, sprache),
                                stdout=subprocess.DEVNULL,
                                stderr=subprocess.PIPE, text=True,
                                encoding="utf-8", errors="replace")
        letzte = []
        for zeile in proc.stderr:
            pct = fortschritt(zeile)
            if pct is not None:
                # Format wie faster-whispers tqdm-Balken — jobPhases.ts liest genau
                # `^(\d+)%\|` und bleibt damit unveraendert.
                sag(f"{pct}%| {modell}")
            else:
                letzte.append(zeile.rstrip())
                del letzte[:-15]
        if proc.wait() != 0:
            raise RuntimeError("whisper.cpp fehlgeschlagen:\n" + "\n".join(letzte))
        with open(praefix + ".json", encoding="utf-8") as fh:
            # Die Dauer HIER, nicht in `ergebnis`: nur dieser Block kennt die WAV, und
            # `ergebnis` soll rein bleiben (es ist der Vertrag mit transcribe._ergebnis).
            # Noch im `with`, sonst ist das Temporaerverzeichnis samt WAV schon weg.
            return ergebnis(json.load(fh), sprache, wav_dauer(wav))
