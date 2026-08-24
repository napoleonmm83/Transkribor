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
import contextlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from . import llm
from . import paths
from . import settings
from . import sperre
from . import sprachen           # importiert selbst nichts -> kein Zirkel
from .edit_model import tag_uncertain_segments, apply_correction
from .render_md import render_md

AUDIO_EXT = (".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma", ".mp4")

CLAUDE_MODEL = "opus"        # Rueckfall, wenn in den Einstellungen nichts steht
CLAUDE_TIMEOUT = 900          # s pro claude-Aufruf; Hänger killen statt Job blockieren
CHUNK_SEGMENTS = 150          # max. Segmente pro claude-Aufruf; darüber wird die Datei gestückelt.
                              # Der Engpass ist der OUTPUT: ~540 Segmente sind ~15k Tokens JSON am
                              # Stück und laufen in CLAUDE_TIMEOUT (echter Fall: 21-min-Interview).
# Gleichzeitige claude-Aufrufe. Die Aufrufe warten fast nur auf Opus, also parallelisieren
# Threads sie gut. Der Deckel sitzt bewusst an _run_claude und nicht an den Executors: Datei-
# und Block-Parallelität wären sonst multiplikativ (3 Dateien × 3 Blöcke = 9 Opus-Sessions).
#
# `settings.PARALLEL_MAX` klemmt AUCH den Weg über die Umgebungsvariable, und das ist eine
# Korrektur an dieser Zeile: sie hatte nur `max(1, …)`, während `.env.example` die Variable
# seit demselben Diff bewirbt. Gemessen an einem Prüfstand mit 16 Dateien à 6 Blöcken
# (192 Aufrufe): bei `TRANSKRIBOR_PARALLEL=200` deckelt der Semaphor nichts mehr, übrig
# bleiben **80 gleichzeitige `claude -p`** — 80 node-Prozesse, ausgelöst von einem Tippfehler
# („160" statt „16"). Die Analogie zu `TRANSKRIBOR_MIX_SCHWELLE` (dort wird bewusst nicht
# geklemmt) trägt hier NICHT: ein falscher Schwellenwert kostet Qualität, eine falsche
# Slot-Zahl startet Prozesse. Wer wirklich mehr will, hebt PARALLEL_MAX — eine Zahl, eine
# Stelle. Geklemmt wird laut, nicht still.
_ROH_PARALLEL = os.environ.get("TRANSKRIBOR_PARALLEL") or ""
# Die Rechnung steht in settings, nicht hier: die Einstellungsseite muss dieselbe Zahl
# nennen koennen, und zwei Fassungen davon waeren genau die Divergenz, gegen die
# PARALLEL_MAX die eine Quelle sein soll. Ein Tippfehler faellt dort auf 3 zurueck, statt
# den Korrekturlauf zu killen.
CLAUDE_PARALLEL = settings.parallel_wirksam(_ROH_PARALLEL or "3")
if _ROH_PARALLEL:
    # Verglichen wird die ZAHL, nicht die Zeichenkette: `"03"` und `"+3"` ergeben beide 3,
    # ein Textvergleich meldete dort eine Abweichung, die es nicht gibt (CodeRabbit-CLI).
    # Ein nicht lesbarer Wert IST eine Abweichung — dort greift der Rueckfall auf 3.
    try:
        _weicht_ab = int(_ROH_PARALLEL) != CLAUDE_PARALLEL
    except ValueError:
        _weicht_ab = True
    if _weicht_ab:
        # NICHT still: der Nutzer hat eine Zahl hingeschrieben und bekommt eine andere.
        print(f"TRANSKRIBOR_PARALLEL={_ROH_PARALLEL!r} ist nicht der wirksame Wert — "
              f"nehme {CLAUDE_PARALLEL} (erlaubt 1…{settings.PARALLEL_MAX})",
              file=sys.stderr, flush=True)
_claude_slots = threading.Semaphore(CLAUDE_PARALLEL)
_letzte_diagnose: dict | None = None
_CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0


def _default_context(ziel: str, dialekt: bool = True, mehrsprachig: bool = False) -> str:
    """Fallback-Kontext, wenn kein kontext.md vorliegt.

    `dialekt=True` (Default -- Repo-Hauptfall Schweizerdeutsch) liefert die
    urspruengliche dialektsignalisierende Prosa (ohne ziel-Phrase, da sie
    Schweizerdeutsch fest annimmt). `dialekt=False` gibt einen sprachneutralen,
    ziel-gerichteten Fallback. Letzteres ersetzt das alte feste `DEFAULT_CONTEXT`,
    das "oft Schweizerdeutsch/Dialekt" einbrannte -- falsch fuer jede
    nicht-schweizerdeutsche Aufnahme (z.B. ein englischsprachiges Video kam als
    deutsches Transkript zurueck).

    `mehrsprachig` gewinnt gegen `dialekt`: der Dialekt-Text behauptet EINE gesprochene
    Sprache und stuende sonst als erste Zeile ueber einem Prompt, dessen Regel 2 das
    Gegenteil sagt. Ein Kontext, der der Regel widerspricht, ist genau die Form, an der
    die [Musik]-Regel schon einmal haengengeblieben ist."""
    if mehrsprachig:
        return ("Interviews mit MEHREREN gesprochenen Sprachen (Hauptsprache: "
                f"{ziel or 'siehe unten'}), von Whisper transkribiert. ASR-Fehler v.a. bei "
                "Eigennamen und an den Sprachwechseln.")
    if dialekt:
        return ("Interviews (gesprochene Sprache oft Schweizerdeutsch/Dialekt), "
                "von Whisper transkribiert. ASR-Fehler v.a. bei Eigennamen und Dialektbegriffen.")
    return (f"Interviews (gesprochene Sprache), von Whisper transkribiert. "
            f"ASR-Fehler v.a. bei Eigennamen. Ziel: normalisieren zu {ziel or 'klarem Text'}.")


def _ziel_dialekt(project: str, base: str) -> tuple:
    """(ziel-Phrase, dialekt-Flag, mehrsprachig-Flag) fuer die Prompts einer Datei.

    'auto' wird an der ROH-JSON aufgeloest (Whispers detektierter language-Code) --
    mit dem PROJEKT-STANDARD als Vorrang: erkennt Whisper 'de' und das Projekt steht auf
    'ch', gilt 'ch' samt Dialekt-Glaettung (Spec 10.1). Bei jeder anderen erkannten
    Sprache greift der Standard nicht. Ohne passenden Standard bleibt es dabei, dass
    'ch' nie aus einer Detektion kommt.

    `ziel` und `dialekt` folgen auch bei gemischten Aufnahmen UNVERAENDERT der
    Ankersprache — das mehrsprachig-Flag kommt zusaetzlich, es ersetzt nichts."""
    from . import projekt as _pj, sprachen as _s
    sid = _pj.datei_sprache(project, base)
    if sid == "auto":
        # Der Pfadbau darf hier IM try stehen: `_pj.datei_sprache` eine Zeile hoeher geht
        # ueber `projekt.laden`, das unsichere Namen bereits wirft (dort steht der Pfadbau
        # deshalb ausserhalb). Ein zweiter Riegel waere hier unerreichbar — und damit ein
        # Waechter, den kein Test rot bekommt (gemessen: Mutation liess alle 623 gruen).
        try:
            code = _load(os.path.join(paths.transkripte_dir(project), base + ".json")).get("language")
        except (OSError, ValueError):     # ValueError deckt auch UnicodeDecodeError (#190)
            code = None
        sid = _s.von_whisper_code(code, _pj.laden(project)["sprache"]) if code else "de"
    return _s.ziel_phrase(sid), _s.ist_dialekt(sid), _pj.datei_mehrsprachig(project, base)


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
        daten = json.load(fh)
    if not isinstance(daten, dict):
        # Gueltiges JSON, aber kein Objekt (ein Modell antwortet auch mal mit einer Liste).
        # Die Aufrufer fangen alle ValueError und fallen zurueck; das `.get` daneben wuerfe
        # stattdessen AttributeError glatt an ihnen vorbei — dieselbe gebrochene Zusage wie
        # bei #190, nur ueber einen anderen Ausnahmetyp.
        raise ValueError(f"{path}: JSON-Objekt erwartet, {type(daten).__name__} gelesen")
    return daten


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
            clusters = _load_diar_clusters(tdir, base) if diarize_enabled() else {}
            lines = []
            for s in segs:
                spk = clusters.get(s["id"])
                prefix = f"({spk}) " if spk else ""
                lines.append(f"[{s['id']}] {prefix}{s['tagged_text']}")
            paths.atomic_write(os.path.join(tdir, base + ".tagged.txt"), "\n".join(lines) + "\n")
            n += 1
        except (OSError, ValueError) as e:     # ValueError deckt auch UnicodeDecodeError (#190)
            # Keine Ursachenbehauptung mehr, nur der Typ: dieser `try` umspannt den ganzen
            # Schleifenkoerper — auch den `atomic_write`, der an einem einzelnen Surrogat in
            # der Roh-JSON mit UnicodeEncodeError stirbt (gemessen). "Roh-JSON unlesbar" war
            # dort schlicht falsch, und `str(e)` nennt den Typ bei keiner dieser Klassen.
            print(f"prep: SKIP {base} ({type(e).__name__}: {e})", flush=True)
    print(f"prep: {n} Datei(en) getaggt in {tdir}")
    return n


DIARIZE_MIN_SPEAKERS = 2      # pyannote-Untergrenze; das Sidecar zeichnet denselben Wert auf (kein Drift)

# Die EINE Fassung der Cluster-Regel, eingebettet in alle vier Prompts, die Sprecher vergeben.
# Vier Kopien liefen beim naechsten Umbau auseinander — und ausgerechnet der Verify-Pass, der
# ZULETZT schreibt, haette dann die Fassung ohne Erlaubnis (genau der Zustand vor #267).
#
# Der Satzbau ist Absicht: die Regel ERSETZT in _correct_prompt/_verify_prompt die
# widersprechende Anweisung ("das Praefix ist die WAHRHEIT, WER spricht" bzw.
# "Fehlzuordnungen korrigieren"), sie steht nicht daneben — dieselbe Entscheidung wie bei der
# Mehrsprachig-Regel weiter unten. Eine blosse Erlaubnis stand seit 328ebf2 in
# _correct_prompt, und die Aufspaltung passierte trotzdem; es fehlten beide Haelften: das
# Erkennungsmerkmal UND die Abwesenheit des Gegensatzes.
CLUSTER_REGEL = (
    "Ein Cluster-Wechsel heisst: die STIMME wechselt — nicht zwingend die PERSON. Bei "
    "Aufnahmen mit einem Kameramikrofon verteilt die Diarisierung denselben Menschen "
    "regelmässig auf mehrere Cluster; sprechen zwei Cluster durchweg in Frageform, ist das "
    "derselbe Interviewer. Zwei Cluster denselben Namen zu geben ist deshalb eine ERLAUBTE "
    "Entscheidung, KEINE Fehlzuordnung."
)


def _sidecar_sprecher(dpath: str):
    """Mit welcher Sprecherzahl wurde ein vorhandenes `<base>.diar.json` gerechnet?

    `None` heisst „automatisch" — und deckt drei Faelle zusammen: kein Eintrag (Sidecar aus
    der Zeit vor diesem Feld), ausdruecklich `null`, und eine unlesbare Datei. Die letzte
    Gleichsetzung ist die interessante: ein kaputtes Sidecar meldet damit „automatisch" und
    wird neu erzeugt, sobald eine Zahl eingestellt ist — und bleibt sonst liegen wie bisher.
    Werfen darf die Funktion nicht, sie sitzt in der Skip-Entscheidung eines Batch-Laufs.
    """
    try:
        return _load(dpath).get("sprecher")
    except Exception:
        return None


def diarize_enabled() -> bool:
    """Ist die akustische Sprechertrennung eingeschaltet? (`TRANSKRIBOR_DIARIZE`)

    Oeffentlich, weil `app.py` sie beantwortet: der Datei-Einstellungs-Dialog zeigt sonst ein
    Feld an, das nichts tut (#266). Eine zweite Kopie der Regel dort waere die Divergenzfalle —
    dieselbe Regel an zwei Orten laeuft beim naechsten Umbau auseinander.
    """
    return os.environ.get("TRANSKRIBOR_DIARIZE", "1").strip().lower() not in ("0", "false", "no")


def cmd_diarize(project: str, only_bases: list = None) -> int:
    """Akustische Diarisierung je Datei -> <base>.diar.json (best-effort, idempotent).
    Fehlt pyannote oder scheitert die Diarisierung, wird die Datei übersprungen
    (kein Sidecar) — die Korrektur läuft dann ohne Cluster (Text-Raten wie bisher).
    only_bases scopt auf einen Einzel-Datei-Lauf (✎) — sonst wäre ein Ein-Datei-run GPU-teuer
    fürs ganze Projekt, obwohl Diarisierung pro Datei unabhängig ist."""
    if not diarize_enabled():
        print("↷ Diarisierung deaktiviert (TRANSKRIBOR_DIARIZE=0)", flush=True)
        return 0
    tdir = paths.transkripte_dir(project)
    n = 0
    t_phase = time.monotonic()
    for base in (only_bases if only_bases is not None else bases(project)):
        dpath = os.path.join(tdir, base + ".diar.json")
        raw_json = os.path.join(tdir, base + ".json")
        from . import projekt as _pj          # lazy wie in `_ziel_dialekt` (s. dort)
        sprecher = _pj.datei_sprecher(project, base)
        try:
            # >= (nicht >): das Sidecar wird stets NACH der Roh-JSON geschrieben; ein Skip bei exakt
            # gleicher Sekunde ist unrealistisch (Transkription dauert Minuten). Neu-Diarisieren = Sidecar löschen.
            #
            # Die mtime allein reicht seit der Sprecherzahl NICHT mehr: das Sidecar ist nach
            # jedem Lauf neuer als die Roh-JSON, wer die Zahl also nachtraeglich eintraegt und
            # neu korrigieren laesst, bekaeme die ALTE Clusterung — der Schalter waere tot, und
            # der Lauf meldete dazu Erfolg. Deshalb zaehlt zusaetzlich, WOMIT gerechnet wurde.
            # `_sidecar_sprecher` liest den aufgezeichneten Wert; ein Sidecar aus der Zeit vor
            # diesem Feld hat keinen und gilt als „automatisch" (= None) — hat der Nutzer nichts
            # eingestellt, aendert sich damit nichts, und genau das ist gewollt.
            if (os.path.exists(dpath) and os.path.getmtime(dpath) >= os.path.getmtime(raw_json)
                    and _sidecar_sprecher(dpath) == sprecher):
                print(f"↷ nutze vorhandene {base}.diar.json", flush=True)
                continue
            audio = _audio_path(project, base)
            if not audio:
                print(f"diarize: SKIP {base} (kein Audio gefunden)", flush=True)
                continue
            from . import diarize                       # lazy: zieht torch/pyannote erst hier
            raw = _load(raw_json)
            # Das ueberholte Sidecar geht VOR dem Rechnen weg, nicht erst durch das
            # Ueberschreiben danach — das ist die Antwort auf „was erlaubt die Reparatur NEU?".
            # Scheitert `diarize_file` (GPU-OOM, pyannote fehlt), wird `atomic_write` nie
            # erreicht: das alte Sidecar bliebe liegen, die Ungleichheit bestuende fort, und
            # JEDER weitere Lauf rechnete erneut — bei einem dauerhaften Fehler endlos. Zudem
            # laese `cmd_prep` weiter die ALTE Clusterung ein, waehrend das Protokoll
            # „Korrektur ohne Cluster" behauptet: eine stille Falschzuordnung ausgerechnet fuer
            # den Nutzer, der die Zahl gerade gesetzt hat. Nach dem Loeschen ist der Fehlerfall
            # exakt der dokumentierte „kein Sidecar"-Zustand (Korrektur ohne Cluster, wie vor
            # Stufe 3). Erst NACH der Audio-Pruefung: fehlt die Tonspur, kann nie wieder
            # diarisiert werden — dann ist das alte Sidecar besser als keines.
            if os.path.exists(dpath):
                with contextlib.suppress(OSError):   # best effort; sonst ueberschreibt unten ohnehin
                    os.remove(dpath)
            wieviele = f" ({sprecher} Sprecher)" if sprecher else ""
            print(f"→ Diarisiere {base}{wieviele} …", flush=True)
            diagnose: dict = {}
            t0 = time.monotonic()
            turns = diarize.diarize_file(audio, min_speakers=DIARIZE_MIN_SPEAKERS,
                                         num_speakers=sprecher, diagnose=diagnose)
            dt = time.monotonic() - t0
            if not turns:
                print(f"diarize: SKIP {base} (keine Sprecher erkannt)", flush=True)
                continue
            seg_speakers = diarize.assign_clusters(raw, turns)
            # `min_speakers` nur, wenn es auch gewirkt hat: bei gesetzter Sprecherzahl geht
            # ausschliesslich `num_speakers` an pyannote, und eine Grenze im Sidecar, die der
            # Lauf nie gesehen hat, schickt den naechsten Debugger auf die falsche Faehrte.
            doc = {"base": base, "audio": os.path.basename(audio),
                   "min_speakers": None if sprecher else DIARIZE_MIN_SPEAKERS,
                   "sprecher": sprecher,          # womit gerechnet wurde -> Skip-Entscheidung oben
                   "turns": turns,
                   "segments": [{"id": sid, "speaker": spk} for sid, spk in seg_speakers.items()]}
            # Diagnose nur, WENN sie zustande kam (#275). Ein leerer Schluessel waere schlimmer
            # als keiner: er behauptete "gemessen, nichts gefunden", wo in Wahrheit der
            # Monkeypatch nicht griff. Bestehende Sidecars ohne den Schluessel bleiben gueltig —
            # dieselbe Regel wie bei `sprecher` (fehlt = "automatisch").
            if diagnose:
                doc["diagnose"] = diagnose
            paths.atomic_write(dpath, json.dumps(doc, ensure_ascii=False, indent=1))
            # Eigene Zeile statt eines Anhangs an „→ Diarisiere … …": dessen Regex in
            # jobPhases.ts endet auf `$`. Das ⏱-Praefix faengt dort keiner der Regexe —
            # unbekannte Zeilen ignoriert der Parser bewusst (Kommentar am Ende der Schleife).
            print(f"⏱ {base}: Diarisierung {dt:.0f}s", flush=True)
            n += 1
        # BEWUSST nicht auf ValueError geweitet (#190): ein UnicodeDecodeError landet eine
        # Zeile tiefer im Exception-Zweig und wird dort korrekt gemeldet — dieser Lauf
        # bricht also nicht ab. Geweitet faenge dieser Zweig auch jeden ValueError aus
        # `diarize.*` und beschriftete ihn als "Roh-JSON unlesbar", was er nicht ist.
        except json.JSONDecodeError as e:               # nur die Roh-JSON parst nicht
            print(f"diarize: SKIP {base} (Roh-JSON unlesbar: {e})", flush=True)
        except Exception as e:                          # pyannote/Token/GPU/HF-403 (erbt OSError!) — NIE den Lauf killen
            print(f"diarize: SKIP {base} ({type(e).__name__}: {e}) — Korrektur ohne Cluster", flush=True)
    # Anhang, kein Umbau: `/^diarize: \d+ Datei/` in jobPhases.ts hat keinen $-Anker.
    print(f"diarize: {n} Datei(en) diarisiert in {time.monotonic() - t_phase:.0f}s", flush=True)
    return n


def cmd_apply(project: str, base: str, force: bool = False) -> str:
    tdir = paths.transkripte_dir(project)
    epath = os.path.join(tdir, base + ".edit.json")
    if os.path.exists(epath) and not force:
        try:
            if _load(epath).get("human_edited"):
                print(f"apply: SKIP {base} (human_edited=true; --force zum Ueberschreiben)")
                return "skipped"
        except (OSError, ValueError) as e:     # ValueError deckt auch UnicodeDecodeError
            # Nicht lesbar heisst NICHT "keine Handarbeit" — dieselbe Regel wie in
            # `_is_human_edited`. Der naechste Schritt ERSETZT diese Datei; die Zeile
            # darunter loeschte bis #190 stillschweigend Handarbeit, sobald der Riegel
            # nicht mehr warf (gemessen). Beide Riegel muessen dieselbe Richtung haben,
            # sonst schuetzt der eine, was der andere gleich darauf ueberschreibt.
            print(f"apply: SKIP {base} ({os.path.basename(epath)} nicht lesbar: "
                  f"{type(e).__name__}: {e}; --force zum Ueberschreiben)")
            return "skipped"
    cpath = os.path.join(tdir, base + ".correction.json")
    if not os.path.exists(cpath):
        print(f"apply: FEHLT {base}.correction.json - erst Korrektur-Workflow laufen lassen")
        return "missing"
    raw = _load(os.path.join(tdir, base + ".json"))
    correction = _load(cpath)
    doc = apply_correction(raw, correction, base=base, project=project,
                           audio=_audio_name(project, base))
    # Dieselbe Sperre wie `app._pruefe_und_schreibe` (#160/PR #278). Der Editor prueft dort
    # den Dateistand und schreibt dann — dazwischen liegen ein `json.dumps` und ein
    # vollstaendiges `render_md`. Landet DIESER Schreibvorgang in genau dem Fenster, hat der
    # Vergleich schon zugestimmt und die frische Korrektur wird ueberbuegelt: der Schaden aus
    # #160 durch ein schmaleres Tor.
    #
    # **Eine Sperre wirkt nur, wenn ALLE Schreiber sie nehmen** (dieselbe Regel wie bei
    # `settings.save`) — deshalb steht sie hier und nicht nur im Server. Gesperrt wird auf
    # denselben Pfad, die `edit.json`. Der Abschnitt ist zwei Schreibvorgaenge lang und nimmt
    # keine weitere Sperre, `stale` bleibt also beim Standard (#207-Rechnung ohne Zuschlag).
    with sperre.datei(epath):
        # ZWEITE Pruefung, unter der Sperre — und das ist der Spiegel des Fensters oben
        # (CodeRabbit-CLI an PR #278). Die erste steht am Anfang der Funktion; dazwischen
        # liegen das Laden der Korrektur, `apply_correction` ueber ALLE Segmente und
        # `render_md` — auf einem langen Transkript hunderte Millisekunden. Der Editor
        # speichert 800 ms nach der letzten Tipppause: wer waehrend eines Korrekturlaufs
        # arbeitet, setzt `human_edited` genau in dieses Fenster, und der Schreibvorgang
        # darunter loeschte seine Handarbeit — mit `apply: … -> edit.json` als Erfolgsmeldung.
        #
        # Die erste Pruefung bleibt als billiger Ausstieg stehen: sie erspart im Normalfall
        # `apply_correction` und `render_md`, also genau die Arbeit, die das Fenster aufmacht.
        #
        # `_is_human_edited` statt der ausfuehrlichen Fassung oben: es traegt dieselbe
        # Fehlerrichtung (nicht lesbar ⇒ gilt als handbearbeitet) und meldet den unlesbaren
        # Fall selbst. Fehlende Datei ⇒ False, der Normalfall bleibt also still.
        if not force and _is_human_edited(epath):
            print(f"apply: SKIP {base} (waehrend des Laufs handbearbeitet; "
                  f"--force zum Ueberschreiben)")
            return "skipped"
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
        try:
            with open(p, encoding="utf-8") as fh:
                return fh.read().strip()
        except (OSError, ValueError) as e:
            # `kontext.md` schreibt der NUTZER von Hand — im Editor als ANSI gespeichert ist
            # sie mit Umlaut nicht als UTF-8 lesbar (#190-Klasse, hier sogar wahrscheinlicher
            # als bei einer von der App geschriebenen JSON). Der Aufruf steht in `cmd_run`
            # NACH diarize + prep: ein Wurf verwirft GPU-Minuten und den ganzen Lauf, statt
            # eine Datei zu ueberspringen. Also weiter ohne Kontext — aber laut, denn ohne
            # ihn faellt die Korrektur messbar schlechter aus.
            print(f"⚠ kontext.md nicht lesbar ({type(e).__name__}: {e}) — fahre ohne "
                  f"Projektkontext fort", flush=True)
    return ""


def _is_human_edited(epath: str) -> bool:
    """Steckt in dieser `edit.json` Handarbeit? Eine NICHT LESBARE gilt als handbearbeitet.

    Die Fehlerrichtung ist hier umgekehrt zu allen anderen Rueckfaellen dieses Moduls, und
    zwar gemessen: mit `False` korrigierte der Lauf die Datei, `cmd_apply` ersetzte sie, und
    am Ende stand `run: fertig — 1/1 korrigiert` — Erfolg gemeldet, Handarbeit weg, keine
    Zeile im Protokoll. `human_edited=true` IST die Zusage "eine Maschine fasst das nicht
    an"; wer sie nicht lesen kann, darf sie nicht ueberschreiben. Vor #190 warf das hier und
    der Catch-all in `one()` uebersprang die Datei — dieselbe Wirkung, nur als Fehler
    getarnt. `--force` bleibt der Weg darueber hinweg.

    Fehlt die Datei, gibt es nichts zu schuetzen (der Normalfall, deshalb schweigend).
    """
    try:
        return bool(_load(epath).get("human_edited"))
    except FileNotFoundError:
        return False
    except (OSError, ValueError) as e:     # ValueError deckt auch UnicodeDecodeError (#190)
        print(f"⚠ {os.path.basename(epath)} nicht lesbar ({type(e).__name__}: {e}) — gilt "
              f"als handbearbeitet, wird NICHT ueberschrieben (--force erzwingt es)",
              flush=True)
        return True


def _valid_correction(cpath: str) -> bool:
    """Erfolgsmass für 2b: geschriebene correction.json existiert, parst, hat Segmente."""
    try:
        segs = _load(cpath).get("segments")
    except (OSError, ValueError):     # ValueError deckt auch UnicodeDecodeError (#190)
        return False
    return isinstance(segs, list) and len(segs) > 0


def _claude_exe() -> str:
    exe = shutil.which("claude") or shutil.which("claude.cmd")
    if not exe:
        raise FileNotFoundError("claude CLI nicht auf PATH (Claude-Code-Abo nötig)")
    return exe


def _run_claude(prompt: str, workdir: str) -> None:
    """Headless claude -p; schreibt die Zieldatei selbst via Write-Tool. Erfolg wird an
    der geschriebenen Datei gemessen (nicht am Exitcode) — Fehler/Timeout nur loggen.

    Prompt kommt über stdin (nicht als argv): robust gegen .cmd-Shims/cmd.exe-Parsing
    mehrzeiliger Prompts und ohne Windows-Kommandozeilen-Längenlimit.

    `workdir` grenzt die auto-akzeptierten Schreibzugriffe (acceptEdits) ein und ist der
    transkripte-Ordner GENAU EINES Projekts — dort liegen alle Ein- und Ausgaben jedes
    Aufrufs. Vorher stand hier projekte_root: die Roh-Transkripte sind eine Trust-Boundary
    (Prompt-Injection über den Audioinhalt, z.B. aus einem URL-Import), und ein präpariertes
    Transkript konnte damit in die Transkripte JEDES anderen Projekts schreiben. Der eigene
    Quellcode lag schon vorher ausserhalb."""
    global _letzte_diagnose
    try:
        exe = _claude_exe()
    except FileNotFoundError as e:
        diag = llm.diagnose_fehler(str(e))
        _letzte_diagnose = diag
        print(f"  {e}", flush=True)
        print(f"  [diagnose] {diag['kategorie']}\t{diag['titel']}\t{diag['hinweis']}", flush=True)
        return
    # Ohne MCP-Server: 16,3s -> 7,7s Startup je Aufruf (gemessen). Die Korrektur braucht nur
    # Read/Write — und sie verarbeitet nicht vertrauenswürdigen Transkripttext, da haben die
    # persönlichen MCP-Server (Mail, Notion, …) ohnehin nichts verloren.
    # Modell aus den Einstellungen statt fest verdrahtet: wer sein Opus-Kontingent
    # aufgebraucht hat, soll die Korrektur auf sonnet weiterfahren koennen, statt bis zum
    # naechsten Fenster zu warten. Frisch gelesen wie ueberall (settings.load), damit ein
    # Wechsel im Browser ohne Server-Neustart greift.
    modell = settings.load()["model"] or CLAUDE_MODEL
    cmd = [exe, "-p", "--model", modell,
           "--permission-mode", "acceptEdits", "--allowedTools", "Read,Write",
           "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
           "--add-dir", workdir]
    try:
        # ponytail: subprocess.run-timeout killt nur den claude-Prozess, nicht dessen
        # Kind-Prozessbaum (MCP-Server) — für ein lokales Ein-Nutzer-Tool ok; falls je
        # relevant: claude in einem Windows-Job-Object starten und die Gruppe killen.
        with _claude_slots:      # globaler Deckel über alle parallelen Dateien UND Blöcke
            r = subprocess.run(cmd, cwd=workdir, input=prompt, capture_output=True,
                               text=True, encoding="utf-8", errors="replace", timeout=CLAUDE_TIMEOUT,
                               creationflags=_CREATE_NO_WINDOW)
        if r.returncode != 0:
            tail = ((r.stdout or "") + (r.stderr or "")).strip()[-500:]
            diag = llm.diagnose_fehler(tail)
            _letzte_diagnose = diag
            print(f"  claude exit {r.returncode}: {tail}", flush=True)
            print(f"  [diagnose] {diag['kategorie']}\t{diag['titel']}\t{diag['hinweis']}", flush=True)
    except subprocess.TimeoutExpired:
        diag = llm.diagnose_fehler(f"claude Timeout nach {CLAUDE_TIMEOUT}s")
        _letzte_diagnose = diag
        print(f"  claude Timeout nach {CLAUDE_TIMEOUT}s", flush=True)
        print(f"  [diagnose] {diag['kategorie']}\t{diag['titel']}\t{diag['hinweis']}", flush=True)


def _ask_llm(prompt: str, inputs: list, output: str) -> None:
    """Eine LLM-Runde, unabhaengig vom eingestellten Anbieter.

    Beim Claude-Abo schreibt `claude -p` die Zieldatei per Write-Tool selbst. Sonst — API-Key
    ODER Codex-Abo — gibt es keine Werkzeuge: die Eingaben wandern in den Prompt und die
    Antwort schreibt llm.py. Der Unterschied ist also nicht Abo gegen Key, sondern WER die
    Dateien anfasst; `llm.use_api()` beantwortet genau das.
    In beiden Faellen gilt: Erfolg wird an der geschriebenen Datei gemessen, ein Fehler wird
    nur geloggt — eine Datei darf den Batch nicht abbrechen."""
    global _letzte_diagnose
    if not llm.use_api():
        # Ein- und Ausgaben eines Aufrufs liegen IMMER im selben transkripte-Ordner (alle
        # Aufrufer bauen ihre Pfade aus paths.transkripte_dir) — daraus faellt die
        # Einengung ab, ohne das Projekt durch drei Funktionen zu reichen.
        _run_claude(prompt, os.path.dirname(output))
        return
    with _claude_slots:                      # derselbe Deckel wie im Abo-Weg
        try:
            llm.complete_to_file(prompt, inputs, output)
        except llm.LLMError as e:
            diag = llm.diagnose_fehler(e)
            _letzte_diagnose = diag
            print(f"  KI-Anbieter: {e}", flush=True)
            print(f"  [diagnose] {diag['kategorie']}\t{diag['titel']}\t{diag['hinweis']}", flush=True)


def _glossary_prompt(gpath: str, raw_files: list, context: str,
                     ziel: str = "lesbarem Standarddeutsch") -> str:
    files = "\n".join(raw_files)
    return f"""Du erstellst ein GEMEINSAMES Glossar, mit dem anschliessend mehrere Interview-Transkripte KONSISTENT korrigiert werden.

Projekt-Kontext: {context or _default_context(ziel, dialekt=False)}

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
                    id_range=None, known: str = "",
                    ziel: str = "lesbarem Standarddeutsch", dialekt: bool = True,
                    mehrsprachig: bool = False) -> str:
    block, scope = _scope(id_range, known)
    dialekt_hinweis = " (Schweizer „ss“)" if dialekt else ""
    # Die Mehrsprachig-Regel ersetzt die Normalisierungs-Anweisung, sie steht NICHT daneben.
    # Zuerst hing sie als achte Regel hinten dran — dann sagten Ueberschrift, Projekt-Kontext
    # und Regel 2 weiterhin "zu EINER Zielsprache normalisieren", und die Ausnahme kam erst
    # danach. Ein Prompt mit zwei sich widersprechenden Anweisungen ist genau die Form, an der
    # die [Musik]-Regel schon einmal haengengeblieben ist; deshalb ist hier JEDE der drei
    # Stellen sprachbewusst, statt eine Gegenregel anzuhaengen.
    einleitung = ("mehrere Sprachen — jede Passage bleibt in ihrer eigenen" if mehrsprachig
                  else "oft Schweizerdeutsch -> lesbares Standarddeutsch" if dialekt
                  else f"in {ziel}")
    # Der einsprachige Zweig behaelt die URSPRUENGLICHE Wortstellung inklusive fuehrendem
    # Komma — die Schweizerdeutsch-Pipeline soll byte-identisch bleiben (Constraint-Test).
    norm_satz = (f". {sprachen.ZIEL_MEHRSPRACHIG}" if mehrsprachig
                 else f", zu {ziel} normalisieren{dialekt_hinweis}.")
    return f"""Du korrigierst EIN Interview-Transkript SEGMENT FÜR SEGMENT ({einleitung}) und labelst die Sprecher.

Projekt-Kontext: {context or _default_context(ziel, dialekt, mehrsprachig)}
{block}
1) Lies die Rohsegmente vollständig (Read-Tool) aus:
{tagged_path}
   Jede Zeile: "[<id>] (Sprecher N) <text>" — das Präfix (Sprecher N) ist die AKUSTISCH erkannte Sprecher-Gruppe (Diarisierung); fehlt es, gibt es keine akustische Info. Unsichere Wörter sind inline als [[Wort|Wahrscheinlichkeit]] markiert (niedrige Whisper-Konfidenz) — dort besonders genau hinsehen.

Gemeinsames Glossar (für konsistente Schreibweisen — nutze es, ergänze nichts Erfundenes):
{gjson or "(keins)"}

2) KORRIGIEREN: klare ASR-Fehler mit Kontext + Glossar verbessern{norm_satz} BLEIB TREU: nichts erfinden, den Sinn nicht verändern, nicht über das Nötige hinaus glätten (Füllwörter wie „äh“/„ähm“ dürfen dezent weg). Entferne die [[...]]-Markierungen im Ausgabetext.
3) PRO SEGMENT: gib für JEDE Segment-ID {scope} GENAU EINEN Eintrag {{id, speaker, text}} zurück — keine ID auslassen, keine Segmente zusammenfassen (die Redebeitrags-Bündelung passiert später).
4) SPRECHER: Das akustische (Sprecher N)-Präfix sagt, WANN die Stimme wechselt — vergib pro Cluster GENAU EINEN konsistenten Namen: meist „Interviewer“ (stellt Fragen) und die befragte Person (Name/Betrieb falls genannt, sonst „Befragte Person“). {CLUSTER_REGEL} Eine Cluster-Grenze nur überschreiben, wenn sie offensichtlich falsch ist (z.B. ein einzelnes Rückkanal-Wort). Fehlt das Präfix, ordne nach Inhalt zu (wie bisher). Gib JEDEM Segment einen Sprecher.
5) UNSICHER: wirklich unklare Stellen NICHT raten — nah am Original belassen und unter annotations vermerken.
6) MUSIK/GESANG: Whisper "hört" in gesungenen Passagen sicher klingenden Unsinn (typisch: dieselbe kurze Zeile mehrfach hintereinander, fremdsprachig wirkende Wortfetzen, Text der zum Gespräch nicht passt). Bei GESUNGENEN Stellen und bei Segmenten ohne verständliche Sprache (Musik, Jubel, Applaus) schreibe als text exakt „[Musik]“ — nicht raten, was gesungen wurde. GESPROCHENE Bühnenansagen sind KEINE Musik, die bleiben Text.
7) ASR-ARTEFAKTE & HALLUZINATIONSSCHLEIFEN: Segmente, deren Text nachweislich nicht aus dem Ton stammt (Untertitel-Floskeln wie „ARD Text im Auftrag von Funk“, „Untertitelung des ZDF“, „Vielen Dank fürs Zuschauen“ sowie endlose ASR-Wiederholungsschleifen desselben Satzes über Musik/Stille), bekommen einen LEEREN text (""). In summary fasst du AUSSCHLIESSLICH den echten Gesprächsinhalt zusammen — beschreibe dort KEINE ASR-Fehler, keine leeren Blöcke und keine Halluzinationsschleifen. Regel 6 und 7 gelten nur, wenn du dir sicher bist — im Zweifel Text belassen und unter annotations vermerken.

Schreibe das Ergebnis mit dem Write-Tool als JSON nach GENAU diesem Pfad:
{cpath}

Exaktes Schema (Pflicht — sonst bleibt der Text auf dem Rohstand):
{{
  "base": "{base}",
  "context": "1-2 Sätze zum Gespräch",
  "speakers": ["Interviewer", "..."],
  "segments": [{{"id": <zahl>, "speaker": "...", "text": "..."}}],
  "annotations": ["..."],
  "summary": "3-5 Sätze: worum es im Gespräch INHALTLICH geht (nur echter Inhalt, kein Bericht über Korrekturen oder ASR-Fehler)"
}}
Gib ausser der geschriebenen Datei nichts weiter aus."""


def _verify_prompt(base: str, tagged_path: str, cpath: str, context: str, id_range=None,
                   known: str = "",
                   ziel: str = "lesbarem Standarddeutsch", dialekt: bool = True,
                   mehrsprachig: bool = False) -> str:
    # `known` MUSS mit: der Treue-Pass prueft ausdruecklich die Sprecherzuordnung und schreibt
    # die Datei neu. Ohne die schon vergebenen Namen taufte er Block 2..n um und haette den
    # Anker aus Block 1 wieder zunichte gemacht.
    block, scope = _scope(id_range, known)
    # Eigener Text, NICHT ZIEL_MEHRSPRACHIG: hier geht es nicht darum, was zu tun ist, sondern
    # dass eine Fremdsprache KEIN Befund ist. Nach dem Muster der MUSIK-Zeile darunter gebaut —
    # dieselbe Falle, derselbe Satzbau. Und ein eigenes Flag statt einer `ziel`-Phrase, weil
    # `ziel` diesen Prompt nur ueber _default_context erreicht: der greift nur OHNE kontext.md,
    # ein Projekt mit Kontextdatei saehe die Regel also nie.
    mehr_regel = ("\n- FREMDSPRACHE ist eine ERLAUBTE Entscheidung, KEINE Untreue: Eine Passage in "
                  "einer anderen Sprache als der Rest ist NICHT zurückzuübersetzen. Prüfe nur, "
                  "ob sie zum Roh passt." if mehrsprachig else "")
    return f"""Du prüfst eine bereits erstellte SEGMENT-GENAUE Korrektur auf TREUE gegen das Rohtranskript (TREUE-CHECK) und schreibst die geprüfte Fassung zurück.

Projekt-Kontext: {context or _default_context(ziel, dialekt)}
{block}
1) Lies das ROH vollständig (Read-Tool) aus:
{tagged_path}
   Jede Zeile: "[<id>] (Sprecher N) <text>" — das (Sprecher N)-Präfix ist die akustische Sprecher-Gruppe (falls vorhanden); unsichere Wörter inline als [[Wort|Wahrscheinlichkeit]] markiert.
2) Lies die zu prüfende Korrektur (Read-Tool) aus:
{cpath}

Prüfe kritisch gegen das ROH — konservativ, im Zweifel näher am Original:
- HALLUZINATION/DRIFT: Inhalt hinzugefügt/weggelassen/im Sinn verändert, der nicht im Roh steht? Übermässiges Umschreiben? → näher ans Original zurück.
- MUSIK/ARTEFAKTE/SCHLEIFEN sind ERLAUBTE Entscheidungen, KEINE Auslassung: „[Musik]“ steht für eine gesungene oder sprachlose Stelle, ein leerer text ("") für ein reines ASR-Artefakt oder eine ASR-Wiederholungsschleife über Musik/Stille. Beides NICHT zurückdrehen — nur prüfen, ob es zutrifft: gesprochene Bühnenansagen gehören zurück in Text, und umgekehrt gehört sicher klingender Unsinn über einer gesungenen Passage (dieselbe kurze Zeile mehrfach hintereinander, Wortfetzen ohne Bezug zum Gespräch) auf „[Musik]“.{mehr_regel}
- VOLLSTÄNDIGKEIT: für JEDE Roh-Segment-ID {scope} genau ein Eintrag? Fehlende ergänzen (Text nah am Roh), zusammengefasste auftrennen.
- SPRECHER: konsistent pro akustischem (Sprecher N)-Cluster und plausibel (Interviewer stellt Fragen; Antworten korrekt zugeordnet)? {CLUSTER_REGEL} Fehlzuordnungen korrigieren — einzelne Segmente ebenso wie einen durchgehend falsch benannten Cluster; zwei Cluster mit demselben Namen aber NICHT auseinanderziehen.
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
  "summary": "3-5 Sätze: worum es im Gespräch INHALTLICH geht (nur echter Inhalt). Übernimm die vorhandene Zusammenfassung, wenn sie stimmt; schreibe hier NICHT, was du geändert hast",
  "verification": "was du geändert hast, oder 'keine Änderung'"
}}
Ändere NUR, was wirklich nötig ist; unproblematische Segmente unverändert übernehmen. Gib ausser der geschriebenen Datei nichts weiter aus."""


def _light_prompt(base: str, tagged_path: str, cpath: str, context: str,
                  ziel: str = "lesbarem Standarddeutsch", dialekt: bool = True,
                  mehrsprachig: bool = False) -> str:
    """Leichte Korrektur: EIN LLM-Lauf, kein Glossar, kein Treue-Pass.
    Korrigiert nur offensichtliche ASR-Fehler + Eigennamen, labelt Sprecher,
    schreibt eine Inhalts-Zusammenfassung. Keine Dialekt-Glättung.

    Braucht die Mehrsprachig-Regel genauso wie _correct_prompt: Schritt 2 schreibt Text um
    und nennt dabei `ziel` als Sprache — ohne die Regel uebersetzt eine gemischte Datei bei
    Tiefe 'leicht' nach Standarddeutsch. Derselbe Fehler ueber einen anderen Weg."""
    # Wie in _correct_prompt: die Regel ERSETZT die Sprachangabe in Schritt 2, sie steht nicht
    # daneben. "(Sprache: lesbarem Standarddeutsch)" neben "belasse jede Passage in ihrer
    # eigenen" waeren zwei Anweisungen, die einander widersprechen.
    norm_satz = (f". {sprachen.ZIEL_MEHRSPRACHIG}" if mehrsprachig else f" (Sprache: {ziel}).")
    return f"""Du bearbeitest EIN Transkript in EINEM Lauf (leichte Korrektur) und labelst die Sprecher.

Projekt-Kontext: {context or _default_context(ziel, dialekt, mehrsprachig)}
1) Lies die Rohsegmente (Read-Tool): {tagged_path}
2) KORRIGIERE NUR offensichtliche ASR-Fehler und Eigennamen{norm_satz} KEIN Umschreiben, keine Dialekt-Glättung, keine Normalisierung. Entferne [[...]]-Markierungen.
3) SPRECHER: vergib pro (Sprecher N)-Cluster einen konsistenten Namen (meist „Interviewer" und die befragte Person). {CLUSTER_REGEL} Gib JEDEM Segment einen speaker.
4) SUMMARY: eine Inhalts-Zusammenfassung (3-5 Sätze; nur echter Gesprächsinhalt, keine Berichte über ASR-Fehler oder leere Abschnitte).

Schema (Write-Tool nach {cpath}):
{{"base":"{base}","context":"1-2 Sätze","speakers":["…"],
 "segments":[{{"id":<zahl>,"speaker":"…","text":"…"}}],
 "annotations":["…"],"summary":"3-5 Sätze Inhalt"}}
Gib ausser der Datei nichts aus."""


def _summary_prompt(base: str, tagged_path: str, cpath: str, context: str,
                    ziel: str = "lesbarem Standarddeutsch", dialekt: bool = True) -> str:
    """Nur Zusammenfassung + Sprecher-Namen, EIN LLM-Lauf. Den Segment-Inhalt lässt
    der Prompt UNANGETASTET — das Schema verlangt pro Segment nur {id, speaker} (kein
    text-Feld), womit apply_correction den Roh-Text behaelt (CLAUDE.md-Regel)."""
    return f"""Du bearbeitest EIN Transkript NUR fuer Zusammenfassung + Sprecher-Namen. Den Inhalt lässt du UNANGETASTET.

Projekt-Kontext: {context or _default_context(ziel, dialekt)}
1) Lies die Rohsegmente (Read-Tool): {tagged_path}
2) SPRECHER: vergib pro (Sprecher N)-Cluster einen konsistenten Namen. {CLUSTER_REGEL} JEDES Segment bekommt einen speaker — KEIN Text-Feld (der Roh-Inhalt bleibt unveraendert, uebernimm nur id und speaker).
3) SUMMARY: eine Inhalts-Zusammenfassung (3-5 Sätze; nur echter Gesprächsinhalt, keine Berichte über ASR-Fehler oder leere Abschnitte) in {ziel or 'der Originalsprache'}.

Schema (Write-Tool nach {cpath}):
{{"base":"{base}","context":"1-2 Sätze","speakers":["…"],
 "segments":[{{"id":<zahl>,"speaker":"…"}}],
 "annotations":["…"],"summary":"3-5 Sätze Inhalt"}}
Gib ausser der Datei nichts aus."""


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
        # ziel="" + dialekt=False: das Glossar ist sprachneutral (Spec F2) -- sonst
        # leaked der Default "lesbarem Standarddeutsch" in jedes Projekt, auch Englisches.
        _ask_llm(_glossary_prompt(gpath, raw_files, context, ziel=""), raw_files, gpath)
    try:
        g = _load(gpath)
    except (OSError, ValueError):     # ValueError deckt auch UnicodeDecodeError (#190)
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


_META_PATTERNS = [
    re.compile(r"\b(halluzinations[- ]?schleife|asr[- ]?halluzination|wiederholungsschleife des satzes)\b", re.I),
    re.compile(r"\b(in diesem block|dieser abschnitt|dieser teil).*(keinen verwertbaren inhalt|keinen gesprächsinhalt|keinen inhalt)\b", re.I),
    re.compile(r"\b(tonspur|transkription).*(keinen verwertbaren inhalt|halluzination)\b", re.I),
]


def _ist_reiner_halluzinations_kommentar(text: str) -> bool:
    return any(p.search(text) for p in _META_PATTERNS)


def bereinige_summary(text: str) -> str:
    """Entfernt Meta-Kommentare über leere Blöcke oder Halluzinationsschleifen aus der Zusammenfassung."""
    if not text:
        return ""
    saetze = [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]
    saetze_bereinigt = [s for s in saetze if not _ist_reiner_halluzinations_kommentar(s)]
    return " ".join(saetze_bereinigt).strip()


def _merge_parts(docs: list, base: str) -> dict:
    """Block-Korrekturen zu EINER correction.json vereinen (IDs aufsteigend, Sprecher-Liste
    vereinigt, Anmerkungen aneinandergehängt).

    `summary` und `verification` werden ANEINANDERGEHÄNGT, nicht vom ersten Block genommen:
    jeder Block sieht nur seinen eigenen ID-Bereich, und „erster nicht-leerer“ hiesse bei einer
    390-Segment-Datei, dass die Zusammenfassung des ganzen Gesprächs in Wahrheit das erste
    Drittel beschreibt — ohne dass man es der Datei ansieht.
    """
    segs, speakers, ann = [], [], []
    for d in docs:
        segs.extend(s for s in (d.get("segments") or []) if isinstance(s, dict))
        for name in (d.get("speakers") or []):
            if name not in speakers:
                speakers.append(name)
        ann.extend(str(a).strip() for a in (d.get("annotations") or []) if a is not None and str(a).strip())
    segs.sort(key=lambda s: s.get("id") if isinstance(s.get("id"), int) else 0)

    def verbinde(feld):
        eintraege = []
        for d in docs:
            val = str(d.get(feld) or "").strip()
            if not val:
                continue
            if feld == "summary":
                val = bereinige_summary(val)
                if not val:
                    continue
            if val not in eintraege:
                eintraege.append(val)
        return " ".join(eintraege)

    return {"base": base,
            "context": next((d.get("context") for d in docs if d.get("context")), ""),
            "speakers": speakers, "segments": segs, "annotations": ann,
            "summary": verbinde("summary"), "verification": verbinde("verification")}


def _correct_one(base: str, tagged: str, target: str, gjson: str, context: str, verify: bool,
                 id_range=None, known: str = "", part: str = "",
                 ziel: str = "lesbarem Standarddeutsch", dialekt: bool = True,
                 mehrsprachig: bool = False) -> None:
    """Ein claude-Korrekturlauf (+ optionaler Treue-Pass) mit Ziel `target` — ganze Datei
    oder ein ID-Block. Die Fortschritts-Zeilen sind Vertrag mit dem Frontend-Job-Parser
    (webtool/frontend/src/lib/jobPhases.ts) — Format nicht ändern. `part` (z.B. ' · Block 2/3')
    gehört in JEDE Zeile: bei parallelen Läufen verschränken sich die Ausgaben, eine Zeile
    ohne Basisnamen liesse sich keinem Lauf mehr zuordnen."""
    print(f"→ Korrigiere {base}{part} …", flush=True)
    t0 = time.monotonic()
    _ask_llm(_correct_prompt(base, tagged, target, gjson, context, id_range, known, ziel, dialekt,
                             mehrsprachig),
             [tagged], target)
    # Getrennt gemessen, weil der Treue-Pass die Aufrufe je Block VERDOPPELT: eine Summe
    # liesse offen, ob eine Verkuerzung bei den Slots oder beim Verify zu holen waere.
    # Die Wartezeit auf einen freien `_claude_slots`-Platz steckt bewusst MIT drin — genau
    # sie ist der Effekt, den ein hoeherer Deckel wegnehmen soll.
    dt_korrektur = time.monotonic() - t0
    dt_verify = 0.0
    if verify and _valid_correction(target):    # Treue-Pass nur auf eine GÜLTIGE Erst-Korrektur
        print(f"→ Verifiziere {base}{part} (Treue gegen Roh) …", flush=True)
        t0 = time.monotonic()
        good = _load(target)                    # Snapshot: darf nicht durch einen kaputten Verify verloren gehen
        # Der Treue-Pass prueft die Korrektur GEGEN das Roh -> ohne API-Werkzeuge braucht er beide Dateien.
        _ask_llm(_verify_prompt(base, tagged, target, context, id_range, known, ziel, dialekt,
                                mehrsprachig),
                 [tagged, target], target)
        if not _valid_correction(target):       # Verify hat die gültige Korrektur zerstört -> zurückrollen
            paths.atomic_write(target, json.dumps(good, ensure_ascii=False, indent=1))
            print(f"⚠ Verifikation ungültig — behalte unverifizierte {base}.correction.json", flush=True)
        dt_verify = time.monotonic() - t0
    wie = f", Verify {dt_verify:.0f}s" if dt_verify else ""
    print(f"⏱ {base}{part}: Korrektur {dt_korrektur:.0f}s{wie}", flush=True)


def _correct_file(project: str, base: str, gjson: str, context: str, verify: bool,
                  force: bool = False,
                  ziel: str = "lesbarem Standarddeutsch", dialekt: bool = True,
                  mehrsprachig: bool = False) -> None:
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
                                                    # womit kein Block je „neuer“ wäre und der Resume tot.
    if len(ids) <= CHUNK_SEGMENTS:
        _correct_one(base, tagged, cpath, gjson, context, verify, ziel=ziel, dialekt=dialekt,
                     mehrsprachig=mehrsprachig)
        return
    chunks = [ids[i:i + CHUNK_SEGMENTS] for i in range(0, len(ids), CHUNK_SEGMENTS)]
    clusters = _load_diar_clusters(tdir, base) if diarize_enabled() else {}
    parts = [os.path.abspath(os.path.join(tdir, f"{base}.part{i}.correction.json"))
             for i in range(1, len(chunks) + 1)]
    print(f"  {base}: {len(ids)} Segmente → {len(chunks)} Blöcke à max. {CHUNK_SEGMENTS}", flush=True)

    def block(i: int, known: str):
        chunk, ppath = chunks[i - 1], parts[i - 1]
        label = f" · Block {i}/{len(chunks)}"
        # `force` MUSS bis hierher durchgereicht werden. Ohne das galt --force nur der
        # zusammengeführten correction.json, während liegengebliebene Teil-Dateien weiter
        # wiederverwendet wurden — ein Lauf nach einer Prompt-Änderung übernahm damit still
        # Blöcke, die noch nach der ALTEN Regel entstanden waren. Genau so ist die
        # Musik-Markierung beim ersten Test nur in Block 1 gelandet.
        if not force and _valid_correction(ppath) and os.path.getmtime(ppath) >= os.path.getmtime(raw_json):
            print(f"  ↷ {base}{label} schon vorhanden", flush=True)
        else:
            _correct_one(base, tagged, ppath, gjson, context, verify,
                         id_range=(chunk[0], chunk[-1]), known=known, part=label,
                         ziel=ziel, dialekt=dialekt, mehrsprachig=mehrsprachig)
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


def _light_correct_file(project: str, base: str, ziel: str, dialekt: bool,
                        context: str, mehrsprachig: bool = False) -> None:
    """Leichte Korrektur fuer EINE Datei -> <base>.correction.json (EIN LLM-Aufruf,
    kein Glossar, kein Treue-Pass). Schema wie die Voll-Korrektur (mit text).

    `mehrsprachig` steht am ENDE der Signatur, nicht zwischen `dialekt` und `context`:
    dort haette ein zweiter, positional rufender Aufrufer still `context` an das Flag
    gebunden. Ein neuer Parameter gehoert ans Ende oder ist keyword-only."""
    tdir = paths.transkripte_dir(project)
    target = os.path.abspath(os.path.join(tdir, base + ".correction.json"))
    tagged = os.path.abspath(os.path.join(tdir, base + ".tagged.txt"))
    print(f"→ Leichte Korrektur {base} …", flush=True)
    _ask_llm(_light_prompt(base, tagged, target, context, ziel, dialekt, mehrsprachig),
             [tagged], target)


def _summary_only_file(project: str, base: str, ziel: str, context: str,
                       dialekt: bool = True) -> None:
    """Nur Zusammenfassung + Sprecher -> <base>.correction.json (EIN LLM-Aufruf).
    Das Schema verlangt {id, speaker} OHNE text-Schluessel, sodass apply_correction
    den Roh-Text jedes Segments unveraendert laesst."""
    tdir = paths.transkripte_dir(project)
    target = os.path.abspath(os.path.join(tdir, base + ".correction.json"))
    tagged = os.path.abspath(os.path.join(tdir, base + ".tagged.txt"))
    print(f"→ Nur Zusammenfassung {base} …", flush=True)
    _ask_llm(_summary_prompt(base, tagged, target, context, ziel, dialekt), [tagged], target)


def cmd_run(project: str, base: str = None, force: bool = False, verify: bool = True) -> int:
    global _letzte_diagnose
    _letzte_diagnose = None
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
    # Wirkungsbereich melden, bevor die erste lange Arbeit (Diarisierung) beginnt — jobs.py
    # gibt danach alle uebrigen Aufnahmen zum Loeschen/Umbenennen frei (Issue #80).
    print("[scope] " + "\t".join(all_bases), flush=True)
    print(f"run: {len(all_bases)} Datei(en) in Projekt {project!r}", flush=True)
    # Phasenuhren. Ohne sie war nur die Transkription vermessen (transcribe.py druckt `dt`
    # je Datei) — wie sich die Wandzeit auf Diarisieren/Vorbereiten/Glossar/Korrigieren
    # verteilt, war Vermutung. Der Deckel steht mit in der Zeile: zwei Laeufe sind sonst
    # nicht vergleichbar, und genau das ist der Zweck der Messung.
    t_start = time.monotonic()
    cmd_diarize(project, all_bases)                    # -> <base>.diar.json (best-effort, GPU); scoped auf all_bases
    t_diar = time.monotonic()
    cmd_prep(project)                                  # -> <base>.tagged.txt (Cluster-Präfix falls diarisiert)
    t_prep = time.monotonic()
    from . import projekt as _pj
    context = _context(project)
    # Glossar nur bauen, wenn mind. eine Datei im Voll-Modus laeuft -- leicht/zusammenfassung
    # sind Einzeldatei-Laeufe ohne korpus-weites Glossar (spart den Glossar-Aufruf).
    hat_voll = any(_pj.tiefe_effektiv(project, b) in ("voll", "voll_dialekt") for b in all_bases)
    gjson = _glossary(project, context) if hat_voll else ""
    t_gloss = time.monotonic()

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
                # Tiefe pro Datei: voll-Dateien laufen wie bisher (Glossar + Verify),
                # leicht/zusammenfassung sind einzelne LLM-Aufrufe ohne Treue-Pass.
                tiefe = _pj.tiefe_effektiv(project, b)
                ziel, dialekt, mehr = _ziel_dialekt(project, b)
                if tiefe in ("voll", "voll_dialekt"):
                    _correct_file(project, b, gjson, context, verify, force,
                                  ziel=ziel, dialekt=dialekt, mehrsprachig=mehr)
                elif tiefe == "leicht":
                    _light_correct_file(project, b, ziel, dialekt, context, mehrsprachig=mehr)
                else:  # zusammenfassung
                    _summary_only_file(project, b, ziel, context, dialekt)
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
    t_ende = time.monotonic()
    print(f"run: fertig — {done}/{len(all_bases)} Datei(en) korrigiert", flush=True)
    print(f"⏱ Phasen: diarisieren {t_diar - t_start:.0f}s · vorbereiten {t_prep - t_diar:.0f}s · "
          f"glossar {t_gloss - t_prep:.0f}s · korrigieren {t_ende - t_gloss:.0f}s · "
          f"gesamt {t_ende - t_start:.0f}s (parallel={CLAUDE_PARALLEL})", flush=True)
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
        # sonst wäre der Job „done“ trotz Totalausfall (z.B. claude fehlt auf PATH). Scope = eine
        # Datei (Per-Datei-Lauf) oder alle; „nichts zu tun“ (human_edited ohne --force / keine bzw.
        # unbekannte Datei) ist kein Fehler.
        tdir = paths.transkripte_dir(args.project)
        present = bases(args.project)
        scope = [args.base] if args.base else present
        attempted = sum(1 for b in scope if b in present
                        and (args.force or not _is_human_edited(os.path.join(tdir, b + ".edit.json"))))
        if attempted and not done:
            # Anbieterneutral: beim API-Weg heisst der Anbieter vielleicht OpenAI, und wer nur
            # die letzte Zeile liest, sucht sonst bei claude. Der echte Grund steht als
            # "KI-Anbieter: …" bzw. "[diagnose] …" weiter oben — hier direkt benennen.
            grund_text = (f"{_letzte_diagnose['titel']} · {_letzte_diagnose['hinweis']}"
                          if _letzte_diagnose
                          else "KI-Anbieter nicht erreichbar oder ohne Ausgabe — siehe die Zeilen oben")
            print(f"run: FEHLER — 0 von {attempted} versuchten Datei(en) korrigiert "
                  f"({grund_text})",
                  flush=True)
            raise SystemExit(1)
    else:
        paths.safe_name(args.base)
        cmd_apply(args.project, args.base, args.force)


if __name__ == "__main__":
    main()
