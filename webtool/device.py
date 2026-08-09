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
    """"cuda" | "cpu" — fuer die Transkription (faster-whisper/CTranslate2).

    CTranslate2 dokumentiert ausschliesslich cpu/cuda/auto; auf Apple Silicon rechnet die
    ASR also auf der CPU, waehrend die Diarisierung weiter MPS nutzen darf. Das hier ist
    genau die Stelle, an der das steht — damit niemand `pick()` durchreicht und sich
    wundert, warum CTranslate2 "mps" ablehnt.
    """
    return "cuda" if pick() == "cuda" else "cpu"


def describe() -> dict:
    """Fuers Frontend: was laeuft, wie heisst es, ist torch ueberhaupt da.
    Wirft nie — eine kaputte Umgebung darf die Einstellungsseite nicht unbenutzbar machen.

    `asr` steht zusaetzlich drin, weil `device` seit dem faster-whisper-Wechsel nicht mehr
    fuer beides gilt: auf einem Mac meldet `device` "mps" (Diarisierung) waehrend die
    Transkription auf der CPU laeuft. Genau diese Luege — Anzeige sagt GPU, gerechnet wird
    auf der CPU — vermeidet dieses Repo an anderer Stelle bewusst (kein
    PYTORCH_ENABLE_MPS_FALLBACK), also darf sie hier nicht durch die Hintertuer zurueck.
    """
    try:
        import torch
    except ImportError:
        return {"device": "cpu", "name": "PyTorch nicht installiert", "torch_ok": False,
                "asr": "cpu"}
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
    return {"device": d, "name": name, "torch_ok": True, "asr": pick_asr()}
