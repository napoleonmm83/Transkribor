"""Welches Rechenwerk nutzen wir — an EINER Stelle.

Bisher stand die Entscheidung zweimal da (transcribe.py, diarize.py) und kannte nur
cuda/cpu. Apple Silicon rechnet ueber "mps"; whisper.load_model waehlt das von sich aus
nie — upstream kennt genau `cuda if torch.cuda.is_available() else cpu`.

Der torch-Import liegt bewusst INNERHALB der Funktionen (lazy, wie in diarize.py): ein
`import webtool.device` soll nicht den mehrsekuendigen torch-Start bezahlen, und die
Einstellungsseite muss auch in einer halben Umgebung ohne torch aufrufbar bleiben.
"""


def pick() -> str:
    """"cuda" | "mps" | "cpu" — das Erste, was verfuegbar ist."""
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


def describe() -> dict:
    """Fuers Frontend: was laeuft, wie heisst es, ist torch ueberhaupt da.
    Wirft nie — eine kaputte Umgebung darf die Einstellungsseite nicht unbenutzbar machen."""
    try:
        import torch
    except ImportError:
        return {"device": "cpu", "name": "PyTorch nicht installiert", "torch_ok": False}
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
    return {"device": d, "name": name, "torch_ok": True}
