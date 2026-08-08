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
import re
import shutil
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

from . import llm
from . import paths
from .edit_model import tag_uncertain_segments, apply_correction
from .render_md import render_md

AUDIO_EXT = (".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma", ".mp4")

CLAUDE_MODEL = "opus"
CLAUDE_TIMEOUT = 900          # s pro claude-Aufruf; Hänger killen statt Job blockieren
CHUNK_SEGMENTS = 150          # max. Segmente pro claude-Aufruf; darüber wird die Datei gestückelt.
                              # Der Engpass ist der OUTPUT: ~540 Segmente sind ~15k Tokens JSON am
                              # Stück und laufen in CLAUDE_TIMEOUT (echter Fall: 21-min-Interview).
# Gleichzeitige claude-Aufrufe. Die Aufrufe warten fast nur auf Opus, also parallelisieren
# Threads sie gut. Der Deckel sitzt bewusst an _run_claude und nicht an den Executors: Datei-
# und Block-Parallelität wären sonst multiplikativ (3 Dateien × 3 Blöcke = 9 Opus-Sessions).
try:
    CLAUDE_PARALLEL = max(1, int(os.environ.get("TRANSKRIBOR_PARALLEL") or 3))
except ValueError:                # Tippfehler in der .env darf den Korrekturlauf nicht killen
    CLAUDE_PARALLEL = 3
_claude_slots = threading.Semaphore(CLAUDE_PARALLEL)
_CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0
DEFAULT_CONTEXT = (
    "Interviews (gesprochene Sprache oft Schweizerdeutsch/Dialekt), von Whisper "
    "large-v3 nach Standarddeutsch transkribiert. ASR-Fehler v.a. bei Eigennamen "
    "und Dialektbegriffen."
)


def bases(project: str) -> list:
    return paths.transcript_bases(project)


def _audio_path(project: str, base: str) -> str:
    adir = paths.audio_dir(project)
    for ext in AUDIO_EXT:
        cand = os.path.join(adir, base + ext)
        if os.path.exists(cand):
            return cand
    return ""


def _audio_name(project: str, base: str) -> str:
    p = _audio_path(project, base)
    return os.path.basename(p) if p else ""


def _load(path: str) -> dict:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _load_diar_clusters(tdir: str, base: str) -> dict:
    """{seg_id: 'Sprecher N'} aus <base>.diar.json, oder {} wenn keins/ungültig."""
    try:
        segs = _load(os.path.join(tdir, base + ".diar.json")).get("segments") or []
    except Exception:      # fehlend/korrupt/nicht-dict -> keine Cluster; darf den prep-Batch nie killen
        return {}
    return {s.get("id"): s.get("speaker") for s in segs if s.get("speaker")}


def cmd_prep(project: str) -> int:
    tdir = paths.transkripte_dir(project)
    n = 0
    for base in bases(project):
        try:  # eine kaputte/gesperrte Roh-JSON darf den Batch nicht stoppen
            raw = _load(os.path.join(tdir, base + ".json"))
            segs = tag_uncertain_segments(raw)
            # Kill-Switch muss auch die KONSUMPTION eines evtl. liegen gebliebenen Sidecars
            # unterdrücken, nicht nur dessen Erzeugung — sonst injiziert ein altes
            # <base>.diar.json trotz TRANSKRIBOR_DIARIZE=0 weiterhin das (Sprecher N)-Präfix.
            clusters = _load_diar_clusters(tdir, base) if _diarize_enabled() else {}
            lines = []
            for s in segs:
                spk = clusters.get(s["id"])
                prefix = f"({spk}) " if spk else ""
                lines.append(f"[{s['id']}] {prefix}{s['tagged_text']}")
            paths.atomic_write(os.path.join(tdir, base + ".tagged.txt"), "\n".join(lines) + "\n")
            n += 1
        except (OSError, json.JSONDecodeError) as e:
            print(f"prep: SKIP {base} (Roh-JSON unlesbar: {e})", flush=True)
    print(f"prep: {n} Datei(en) getaggt in {tdir}")
    return n


DIARIZE_MIN_SPEAKERS = 2      # pyannote-Untergrenze; das Sidecar zeichnet denselben Wert auf (kein Drift)


def _diarize_enabled() -> bool:
    return os.environ.get("TRANSKRIBOR_DIARIZE", "1").strip().lower() not in ("0", "false", "no")


def cmd_diarize(project: str, only_bases: list = None) -> int:
    """Akustische Diarisierung je Datei -> <base>.diar.json (best-effort, idempotent).
    Fehlt pyannote oder scheitert die Diarisierung, wird die Datei übersprungen
    (kein Sidecar) — die Korrektur läuft dann ohne Cluster (Text-Raten wie bisher).
    only_bases scopt auf einen Einzel-Datei-Lauf (✎) — sonst wäre ein Ein-Datei-run GPU-teuer
    fürs ganze Projekt, obwohl Diarisierung pro Datei unabhängig ist."""
    if not _diarize_enabled():
        print("↷ Diarisierung deaktiviert (TRANSKRIBOR_DIARIZE=0)", flush=True)
        return 0
    tdir = paths.transkripte_dir(project)
    n = 0
    for base in (only_bases if only_bases is not None else bases(project)):
        dpath = os.path.join(tdir, base + ".diar.json")
        raw_json = os.path.join(tdir, base + ".json")
        try:
            # >= (nicht >): das Sidecar wird stets NACH der Roh-JSON geschrieben; ein Skip bei exakt
            # gleicher Sekunde ist unrealistisch (Transkription dauert Minuten). Neu-Diarisieren = Sidecar löschen.
            if os.path.exists(dpath) and os.path.getmtime(dpath) >= os.path.getmtime(raw_json):
                print(f"↷ nutze vorhandene {base}.diar.json", flush=True)
                continue
            audio = _audio_path(project, base)
            if not audio:
                print(f"diarize: SKIP {base} (kein Audio gefunden)", flush=True)
                continue
            from . import diarize                       # lazy: zieht torch/pyannote erst hier
            raw = _load(raw_json)
            print(f"→ Diarisiere {base} …", flush=True)
            turns = diarize.diarize_file(audio, min_speakers=DIARIZE_MIN_SPEAKERS)
            if not turns:
                print(f"diarize: SKIP {base} (keine Sprecher erkannt)", flush=True)
                continue
            seg_speakers = diarize.assign_clusters(raw, turns)
            doc = {"base": base, "audio": os.path.basename(audio), "min_speakers": DIARIZE_MIN_SPEAKERS,
                   "turns": turns,
                   "segments": [{"id": sid, "speaker": spk} for sid, spk in seg_speakers.items()]}
            paths.atomic_write(dpath, json.dumps(doc, ensure_ascii=False, indent=1))
            n += 1
        except json.JSONDecodeError as e:               # nur die Roh-JSON parst nicht
            print(f"diarize: SKIP {base} (Roh-JSON unlesbar: {e})", flush=True)
        except Exception as e:                          # pyannote/Token/GPU/HF-403 (erbt OSError!) — NIE den Lauf killen
            print(f"diarize: SKIP {base} ({type(e).__name__}: {e}) — Korrektur ohne Cluster", flush=True)
    print(f"diarize: {n} Datei(en) diarisiert", flush=True)
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
    # Ohne MCP-Server: 16,3s -> 7,7s Startup je Aufruf (gemessen). Die Korrektur braucht nur
    # Read/Write — und sie verarbeitet nicht vertrauenswürdigen Transkripttext, da haben die
    # persönlichen MCP-Server (Mail, Notion, …) ohnehin nichts verloren.
    cmd = [exe, "-p", "--model", CLAUDE_MODEL,
           "--permission-mode", "acceptEdits", "--allowedTools", "Read,Write",
           "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
           "--add-dir", paths.projekte_root()]
    try:
        # ponytail: subprocess.run-timeout killt nur den claude-Prozess, nicht dessen
        # Kind-Prozessbaum (MCP-Server) — für ein lokales Ein-Nutzer-Tool ok; falls je
        # relevant: claude in einem Windows-Job-Object starten und die Gruppe killen.
        with _claude_slots:      # globaler Deckel über alle parallelen Dateien UND Blöcke
            r = subprocess.run(cmd, cwd=paths.projekte_root(), input=prompt, capture_output=True,
                               text=True, encoding="utf-8", errors="replace", timeout=CLAUDE_TIMEOUT,
                               creationflags=_CREATE_NO_WINDOW)
        if r.returncode != 0:
            tail = ((r.stdout or "") + (r.stderr or "")).strip()[-500:]
            print(f"  claude exit {r.returncode}: {tail}", flush=True)
    except subprocess.TimeoutExpired:
        print(f"  claude Timeout nach {CLAUDE_TIMEOUT}s", flush=True)


def _ask_llm(prompt: str, inputs: list, output: str) -> None:
    """Eine LLM-Runde, unabhaengig vom eingestellten Anbieter.

    Beim Abo schreibt `claude -p` die Zieldatei per Write-Tool selbst; mit API-Key gibt es
    keine Werkzeuge, also wandern die Eingaben in den Prompt und die Antwort schreibt llm.py.
    In beiden Faellen gilt: Erfolg wird an der geschriebenen Datei gemessen, ein Fehler wird
    nur geloggt — eine Datei darf den Batch nicht abbrechen."""
    if not llm.use_api():
        _run_claude(prompt)
        return
    with _claude_slots:                      # derselbe Deckel wie im Abo-Weg
        try:
            llm.complete_to_file(prompt, inputs, output)
        except llm.LLMError as e:
            print(f"  KI-Anbieter: {e}", flush=True)


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


def _scope(id_range, known: str = "") -> tuple:
    """(Block-Anweisung, Kurzform) für gestückelte Dateien; ('', 'aus der Datei') = ganze Datei.
    Die schon vergebenen Sprecher-Namen wandern mit, sonst tauft Block 4 denselben
    Menschen anders als Block 1."""
    if not id_range:
        return "", "aus der Datei"
    a, b = id_range
    hint = ("\nBereits vergebene Sprecher-Namen aus früheren Blöcken — verwende sie EXAKT so weiter "
            f"(gleicher Mensch = gleicher Name): {known}" if known else "")
    block = (f"\nNUR EIN BLOCK: Diese Datei wird blockweise bearbeitet. Lies sie GANZ als Kontext, gib aber "
             f"AUSSCHLIESSLICH die Segmente mit den IDs {a} bis {b} (einschliesslich) aus — keine ID "
             f"ausserhalb, keine innerhalb auslassen.{hint}\n")
    return block, f"von {a} bis {b}"


def _correct_prompt(base: str, tagged_path: str, cpath: str, gjson: str, context: str,
                    id_range=None, known: str = "") -> str:
    block, scope = _scope(id_range, known)
    return f"""Du korrigierst EIN Interview-Transkript SEGMENT FÜR SEGMENT (oft Schweizerdeutsch -> lesbares Standarddeutsch) und labelst die Sprecher.

Projekt-Kontext: {context or DEFAULT_CONTEXT}
{block}
1) Lies die Rohsegmente vollständig (Read-Tool) aus:
{tagged_path}
   Jede Zeile: "[<id>] (Sprecher N) <text>" — das Präfix (Sprecher N) ist die AKUSTISCH erkannte Sprecher-Gruppe (Diarisierung); fehlt es, gibt es keine akustische Info. Unsichere Wörter sind inline als [[Wort|Wahrscheinlichkeit]] markiert (niedrige Whisper-Konfidenz) — dort besonders genau hinsehen.

Gemeinsames Glossar (für konsistente Schreibweisen — nutze es, ergänze nichts Erfundenes):
{gjson or "(keins)"}

2) KORRIGIEREN: klare ASR-Fehler mit Kontext + Glossar verbessern, zu lesbarem Standarddeutsch normalisieren (Schweizer „ss"). BLEIB TREU: nichts erfinden, den Sinn nicht verändern, nicht über das Nötige hinaus glätten (Füllwörter wie „äh"/„ähm" dürfen dezent weg). Entferne die [[...]]-Markierungen im Ausgabetext.
3) PRO SEGMENT: gib für JEDE Segment-ID {scope} GENAU EINEN Eintrag {{id, speaker, text}} zurück — keine ID auslassen, keine Segmente zusammenfassen (die Redebeitrags-Bündelung passiert später).
4) SPRECHER: Das akustische (Sprecher N)-Präfix ist die WAHRHEIT, WER spricht — vergib pro Cluster GENAU EINEN konsistenten Namen: meist „Interviewer" (stellt Fragen) und die befragte Person (Name/Betrieb falls genannt, sonst „Befragte Person"). Du DARFST zwei Cluster demselben Namen zuordnen, wenn klar dieselbe Person. Eine Cluster-Grenze nur überschreiben, wenn sie offensichtlich falsch ist (z.B. ein einzelnes Rückkanal-Wort). Fehlt das Präfix, ordne nach Inhalt zu (wie bisher). Gib JEDEM Segment einen Sprecher.
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


def _verify_prompt(base: str, tagged_path: str, cpath: str, context: str, id_range=None,
                   known: str = "") -> str:
    # `known` MUSS mit: der Treue-Pass prueft ausdruecklich die Sprecherzuordnung und schreibt
    # die Datei neu. Ohne die schon vergebenen Namen taufte er Block 2..n um und haette den
    # Anker aus Block 1 wieder zunichte gemacht.
    block, scope = _scope(id_range, known)
    return f"""Du prüfst eine bereits erstellte SEGMENT-GENAUE Korrektur auf TREUE gegen das Rohtranskript (TREUE-CHECK) und schreibst die geprüfte Fassung zurück.

Projekt-Kontext: {context or DEFAULT_CONTEXT}
{block}
1) Lies das ROH vollständig (Read-Tool) aus:
{tagged_path}
   Jede Zeile: "[<id>] (Sprecher N) <text>" — das (Sprecher N)-Präfix ist die akustische Sprecher-Gruppe (falls vorhanden); unsichere Wörter inline als [[Wort|Wahrscheinlichkeit]] markiert.
2) Lies die zu prüfende Korrektur (Read-Tool) aus:
{cpath}

Prüfe kritisch gegen das ROH — konservativ, im Zweifel näher am Original:
- HALLUZINATION/DRIFT: Inhalt hinzugefügt/weggelassen/im Sinn verändert, der nicht im Roh steht? Übermässiges Umschreiben? → näher ans Original zurück.
- VOLLSTÄNDIGKEIT: für JEDE Roh-Segment-ID {scope} genau ein Eintrag? Fehlende ergänzen (Text nah am Roh), zusammengefasste auftrennen.
- SPRECHER: konsistent pro akustischem (Sprecher N)-Cluster und plausibel (Interviewer stellt Fragen; Antworten korrekt zugeordnet)? Fehlzuordnungen korrigieren.
- RESTFEHLER: offensichtliche verbleibende ASR-Fehler nur wenn eindeutig (konservativ).
- UNSICHER: wirklich unklare Stellen NICHT raten — nah am Original belassen und unter annotations vermerken. Entferne evtl. übrige [[...]]-Markierungen im Text.

Schreibe die VOLLSTÄNDIGE, geprüfte Korrektur mit dem Write-Tool als JSON nach GENAU diesem Pfad (alle Segment-IDs {scope}, gleiches Schema):
{cpath}

Schema:
{{
  "base": "{base}",
  "context": "1-2 Sätze zum Gespräch",
  "speakers": ["Interviewer", "..."],
  "segments": [{{"id": <zahl>, "speaker": "...", "text": "..."}}],
  "annotations": ["..."],
  "summary": "was du geändert hast, oder 'keine Änderung'"
}}
Ändere NUR, was wirklich nötig ist; unproblematische Segmente unverändert übernehmen. Gib ausser der geschriebenen Datei nichts weiter aus."""


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
        _ask_llm(_glossary_prompt(gpath, raw_files, context), raw_files, gpath)
    try:
        g = _load(gpath)
    except (OSError, json.JSONDecodeError):
        print("⚠ Glossar fehlt/ungültig — fahre ohne gemeinsames Glossar fort", flush=True)
        return ""
    print(f"✓ Glossar: {len(g.get('proper_nouns') or [])} Eigennamen, "
          f"{len(g.get('likely_corrections') or [])} Korrekturen", flush=True)
    return json.dumps(g, ensure_ascii=False, indent=1)


_ID_RE = re.compile(r"^\[(\d+)\]")


def _tagged_ids(tagged_path: str) -> list:
    """Segment-IDs in genau der Reihenfolge, in der claude sie in <base>.tagged.txt sieht."""
    with open(tagged_path, encoding="utf-8") as fh:
        return [int(m.group(1)) for m in (_ID_RE.match(line) for line in fh) if m]


def _speaker_hint(docs: list, clusters: dict) -> str:
    """Sprecher-Namen der schon korrigierten Blöcke — je akustischem Cluster, falls
    diarisiert, sonst als blosse Namensliste."""
    by_cluster, names = {}, []
    for d in docs:
        for s in (d.get("segments") or []):
            if not isinstance(s, dict):
                continue
            name = str(s.get("speaker") or "").strip()
            if not name:
                continue
            if name not in names:
                names.append(name)
            c = clusters.get(s.get("id"))
            if c and c not in by_cluster:
                by_cluster[c] = name
    if by_cluster:
        return "; ".join(f"{c} = {n}" for c, n in sorted(by_cluster.items()))
    return ", ".join(names)


def _merge_parts(docs: list, base: str) -> dict:
    """Block-Korrekturen zu EINER correction.json vereinen (IDs aufsteigend, Sprecher-Liste
    vereinigt, Anmerkungen aneinandergehängt)."""
    segs, speakers, ann = [], [], []
    for d in docs:
        segs.extend(s for s in (d.get("segments") or []) if isinstance(s, dict))
        for name in (d.get("speakers") or []):
            if name not in speakers:
                speakers.append(name)
        ann.extend(str(a).strip() for a in (d.get("annotations") or []) if a is not None and str(a).strip())
    segs.sort(key=lambda s: s.get("id") if isinstance(s.get("id"), int) else 0)
    return {"base": base,
            "context": next((d.get("context") for d in docs if d.get("context")), ""),
            "speakers": speakers, "segments": segs, "annotations": ann,
            "summary": next((d.get("summary") for d in docs if d.get("summary")), "")}


def _correct_one(base: str, tagged: str, target: str, gjson: str, context: str, verify: bool,
                 id_range=None, known: str = "", part: str = "") -> None:
    """Ein claude-Korrekturlauf (+ optionaler Treue-Pass) mit Ziel `target` — ganze Datei
    oder ein ID-Block. Die Fortschritts-Zeilen sind Vertrag mit dem Frontend-Job-Parser
    (webtool/frontend/src/lib/jobPhases.ts) — Format nicht ändern. `part` (z.B. ' · Block 2/3')
    gehört in JEDE Zeile: bei parallelen Läufen verschränken sich die Ausgaben, eine Zeile
    ohne Basisnamen liesse sich keinem Lauf mehr zuordnen."""
    print(f"→ Korrigiere {base}{part} …", flush=True)
    _ask_llm(_correct_prompt(base, tagged, target, gjson, context, id_range, known),
             [tagged], target)
    if verify and _valid_correction(target):    # Treue-Pass nur auf eine GÜLTIGE Erst-Korrektur
        print(f"→ Verifiziere {base}{part} (Treue gegen Roh) …", flush=True)
        good = _load(target)                    # Snapshot: darf nicht durch einen kaputten Verify verloren gehen
        # Der Treue-Pass prueft die Korrektur GEGEN das Roh -> ohne API-Werkzeuge braucht er beide Dateien.
        _ask_llm(_verify_prompt(base, tagged, target, context, id_range, known),
                 [tagged, target], target)
        if not _valid_correction(target):       # Verify hat die gültige Korrektur zerstört -> zurückrollen
            paths.atomic_write(target, json.dumps(good, ensure_ascii=False, indent=1))
            print(f"⚠ Verifikation ungültig — behalte unverifizierte {base}.correction.json", flush=True)


def _correct_file(project: str, base: str, gjson: str, context: str, verify: bool) -> None:
    """Korrektur für EINE Datei -> <base>.correction.json.

    Bis CHUNK_SEGMENTS Segmente genau wie bisher: ein claude-Aufruf schreibt direkt die
    correction.json. Darüber blockweise, weil ein einzelner Aufruf sonst tausende Zeilen
    JSON am Stück schreiben müsste und in CLAUDE_TIMEOUT läuft. Jeder Block schreibt sein
    eigenes <base>.partN.correction.json; die bleiben bei Abbruch/Fehler liegen und werden
    beim nächsten Lauf wiederverwendet (Resume je Block statt je Datei). Zusammengeführt
    wird nur, wenn ALLE Blöcke gültig sind — eine halbe correction.json würde beim nächsten
    Lauf als fertig durchgewinkt und die fehlenden Blöcke nie nachgeholt."""
    tdir = paths.transkripte_dir(project)
    cpath = os.path.abspath(os.path.join(tdir, base + ".correction.json"))
    tagged = os.path.abspath(os.path.join(tdir, base + ".tagged.txt"))
    raw_json = os.path.join(tdir, base + ".json")   # Frische-Anker der Blöcke: die Roh-JSON, NICHT
    ids = _tagged_ids(tagged)                       # tagged.txt — das schreibt cmd_prep bei JEDEM Lauf neu,
                                                    # womit kein Block je „neuer" wäre und der Resume tot.
    if len(ids) <= CHUNK_SEGMENTS:
        _correct_one(base, tagged, cpath, gjson, context, verify)
        return
    chunks = [ids[i:i + CHUNK_SEGMENTS] for i in range(0, len(ids), CHUNK_SEGMENTS)]
    clusters = _load_diar_clusters(tdir, base) if _diarize_enabled() else {}
    parts = [os.path.abspath(os.path.join(tdir, f"{base}.part{i}.correction.json"))
             for i in range(1, len(chunks) + 1)]
    print(f"  {base}: {len(ids)} Segmente → {len(chunks)} Blöcke à max. {CHUNK_SEGMENTS}", flush=True)

    def block(i: int, known: str):
        chunk, ppath = chunks[i - 1], parts[i - 1]
        label = f" · Block {i}/{len(chunks)}"
        if _valid_correction(ppath) and os.path.getmtime(ppath) >= os.path.getmtime(raw_json):
            print(f"  ↷ {base}{label} schon vorhanden", flush=True)
        else:
            _correct_one(base, tagged, ppath, gjson, context, verify,
                         id_range=(chunk[0], chunk[-1]), known=known, part=label)
        if _valid_correction(ppath):
            print(f"  ✓ {base}{label} fertig", flush=True)
            return _load(ppath)
        print(f"  ✗ {base}{label} ohne gültiges Ergebnis", flush=True)
        return None

    # Block 1 läuft ALLEIN vor: aus ihm kommt die Cluster→Name-Zuordnung, an der sich alle
    # weiteren Blöcke orientieren. Parallel von Anfang an würde jeder Block eigene Namen für
    # denselben Sprecher erfinden, und _merge_parts hätte am Ende vier Personen statt zwei.
    docs = [block(1, "")]
    if not docs[0]:
        # Ohne Anker duerfen die uebrigen Bloecke NICHT laufen: sie schrieben gueltige
        # Teil-Dateien mit selbst erfundenen Namen, die der naechste Lauf als "schon
        # vorhanden" wiederverwendet — die Inkonsistenz waere dann dauerhaft.
        print(f"  ✗ {base}: Block 1 gescheitert — die weiteren Blöcke braeuchten seine "
              f"Sprecher-Zuordnung, ein erneuter Lauf faengt bei Block 1 an", flush=True)
        return
    if len(chunks) > 1:
        known = _speaker_hint([d for d in docs if d], clusters)
        with ThreadPoolExecutor(max_workers=min(len(chunks) - 1, CLAUDE_PARALLEL)) as ex:
            docs += list(ex.map(lambda i: block(i, known), range(2, len(chunks) + 1)))
    docs = [d for d in docs if d]
    if len(docs) < len(chunks):
        print(f"  ✗ {base}: {len(chunks) - len(docs)} von {len(chunks)} Blöcken fehlgeschlagen — Teil-Dateien "
              f"bleiben liegen, ein erneuter Lauf holt nur diese nach", flush=True)
        return
    merged = _merge_parts(docs, base)
    fehlend = len(ids) - len({s.get("id") for s in merged["segments"]})
    if fehlend > 0:                              # Blöcke gültig, aber IDs ausgelassen -> apply lässt sie roh
        print(f"  ⚠ {base}: {fehlend} Segment(e) ohne Korrektur — bleiben auf Rohstand", flush=True)
    paths.atomic_write(cpath, json.dumps(merged, ensure_ascii=False, indent=1))
    print(f"  ✓ {base}: {len(chunks)} Blöcke zusammengeführt ({len(merged['segments'])} Segmente)", flush=True)
    for p in parts:                              # erst nach erfolgreichem Merge aufräumen
        try:
            os.remove(p)
        except OSError:
            pass


def cmd_run(project: str, base: str = None, force: bool = False, verify: bool = True) -> int:
    tdir = paths.transkripte_dir(project)
    all_bases = bases(project)
    if base is not None:                               # expliziter Einzel-Datei-Lauf (Per-Datei-✎)
        if base not in all_bases:
            print(f"run: keine solche Datei: {base!r}", flush=True)
            return 0
        all_bases = [base]
    if not all_bases:
        print("run: keine Roh-Transkripte — erst transkribieren", flush=True)
        return 0
    print(f"run: {len(all_bases)} Datei(en) in Projekt {project!r}", flush=True)
    cmd_diarize(project, all_bases)                    # -> <base>.diar.json (best-effort, GPU); scoped auf all_bases
    cmd_prep(project)                                  # -> <base>.tagged.txt (Cluster-Präfix falls diarisiert)
    context = _context(project)
    gjson = _glossary(project, context)                # Glossar bleibt korpus-weit (über bases(project))
    def one(b: str) -> bool:
        try:  # eine kaputte Datei darf den Batch nicht abbrechen
            epath = os.path.join(tdir, b + ".edit.json")
            cpath = os.path.join(tdir, b + ".correction.json")
            raw_json = os.path.join(tdir, b + ".json")
            if _is_human_edited(epath) and not force:
                print(f"↷ SKIP {b} (human_edited=true; --force zum Neu-Korrigieren)", flush=True)
                return False
            # correction nur im Batch (kein explizites base) und nicht erzwungen wiederverwenden — ein
            # expliziter Einzel-Datei-Lauf korrigiert bewusst neu. Reuse setzt zudem voraus, dass die
            # correction neuer als die Roh-JSON ist (sonst nach Neu-Transkription veraltet).
            reuse = (base is None and not force
                     and os.path.exists(cpath) and os.path.getmtime(cpath) >= os.path.getmtime(raw_json))
            if reuse:
                print(f"↷ nutze vorhandene {b}.correction.json", flush=True)
            else:
                _correct_file(project, b, gjson, context, verify)
            if not _valid_correction(cpath):
                print(f"✗ FEHLT/ungültig: {b}.correction.json — überspringe", flush=True)
                return False
            cmd_apply(project, b, force=force)           # force überschreibt human_edited edit.json
            return True
        except Exception as e:
            print(f"✗ Fehler bei {b}: {e} — überspringe", flush=True)
            return False

    # Dateien sind nach dem Glossar voneinander unabhängig -> parallel. Die Threads warten fast
    # nur auf Opus; wie viele davon wirklich gleichzeitig laufen, regelt _claude_slots.
    with ThreadPoolExecutor(max_workers=min(len(all_bases), CLAUDE_PARALLEL)) as ex:
        done = sum(ex.map(one, all_bases))
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
    r.add_argument("base", nargs="?"); r.add_argument("--force", action="store_true")
    r.add_argument("--no-verify", action="store_true")   # Treue-Pass abschalten (auch via Env TRANSKRIBOR_VERIFY=0)
    args = ap.parse_args(argv)
    paths.safe_name(args.project)
    if args.cmd == "prep":
        cmd_prep(args.project)
    elif args.cmd == "run":
        if args.base is not None:
            paths.safe_name(args.base)
        # Treue-Pass: Default an; abschaltbar per --no-verify oder Env TRANSKRIBOR_VERIFY=0
        # (Env greift server-weit — der Job-Subprozess erbt die uvicorn-Umgebung, kein Browser-Toggle).
        verify = (os.environ.get("TRANSKRIBOR_VERIFY", "1").strip().lower()
                  not in ("0", "false", "no")) and not args.no_verify
        done = cmd_run(args.project, args.base, args.force, verify)
        # Exitcode fürs Job-Signal: Fehler nur, wenn Dateien VERSUCHT wurden aber KEINE gelang —
        # sonst wäre der Job „done" trotz Totalausfall (z.B. claude fehlt auf PATH). Scope = eine
        # Datei (Per-Datei-Lauf) oder alle; „nichts zu tun" (human_edited ohne --force / keine bzw.
        # unbekannte Datei) ist kein Fehler.
        tdir = paths.transkripte_dir(args.project)
        present = bases(args.project)
        scope = [args.base] if args.base else present
        attempted = sum(1 for b in scope if b in present
                        and (args.force or not _is_human_edited(os.path.join(tdir, b + ".edit.json"))))
        if attempted and not done:
            print(f"run: FEHLER — 0 von {attempted} versuchten Datei(en) korrigiert "
                  f"(claude nicht erreichbar oder ohne Ausgabe?)", flush=True)
            raise SystemExit(1)
    else:
        paths.safe_name(args.base)
        cmd_apply(args.project, args.base, args.force)


if __name__ == "__main__":
    main()
