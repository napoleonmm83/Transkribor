#!/usr/bin/env python
"""Transkribor - Whisper-Transkription pro Projekt.

Nutzung:
    python transcribe.py <projekt>        # projekte/<projekt>/audio -> transkripte
    python transcribe.py --all            # alle Projekte
    python transcribe.py --list           # Projekte auflisten

Audio liegt in  projekte/<projekt>/audio/  (oder direkt in projekte/<projekt>/).
Ergebnis in     projekte/<projekt>/transkripte/  als .json / .raw.txt / .segments.txt
Optionaler Kontext: projekte/<projekt>/kontext.md  (biast Whisper auf Eigennamen).

Umgebungsvariablen: WHISPER_MODEL (default large-v3), WHISPER_LANG (default de).
"""
import sys, os, json, glob, time, argparse
from shutil import which

ROOT = os.path.dirname(os.path.abspath(__file__))
PROJEKTE = os.path.join(ROOT, "projekte")
AUDIO_EXT = (".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma", ".mp4")


def ensure_ffmpeg():
    """ffmpeg auf PATH sicherstellen (Whisper braucht das Binary)."""
    if which("ffmpeg"):
        return True
    for d in glob.glob(os.path.expandvars(
            r"%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*\ffmpeg*\bin")):
        if os.path.exists(os.path.join(d, "ffmpeg.exe")):
            os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
            return True
    print("WARN: ffmpeg nicht gefunden. Installiere: winget install Gyan.FFmpeg", file=sys.stderr)
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


def find_audio(proj_dir):
    ad = audio_dir(proj_dir)
    files = [f for f in sorted(glob.glob(os.path.join(ad, "*")))
             if f.lower().endswith(AUDIO_EXT)]
    return files


def transcribe_project(name, model, language):
    import torch, whisper
    proj_dir = os.path.join(PROJEKTE, name)
    if not os.path.isdir(proj_dir):
        print(f"Projekt nicht gefunden: {name}", file=sys.stderr)
        return
    out_dir = os.path.join(proj_dir, "transkripte")
    os.makedirs(out_dir, exist_ok=True)
    files = find_audio(proj_dir)
    if not files:
        print(f"[{name}] keine Audiodateien in {audio_dir(proj_dir)}")
        return

    # optionaler Kontext -> Whisper initial_prompt
    prompt = ("Interview auf Schweizerdeutsch, transkribiert nach Standarddeutsch. "
              "Frage und Antwort.")
    kpath = os.path.join(proj_dir, "kontext.md")
    if os.path.exists(kpath):
        with open(kpath, encoding="utf-8") as fh:
            txt = fh.read().strip()
        if txt:
            prompt = txt[:800]

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"[{name}] device={device}", flush=True)
    if device == "cuda":
        print(f"[{name}] gpu:", torch.cuda.get_device_name(0), flush=True)
    print(f"[{name}] Modell {model}, {len(files)} Datei(en)", flush=True)
    m = whisper.load_model(model, device=device)

    for f in files:
        base = os.path.splitext(os.path.basename(f))[0]
        out_json = os.path.join(out_dir, base + ".json")
        if os.path.exists(out_json):
            print(f"[{name}] skip (vorhanden): {base}", flush=True)
            continue
        print(f"[{name}] -> transkribiere {base} …", flush=True)
        t0 = time.time()
        try:
            result = m.transcribe(
                f, language=language, task="transcribe",
                word_timestamps=True, beam_size=5, best_of=5,
                temperature=(0.0, 0.2, 0.4, 0.6, 0.8, 1.0),
                condition_on_previous_text=True, initial_prompt=prompt,
                fp16=(device == "cuda"), verbose=False,
            )
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
