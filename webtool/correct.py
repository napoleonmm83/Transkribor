"""CLI für den Korrektur-Ablauf (Stufe 1.5 + 2b).

  python -m webtool.correct prep  <project>            -> <base>.tagged.txt je Datei
  python -m webtool.correct apply <project> <base>     -> <base>.edit.json + <base>.md
                                            [--force]     (aus <base>.correction.json)
  python -m webtool.correct run   <project>            -> prep + Glossar + pro Datei
                                                          claude-Korrektur + apply (Stufe 2b)

`run` fährt den ganzen Korrektur-Ablauf per headless `claude -p` (Claude-Code-Abo, kein
API-Key). `prep`/`apply` sind deterministisches Python; der LLM-Schritt liegt dazwischen
(entweder `run` hier oder der Workflow tools/correct_label.mjs).
"""
import argparse
import json
import os
import shutil
import subprocess
import sys

from . import paths
from .edit_model import tag_uncertain_segments, apply_correction
from .render_md import render_md

AUDIO_EXT = (".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma", ".mp4")

CLAUDE_MODEL = "opus"
CLAUDE_TIMEOUT = 900          # s pro claude-Aufruf; Hänger killen statt Job blockieren
_CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0
DEFAULT_CONTEXT = (
    "Interviews (gesprochene Sprache oft Schweizerdeutsch/Dialekt), von Whisper "
    "large-v3 nach Standarddeutsch transkribiert. ASR-Fehler v.a. bei Eigennamen "
    "und Dialektbegriffen."
)


def bases(project: str) -> list:
    return paths.transcript_bases(project)


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
        try:  # eine kaputte/gesperrte Roh-JSON darf den Batch nicht stoppen
            raw = _load(os.path.join(tdir, base + ".json"))
            segs = tag_uncertain_segments(raw)
            text = "\n".join(f"[{s['id']}] {s['tagged_text']}" for s in segs) + "\n"
            paths.atomic_write(os.path.join(tdir, base + ".tagged.txt"), text)
            n += 1
        except (OSError, json.JSONDecodeError) as e:
            print(f"prep: SKIP {base} (Roh-JSON unlesbar: {e})", flush=True)
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
    cpath = os.path.join(tdir, base + ".correction.json")
    if not os.path.exists(cpath):
        print(f"apply: FEHLT {base}.correction.json - erst Korrektur-Workflow laufen lassen")
        return "missing"
    raw = _load(os.path.join(tdir, base + ".json"))
    correction = _load(cpath)
    doc = apply_correction(raw, correction, base=base, project=project,
                           audio=_audio_name(project, base))
    paths.atomic_write(epath, json.dumps(doc, ensure_ascii=False, indent=1))
    paths.atomic_write(os.path.join(tdir, base + ".md"), render_md(doc))
    print(f"apply: {base} -> edit.json + md ({len(doc['segments'])} Segmente)")
    return "written"


# ---------------------------------------------------------------------------
# Stufe 2b: `run` = prep + gemeinsames Glossar + pro Datei claude-Korrektur + apply
# ---------------------------------------------------------------------------

def _context(project: str) -> str:
    p = os.path.join(paths.project_dir(project), "kontext.md")
    if os.path.exists(p):
        with open(p, encoding="utf-8") as fh:
            return fh.read().strip()
    return ""


def _is_human_edited(epath: str) -> bool:
    try:
        return bool(_load(epath).get("human_edited"))
    except (OSError, json.JSONDecodeError):
        return False


def _valid_correction(cpath: str) -> bool:
    """Erfolgsmass für 2b: geschriebene correction.json existiert, parst, hat Segmente."""
    try:
        segs = _load(cpath).get("segments")
    except (OSError, json.JSONDecodeError):
        return False
    return isinstance(segs, list) and len(segs) > 0


def _claude_exe() -> str:
    exe = shutil.which("claude") or shutil.which("claude.cmd")
    if not exe:
        raise FileNotFoundError("claude CLI nicht auf PATH (Claude-Code-Abo nötig)")
    return exe


def _run_claude(prompt: str) -> None:
    """Headless claude -p; schreibt die Zieldatei selbst via Write-Tool. Erfolg wird an
    der geschriebenen Datei gemessen (nicht am Exitcode) — Fehler/Timeout nur loggen.

    Prompt kommt über stdin (nicht als argv): robust gegen .cmd-Shims/cmd.exe-Parsing
    mehrzeiliger Prompts und ohne Windows-Kommandozeilen-Längenlimit. cwd = projekte_root
    grenzt die auto-akzeptierten Schreibzugriffe (acceptEdits) auf den Projektbaum ein —
    der eigene Quellcode (webtool/, transcribe.py) liegt ausserhalb und ist so nicht
    beschreibbar; die Roh-Transkripte sind eine Trust-Boundary (Prompt-Injection)."""
    try:
        exe = _claude_exe()
    except FileNotFoundError as e:
        print(f"  {e}", flush=True)
        return
    cmd = [exe, "-p", "--model", CLAUDE_MODEL,
           "--permission-mode", "acceptEdits", "--allowedTools", "Read,Write",
           "--add-dir", paths.projekte_root()]
    try:
        # ponytail: subprocess.run-timeout killt nur den claude-Prozess, nicht dessen
        # Kind-Prozessbaum (MCP-Server) — für ein lokales Ein-Nutzer-Tool ok; falls je
        # relevant: claude in einem Windows-Job-Object starten und die Gruppe killen.
        r = subprocess.run(cmd, cwd=paths.projekte_root(), input=prompt, capture_output=True,
                           text=True, encoding="utf-8", errors="replace", timeout=CLAUDE_TIMEOUT,
                           creationflags=_CREATE_NO_WINDOW)
        if r.returncode != 0:
            tail = ((r.stdout or "") + (r.stderr or "")).strip()[-500:]
            print(f"  claude exit {r.returncode}: {tail}", flush=True)
    except subprocess.TimeoutExpired:
        print(f"  claude Timeout nach {CLAUDE_TIMEOUT}s", flush=True)


def _glossary_prompt(gpath: str, raw_files: list, context: str) -> str:
    files = "\n".join(raw_files)
    return f"""Du erstellst ein GEMEINSAMES Glossar, mit dem anschliessend mehrere Interview-Transkripte KONSISTENT korrigiert werden.

Projekt-Kontext: {context or DEFAULT_CONTEXT}

Lies ALLE folgenden Roh-Transkripte vollständig (Read-Tool):
{files}

Schreibe daraus mit dem Write-Tool ein JSON-Glossar nach GENAU diesem Pfad:
{gpath}

Schema:
{{
  "context_summary": "3-6 Sätze, worum es in den Gesprächen geht",
  "proper_nouns": [{{"correct": "richtige Schreibweise", "variants": ["so falsch gehört", "..."], "note": "optional"}}],
  "likely_corrections": [{{"wrong": "wiederkehrender ASR-Fehler", "right": "korrekt", "why": "optional"}}]
}}

Nimm nur Einträge mit vernünftiger Sicherheit auf — ERFINDE KEINE Namen. Lieber wenige sichere als viele geratene. Gib ausser der geschriebenen Datei nichts weiter aus."""


def _correct_prompt(base: str, tagged_path: str, cpath: str, gjson: str, context: str) -> str:
    return f"""Du korrigierst EIN Interview-Transkript SEGMENT FÜR SEGMENT (oft Schweizerdeutsch -> lesbares Standarddeutsch) und labelst die Sprecher.

Projekt-Kontext: {context or DEFAULT_CONTEXT}

1) Lies die Rohsegmente vollständig (Read-Tool) aus:
{tagged_path}
   Jede Zeile: "[<id>] <text>". Unsichere Wörter sind inline als [[Wort|Wahrscheinlichkeit]] markiert (niedrige Whisper-Konfidenz) — dort besonders genau hinsehen.

Gemeinsames Glossar (für konsistente Schreibweisen — nutze es, ergänze nichts Erfundenes):
{gjson or "(keins)"}

2) KORRIGIEREN: klare ASR-Fehler mit Kontext + Glossar verbessern, zu lesbarem Standarddeutsch normalisieren (Schweizer „ss"). BLEIB TREU: nichts erfinden, den Sinn nicht verändern, nicht über das Nötige hinaus glätten (Füllwörter wie „äh"/„ähm" dürfen dezent weg). Entferne die [[...]]-Markierungen im Ausgabetext.
3) PRO SEGMENT: gib für JEDE Segment-ID aus der Datei GENAU EINEN Eintrag {{id, speaker, text}} zurück — keine ID auslassen, keine Segmente zusammenfassen (die Redebeitrags-Bündelung passiert später).
4) SPRECHER: meist zwei — „Interviewer" (stellt Fragen) und die befragte Person (Name/Betrieb falls im Gespräch genannt, sonst „Befragte Person"). Ordne jedem Segment den passenden Sprecher zu.
5) UNSICHER: wirklich unklare Stellen NICHT raten — nah am Original belassen und unter annotations vermerken.

Schreibe das Ergebnis mit dem Write-Tool als JSON nach GENAU diesem Pfad:
{cpath}

Exaktes Schema (Pflicht — sonst bleibt der Text auf dem Rohstand):
{{
  "base": "{base}",
  "context": "1-2 Sätze zum Gespräch",
  "speakers": ["Interviewer", "..."],
  "segments": [{{"id": <zahl>, "speaker": "...", "text": "..."}}],
  "annotations": ["..."],
  "summary": "kurze Zusammenfassung"
}}
Gib ausser der geschriebenen Datei nichts weiter aus."""


def _glossary(project: str, context: str) -> str:
    """Ein claude-Aufruf über alle .raw.txt -> _glossar.json. Gibt das Glossar als
    JSON-Text zurück (leer, wenn es fehlschlägt -> Korrektur läuft ohne Glossar weiter)."""
    tdir = paths.transkripte_dir(project)
    gpath = os.path.abspath(os.path.join(tdir, "_glossar.json"))
    raw_files = [os.path.abspath(os.path.join(tdir, b + ".raw.txt")) for b in bases(project)]
    raw_files = [f for f in raw_files if os.path.exists(f)]
    if not raw_files:
        print("  keine .raw.txt gefunden — überspringe Glossar", flush=True)
        return ""
    # vorhandenes Glossar nur wiederverwenden, wenn es neuer als JEDE Roh-Text-Datei ist
    # (korpus-weit: eine neu transkribierte Datei macht das gemeinsame Glossar veraltet)
    if os.path.exists(gpath) and os.path.getmtime(gpath) >= max(os.path.getmtime(f) for f in raw_files):
        print("↷ nutze vorhandenes _glossar.json", flush=True)
    else:
        print("→ Glossar (gemeinsame Namen/Begriffe) …", flush=True)
        _run_claude(_glossary_prompt(gpath, raw_files, context))
    try:
        g = _load(gpath)
    except (OSError, json.JSONDecodeError):
        print("⚠ Glossar fehlt/ungültig — fahre ohne gemeinsames Glossar fort", flush=True)
        return ""
    print(f"✓ Glossar: {len(g.get('proper_nouns') or [])} Eigennamen, "
          f"{len(g.get('likely_corrections') or [])} Korrekturen", flush=True)
    return json.dumps(g, ensure_ascii=False, indent=1)


def cmd_run(project: str) -> int:
    tdir = paths.transkripte_dir(project)
    all_bases = bases(project)
    if not all_bases:
        print("run: keine Roh-Transkripte — erst transkribieren", flush=True)
        return 0
    print(f"run: {len(all_bases)} Datei(en) in Projekt {project!r}", flush=True)
    cmd_prep(project)                                  # -> <base>.tagged.txt
    context = _context(project)
    gjson = _glossary(project, context)
    done = 0
    for base in all_bases:
        try:  # eine kaputte Datei darf den Batch nicht abbrechen
            epath = os.path.join(tdir, base + ".edit.json")
            cpath = os.path.join(tdir, base + ".correction.json")
            raw_json = os.path.join(tdir, base + ".json")
            if _is_human_edited(epath):
                print(f"↷ SKIP {base} (human_edited=true)", flush=True)
                continue
            # vorhandene correction nur wiederverwenden, wenn sie neuer als die Roh-JSON ist
            # (nach einer Neu-Transkription wäre sie sonst veraltet und würde auf falsche IDs gewoben)
            if os.path.exists(cpath) and os.path.getmtime(cpath) >= os.path.getmtime(raw_json):
                print(f"↷ nutze vorhandene {base}.correction.json", flush=True)
            else:
                print(f"→ Korrigiere {base} …", flush=True)
                tagged = os.path.abspath(os.path.join(tdir, base + ".tagged.txt"))
                _run_claude(_correct_prompt(base, tagged, os.path.abspath(cpath), gjson, context))
            if not _valid_correction(cpath):
                print(f"✗ FEHLT/ungültig: {base}.correction.json — überspringe", flush=True)
                continue
            cmd_apply(project, base)                     # -> edit.json + md (human_edited-geschützt)
            done += 1
        except Exception as e:
            print(f"✗ Fehler bei {base}: {e} — überspringe", flush=True)
    print(f"run: fertig — {done}/{len(all_bases)} Datei(en) korrigiert", flush=True)
    return done


def main(argv=None):
    try:  # Emoji-Fortschritt auch bei umgeleitetem stdout auf non-UTF-8-Windows nicht crashen
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass
    ap = argparse.ArgumentParser(description="Transkribor Korrektur-CLI (Stufe 1.5 + 2b)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("prep"); p.add_argument("project")
    a = sub.add_parser("apply"); a.add_argument("project"); a.add_argument("base")
    a.add_argument("--force", action="store_true")
    r = sub.add_parser("run"); r.add_argument("project")
    args = ap.parse_args(argv)
    paths.safe_name(args.project)
    if args.cmd == "prep":
        cmd_prep(args.project)
    elif args.cmd == "run":
        cmd_run(args.project)
    else:
        paths.safe_name(args.base)
        cmd_apply(args.project, args.base, args.force)


if __name__ == "__main__":
    main()
