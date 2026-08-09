"""Welches Rechenwerk nutzen wir — an EINER Stelle.

Bisher stand die Entscheidung zweimal da (transcribe.py, diarize.py) und kannte nur
cuda/cpu. Apple Silicon rechnet ueber "mps"; Upstream-Whisper waehlte das von sich aus
nie — es kennt genau `cuda if torch.cuda.is_available() else cpu`.

**Zwei Funktionen, weil zwei Rechenwerke.** `pick()` gilt fuer alles, was auf torch laeuft
(pyannote-Diarisierung) und kann "mps". Die Transkription laeuft seit dem Wechsel auf
faster-whisper unter CTranslate2, und das kennt ausschliesslich cpu/cuda — dafuer
`pick_asr()`. Sie in eine Funktion zu zwingen hiesse, entweder MPS fuer die Diarisierung
wegzuwerfen oder CTranslate2 ein Geraet unterzuschieben, das es ablehnt.

Der torch-Import liegt bewusst INNERHALB der Funktionen (lazy, wie in diarize.py): ein
`import webtool.device` soll nicht den mehrsekuendigen torch-Start bezahlen, und die
Einstellungsseite muss auch in einer halben Umgebung ohne torch aufrufbar bleiben.
"""


def apple_silicon() -> bool:
    """Laeuft das hier auf einem M-Mac? Intel-Macs sind ausdruecklich nicht unterstuetzt
    (siehe README), und whisper.cpps Metal-Backend gibt es dort auch nicht."""
    import platform
    import sys
    return sys.platform == "darwin" and platform.machine() == "arm64"


def pick() -> str:
    """"cuda" | "mps" | "cpu" — das Erste, was verfuegbar ist (torch-Welt: pyannote)."""
    try:
        import torch
    except ImportError:
        return "cpu"
    if torch.cuda.is_available():
        return "cuda"
    # torch < 1.12 kennt backends.mps nicht; getattr statt hasattr-Kette.
    mps = getattr(torch.backends, "mps", None)
    if mps is not None and mps.is_available():
        return "mps"
    return "cpu"


def pick_asr() -> str:
    """"cuda" | "cpu" — fuer die Transkription mit faster-whisper/CTranslate2.

    CTranslate2 dokumentiert ausschliesslich cpu/cuda/auto; wo faster-whisper rechnet,
    kann es also nie "mps" sein. Das hier ist genau die Stelle, an der das steht — damit
    niemand `pick()` durchreicht und sich wundert, warum CTranslate2 "mps" ablehnt.

    Auf Apple Silicon uebernimmt die Transkription inzwischen whisper.cpp (siehe
    asr_engine()); diese Funktion gilt dann nur noch fuer den Rueckfall.
    """
    return "cuda" if pick() == "cuda" else "cpu"


def asr_engine(modell: str) -> str:
    """"whisper.cpp" | "faster-whisper" — welche Engine transkribiert.

    whisper.cpp gewinnt nur auf Apple Silicon, und dort nur, wenn das Binary da ist und
    wir fuer die gewaehlte Stufe eine GGML-Datei am Release liegen haben. Jede andere
    Lage faellt auf faster-whisper zurueck: Windows und Linux fahren mit CUDA ohnehin
    besser, und eine exotische Stufe (large-v1, die .en-Varianten) soll nicht mit einem
    404 sterben, nur weil sie nicht am Release haengt.

    Warum die Verzweigung HIER und nicht in transcribe.py: sie gehoert zur Geraetefrage,
    und sie muss ohne torch beantwortbar bleiben — die Einstellungsseite fragt danach.

    Bewusst an der PLATTFORM festgemacht und nicht an pick() == "mps": whisper.cpp
    rechnet ueber Metal und braucht kein torch. Haette man es an MPS gehaengt, faellt
    eine Mac-Installation ohne torch grundlos auf die langsame CPU zurueck.
    """
    if not apple_silicon():
        return "faster-whisper"
    from . import whispercpp
    return "whisper.cpp" if whispercpp.verfuegbar(modell) else "faster-whisper"


def describe(modell: str = "large-v3") -> dict:
    """Fuers Frontend: was laeuft, wie heisst es, ist torch ueberhaupt da.
    Wirft nie — eine kaputte Umgebung darf die Einstellungsseite nicht unbenutzbar machen.

    `asr` steht getrennt neben `device`, weil beide seit dem faster-whisper-Wechsel
    auseinanderfallen: `device` gilt der torch-Welt (Diarisierung), `asr` der
    Transkription. Genau diese Luege — Anzeige sagt GPU, gerechnet wird auf der CPU —
    vermeidet dieses Repo an anderer Stelle bewusst (kein PYTORCH_ENABLE_MPS_FALLBACK),
    also darf sie hier nicht durch die Hintertuer zurueck.

    `modell` muss die eingestellte Whisper-Stufe sein: auf einem Mac haengt die Engine
    daran (asr_engine), eine Stufe ohne GGML-Datei faellt auf die CPU zurueck. Der
    Default spiegelt settings.DEFAULTS — device.py importiert settings NICHT, sonst
    haette die Geraetefrage ploetzlich eine Meinung zur Konfiguration.
    """
    engine = asr_engine(modell)
    try:
        import torch
    except ImportError:
        # Ohne torch faellt die Diarisierung aus, die Transkription per whisper.cpp
        # aber nicht — sie braucht kein torch. Darum hier kein pauschales "cpu".
        return {"device": "cpu", "name": "PyTorch nicht installiert", "torch_ok": False,
                "asr": "metal" if engine == "whisper.cpp" else "cpu",
                "asr_engine": engine}
    d = pick()
    if d == "cuda":
        try:
            name = torch.cuda.get_device_name(0)
        except Exception:
            name = "CUDA-GPU"
    elif d == "mps":
        name = "Apple Silicon (Metal)"
    else:
        name = "CPU"
    return {"device": d, "name": name, "torch_ok": True,
            "asr": "metal" if engine == "whisper.cpp" else pick_asr(),
            "asr_engine": engine}
