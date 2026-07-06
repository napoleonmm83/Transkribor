"""CLI für den Korrektur-Ablauf (Stufe 1.5).

  python -m webtool.correct prep  <project>            -> <base>.tagged.txt je Datei
  python -m webtool.correct apply <project> <base>     -> <base>.edit.json + <base>.md
                                            [--force]     (aus <base>.correction.json)

Der eigentliche LLM-Korrekturschritt liegt dazwischen (Workflow tools/correct_label.mjs).
"""
import argparse
import glob
import json
import os

from . import paths
from .edit_model import tag_uncertain_segments, apply_correction
from .render_md import render_md

AUDIO_EXT = (".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma", ".mp4")


def bases(project: str) -> list:
    tdir = paths.transkripte_dir(project)
    if not os.path.isdir(tdir):
        return []
    return sorted({os.path.splitext(os.path.basename(p))[0]
                   for p in glob.glob(os.path.join(tdir, "*.json"))
                   if not p.endswith(".edit.json")})


def _audio_name(project: str, base: str) -> str:
    adir = paths.audio_dir(project)
    for ext in AUDIO_EXT:
        cand = os.path.join(adir, base + ext)
        if os.path.exists(cand):
            return os.path.basename(cand)
    return ""


def _load(path: str) -> dict:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def cmd_prep(project: str) -> int:
    tdir = paths.transkripte_dir(project)
    n = 0
    for base in bases(project):
        raw = _load(os.path.join(tdir, base + ".json"))
        segs = tag_uncertain_segments(raw)
        text = "\n".join(f"[{s['id']}] {s['tagged_text']}" for s in segs) + "\n"
        paths.atomic_write(os.path.join(tdir, base + ".tagged.txt"), text)
        n += 1
    print(f"prep: {n} Datei(en) getaggt in {tdir}")
    return n


def cmd_apply(project: str, base: str, force: bool = False) -> str:
    tdir = paths.transkripte_dir(project)
    epath = os.path.join(tdir, base + ".edit.json")
    if os.path.exists(epath) and not force:
        try:
            if _load(epath).get("human_edited"):
                print(f"apply: SKIP {base} (human_edited=true; --force zum Ueberschreiben)")
                return "skipped"
        except json.JSONDecodeError:
            pass  # korrupte edit.json -> darf ueberschrieben werden
    raw = _load(os.path.join(tdir, base + ".json"))
    correction = _load(os.path.join(tdir, base + ".correction.json"))
    doc = apply_correction(raw, correction, base=base, project=project,
                           audio=_audio_name(project, base))
    paths.atomic_write(epath, json.dumps(doc, ensure_ascii=False, indent=1))
    paths.atomic_write(os.path.join(tdir, base + ".md"), render_md(doc))
    print(f"apply: {base} -> edit.json + md ({len(doc['segments'])} Segmente)")
    return "written"


def main(argv=None):
    ap = argparse.ArgumentParser(description="Transkribor Korrektur-CLI (Stufe 1.5)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("prep"); p.add_argument("project")
    a = sub.add_parser("apply"); a.add_argument("project"); a.add_argument("base")
    a.add_argument("--force", action="store_true")
    args = ap.parse_args(argv)
    paths.safe_name(args.project)
    if args.cmd == "prep":
        cmd_prep(args.project)
    else:
        paths.safe_name(args.base)
        cmd_apply(args.project, args.base, args.force)


if __name__ == "__main__":
    main()
