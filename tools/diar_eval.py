"""Messwerkzeug fuer die Sprechertrennung — freeze / run / vergleich.

KEIN Teil des Produkts: der Server importiert das hier nie. Es liest Marcus' echtes Material
und schreibt AUSSCHLIESSLICH nach eval/ (gitignoriert) — insbesondere ruft es
`diarize.diarize_file` direkt und NIE `correct.cmd_diarize`, das Sidecars in echte Projekte
schreiben wuerde.

Drei Zahlen je Datei, ihre Wahl ist begruendet in
docs/superpowers/specs/2026-08-17-transkribor-diarisierung-verbessern-design.md:
  Sprecherzahl  — die Zaehlung (laut #264 der einzige Knopf, der exakt trifft)
  V-Measure     — die Trennung, symmetrisch gegen Ueber- und Unterclustering
  Fehlerquote   — zeitgewichtet, das was der Nutzer merkt

Die Fehlerquote ist KEIN DER: es fehlen der VAD- und der Overlap-Term, und die Aufloesung ist
das Whisper-Segment statt des Rahmens. Sie wird deshalb nirgends so genannt. Die Aufloesung ist
Absicht — sie ist die Grenze, an der das Ergebnis den Nutzer erreicht.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _gemeinsam(vorhersage: dict, referenz: dict) -> list:
    """IDs, die BEIDE Seiten kennen. Einseitige fallen aus der Rechnung — sonst misst man die
    Vollstaendigkeit der Referenz statt die Guete des Laufs."""
    return sorted(i for i in referenz if i in vorhersage and referenz[i])


def sprecherzahl(zuordnung: dict) -> int:
    return len({v for v in zuordnung.values() if v})


def v_measure(vorhersage: dict, referenz: dict) -> tuple:
    """(Homogenitaet, Vollstaendigkeit, V-Measure). Alle drei einzeln, weil sie verschiedene
    Fehler benennen: niedrige Homogenitaet = Cluster mischt Personen, niedrige
    Vollstaendigkeit = eine Person auf mehrere Cluster verteilt (genau #267)."""
    from sklearn.metrics import homogeneity_completeness_v_measure
    ids = _gemeinsam(vorhersage, referenz)
    if not ids:
        return (0.0, 0.0, 0.0)
    return tuple(homogeneity_completeness_v_measure([referenz[i] for i in ids],
                                                    [vorhersage[i] for i in ids]))


def fehlerquote(vorhersage: dict, referenz: dict, dauer: dict) -> float:
    """Anteil der Redezeit, die einem falschen Sprecher zugeordnet wurde (0.0 = perfekt).

    Die beste Cluster->Sprecher-Zuordnung wird ueber die ungarische Methode auf der
    ZEITgewichteten Kontingenztabelle bestimmt: Cluster-Etiketten sind willkuerlich, verglichen
    wird die Partition. Gewichtet wird nach Dauer, nicht nach Segmentzahl — ein falsch
    zugeordneter 30-Sekunden-Block wiegt schwerer als ein 'Mhm'.
    """
    import numpy as np
    from scipy.optimize import linear_sum_assignment
    ids = _gemeinsam(vorhersage, referenz)
    gesamt = sum(dauer.get(i, 0.0) for i in ids)
    if not ids or gesamt <= 0:
        # NICHT 0.0 — das hiesse „fehlerfrei" und liesse einen Lauf, der gar nichts vergleichen
        # konnte, die Abnahme lautlos bestehen. `nan` besteht keinen Groessenvergleich.
        return float("nan")
    cs = sorted({vorhersage[i] for i in ids})
    ns = sorted({referenz[i] for i in ids})
    m = np.zeros((len(cs), len(ns)))
    ci = {c: k for k, c in enumerate(cs)}
    ni = {n: k for k, n in enumerate(ns)}
    for i in ids:
        m[ci[vorhersage[i]], ni[referenz[i]]] += dauer.get(i, 0.0)
    zeile, spalte = linear_sum_assignment(-m)
    return 1.0 - float(m[zeile, spalte].sum()) / gesamt


def cmd_freeze(args) -> int:
    """Die AUSDRUECKLICH benannten, handkorrigierten edit.json -> eval/referenz.json.

    Das Einfrieren ist nicht Komfort: ohne es wandert das Ziel bei jeder spaeteren Korrektur
    mit, und zwei Messlaeufe waeren nicht vergleichbar.

    **Die Liste ist Pflicht, kein Komfort.** Ein blosser `human_edited`-Filter naehme jede
    Datei, die je im Editor gespeichert wurde — und `human_edited=true` setzt `save_file` bei
    JEDEM PUT, der Editor speichert 800 ms nach jeder Aenderung von selbst. Die Flagge sagt
    „ein Mensch hat gespeichert", NICHT „ein Mensch hat die Sprecherzuordnung geprueft". Genau
    an diesem Unterschied haengt der ganze Plan (Spec 1.4). Im Bestand liegen bereits drei
    handbearbeitete Dateien AUSSERHALB des Referenzsatzes; ungefiltert waeren sie mitgekommen,
    ohne je unter der Anweisung „einzelne Namen, nie ein Sammel-Etikett" durchgesehen worden
    zu sein — der Fehler aus Spec 1.3d ueber einen neuen Weg zurueck.

    `human_edited` wird trotzdem geprueft, aber als NOTWENDIGE Bedingung: fehlt sie bei einer
    gelisteten Datei, hat Marcus sie schlicht noch nicht bearbeitet, und das ist ein Abbruch
    und keine stille Auslassung.
    """
    with open(args.liste, encoding="utf-8") as f:
        gewuenscht = [z.strip() for z in f if z.strip() and not z.startswith("#")]
    dateien, fehlend = {}, []
    for schluessel in gewuenscht:
        proj, base = schluessel.rsplit("/", 1)
        pfad = os.path.join(args.projekte, proj, "transkripte", base + ".edit.json")
        try:
            with open(pfad, encoding="utf-8") as f:
                ed = json.load(f)
        except (OSError, ValueError) as e:        # ValueError deckt auch UnicodeDecodeError
            fehlend.append(f"{schluessel} ({type(e).__name__})")
            continue
        if not ed.get("human_edited"):
            fehlend.append(f"{schluessel} (noch nicht handkorrigiert)")
            continue
        segmente = [{"id": s.get("id"), "start": s.get("start"), "end": s.get("end"),
                     "sprecher": s.get("speaker")}
                    for s in ed.get("segments", []) if s.get("speaker")]
        if not segmente:
            fehlend.append(f"{schluessel} (keine Sprecher)")
            continue
        namen = sorted({s["sprecher"] for s in segmente})
        dateien[schluessel] = {"projekt": proj, "base": base, "sprecher_wahr": len(namen),
                               "segmente": segmente}
        # Die NAMEN mitdrucken, nicht nur die Anzahl: ein Sammel-Etikett („Team Ikotec")
        # faellt genau hier auf und nirgends sonst — die Anzahl saehe unauffaellig aus.
        print(f"  {schluessel}: {len(segmente)} Segmente, {len(namen)} Sprecher — "
              + ", ".join(namen))
    if fehlend:
        print("\nFEHLT:\n  " + "\n  ".join(fehlend))
        print("\nAbbruch: ein unvollstaendiger Referenzsatz wuerde als Nullpunkt eingefroren "
              "und alle spaeteren Vergleiche verschieben.")
        return 1
    ziel = _unter_eval(args.ziel)         # Schreibpfad-Wache, s. dort
    if os.path.dirname(ziel):             # `--ziel referenz.json` -> dirname "" -> makedirs wirft
        os.makedirs(os.path.dirname(ziel), exist_ok=True)
    with open(ziel, "w", encoding="utf-8") as f:
        json.dump({"projekte": args.projekte, "dateien": dateien}, f, indent=1,
                  ensure_ascii=False)
    print(f"\n{len(dateien)} Datei(en) -> {args.ziel}")
    return 0


def cmd_run(args) -> int:
    """Diarisiert den Referenzsatz mit einer Konfiguration und schreibt die drei Zahlen.

    `--config` zeigt auf eine alternative pyannote-config.yaml (fuer Block C: getauschte
    Einbettung, andere Clustering-Parameter). Umgehaengt wird ueber `diarize.DIAR_MODEL` plus
    Ruecksetzen des Pipeline-Singletons — ein Eingriff, den sich nur dieses Werkzeug erlauben
    darf, weil es kein Produktionscode ist.

    `--sprecher-aus-referenz` gibt pyannote die WAHRE Sprecherzahl vor. Das misst nicht die
    Pipeline, sondern beantwortet die in der Spec offengebliebene Frage (1.3a): waere die
    Trennung gut, wenn die Zaehlung stimmte?
    """
    from webtool import diarize
    with open(args.referenz, encoding="utf-8") as f:
        ref = json.load(f)
    if args.config:
        diarize.DIAR_MODEL = os.path.abspath(args.config)
        diarize._PIPELINE = None
    wurzel = args.projekte or ref["projekte"]
    ergebnis = {}
    for schluessel, eintrag in sorted(ref["dateien"].items()):
        audio = _audio(wurzel, eintrag["projekt"], eintrag["base"])
        roh = os.path.join(wurzel, eintrag["projekt"], "transkripte", eintrag["base"] + ".json")
        if not audio or not os.path.exists(roh):
            # ABBRUCH, nicht SKIP — dieselbe Regel wie beim `nan` unten. Ein uebersprungener
            # Referenzeintrag laesst den Lauf ueber WENIGER Dateien laufen als den Nullpunkt;
            # `_summe` mittelt dann ueber verschiedene Mengen, und `vergleich` stellt zwei
            # Zahlen gegenueber, die nicht dasselbe messen. Der Kandidat kann so die Abnahme
            # bestehen, ohne dass jemand es sieht. (CodeRabbit-CLI, Major.)
            raise SystemExit(
                f"{schluessel}: Audio oder Roh-JSON fehlt ({audio=}, {roh=}). Abbruch — ein "
                f"unvollstaendiger Lauf ist mit dem Nullpunkt nicht vergleichbar.")
        with open(roh, encoding="utf-8") as f:
            raw = json.load(f)
        k = eintrag["sprecher_wahr"] if args.sprecher_aus_referenz else args.num_speakers
        grenzen = {"num_speakers": k} if k else {"min_speakers": args.min_speakers}
        turns = diarize.diarize_file(audio, **grenzen)
        vorhersage = diarize.assign_clusters(raw, turns)
        referenz = {s["id"]: s["sprecher"] for s in eintrag["segmente"]}
        dauer = {s["id"]: (s["end"] or 0) - (s["start"] or 0) for s in eintrag["segmente"]}
        quote = fehlerquote(vorhersage, referenz, dauer)
        if quote != quote:                     # nan: keine gemeinsamen Segment-IDs
            raise SystemExit(
                f"{schluessel}: kein einziges Segment ist beiden bekannt. Die Referenz passt "
                f"nicht zu diesem Material (neu transkribiert? falscher --projekte-Pfad?). "
                f"Abbruch — ein Lauf, der nichts vergleichen kann, darf keine Zahl liefern.")
        h, c, v = v_measure(vorhersage, referenz)
        ergebnis[schluessel] = {
            # ZWEI Zahlen, nicht eine: `sprecherzahl` zaehlt die Etiketten NACH
            # `assign_clusters` — ein Cluster, der bei keinem Segment den groessten Overlap
            # gewinnt (kurze Rueckkanaele), taucht dort nicht auf. #264 hat aber die
            # Clusterzahl von pyannote gemessen, und bei C1 (min_speakers 1 gegen 2) ist genau
            # das der interessante Unterschied.
            "sprecherzahl": sprecherzahl(vorhersage),
            "cluster_roh": len({t["cluster"] for t in turns}),
            "sprecher_wahr": eintrag["sprecher_wahr"],
            # Gesamtdauer je Datei: ohne sie kann `_summe` die Fehlerquote nicht ueber den Satz
            # ZEITgewichtet mitteln, sondern nur ueber Dateien — und ein 40-Sekunden-Schnipsel
            # waege dann so viel wie ein 5-Minuten-Interview (Abnahmekriterium 1 haengt daran).
            "dauer_s": round(sum(dauer.get(i, 0.0) for i in referenz if i in vorhersage), 2),
            "homogenitaet": round(h, 4), "vollstaendigkeit": round(c, 4), "v": round(v, 4),
            "fehlerquote": round(quote, 4)}
        e = ergebnis[schluessel]
        print(f"  {schluessel:<44} {e['sprecherzahl']}({e['cluster_roh']})/{e['sprecher_wahr']} "
              f"Sprecher | V {e['v']:.3f} | Fehler {e['fehlerquote']*100:5.1f}%", flush=True)
    if not ergebnis:
        # Kein Artefakt fuer einen leeren Lauf. Sonst legt `vergleich` spaeter zwei Laeufe
        # nebeneinander, von denen einer NICHTS gemessen hat — `_summe` teilt durch `or 1`
        # und liefert 0,0 %, also den Bestwert. Dieselbe Klasse wie das `nan` oben.
        raise SystemExit("kein einziger Referenzeintrag gemessen — kein Lauf geschrieben.")
    ziel = _unter_eval(os.path.join("eval", "laeufe", args.name + ".json"))
    os.makedirs(os.path.dirname(ziel), exist_ok=True)
    # Die Einstellungen EINZELN, nicht `vars(args)`: darin steckt ueber `set_defaults` die
    # Funktion `fn`, und `json.dump` stirbt daran mit TypeError — nach dem Rechnen, also nach
    # allen GPU-Minuten des Laufs.
    with open(ziel, "w", encoding="utf-8") as f:
        json.dump({"name": args.name, "dateien": ergebnis,
                   "einstellungen": {"min_speakers": args.min_speakers,
                                     "num_speakers": args.num_speakers,
                                     "sprecher_aus_referenz": args.sprecher_aus_referenz,
                                     "config": args.config}}, f, indent=1, ensure_ascii=False)
    _summe(args.name, ergebnis)
    return 0


def _audio(wurzel: str, projekt: str, base: str):
    # Die Endungen kommen aus `correct.AUDIO_EXT` — eine zweite Liste liefe beim naechsten
    # Format auseinander, und dann faende das Messwerkzeug still eine Datei nicht, die die
    # Pipeline sehr wohl verarbeitet. Dieselbe Regel wie bei `sprachen.py` und `_lockziel()`.
    from webtool.correct import AUDIO_EXT
    for ext in AUDIO_EXT:
        p = os.path.join(wurzel, projekt, "audio", base + ext)
        if os.path.exists(p):
            return p
    return None


def _summe(name: str, ergebnis: dict) -> dict:
    """Die Kennzahlen ueber den ganzen Satz.

    Die Fehlerquote wird NACH REDEZEIT gewichtet, nicht ueber Dateien gemittelt: sonst wiegt
    ein 40-Sekunden-Schnipsel so viel wie ein 5-Minuten-Interview, und ein Kandidat koennte die
    Abnahme bestehen, indem er die kurzen Dateien verbessert und das lange Material
    verschlechtert — die Summe stiege, der Nutzer merkte das Gegenteil. Das V-Measure bleibt
    ein schlichtes Mittel ueber Dateien: es ist eine Struktur-, keine Mengenaussage, und eine
    Zeitgewichtung waere dort nicht definiert. Beide Zahlen tragen deshalb verschiedene Namen.
    """
    n = len(ergebnis) or 1
    treffer = sum(1 for e in ergebnis.values() if e["sprecherzahl"] == e["sprecher_wahr"])
    zeit = sum(e["dauer_s"] for e in ergebnis.values()) or 1.0
    summe = {"dateien": len(ergebnis), "zahl_getroffen": treffer,
             "v_mittel_je_datei": round(sum(e["v"] for e in ergebnis.values()) / n, 4),
             "fehler_zeitgewichtet": round(
                 sum(e["fehlerquote"] * e["dauer_s"] for e in ergebnis.values()) / zeit, 4)}
    print(f"\n[{name}] {summe['dateien']} Dateien, {zeit/60:.1f} Min | Sprecherzahl getroffen: "
          f"{treffer}/{summe['dateien']} | V {summe['v_mittel_je_datei']:.3f} | "
          f"Fehler {summe['fehler_zeitgewichtet']*100:.1f}%")
    return summe


def cmd_vergleich(args) -> int:
    """Zwei Laeufe nebeneinander, je Datei und in der Summe.

    Zeigt bewusst JEDE Datei, nicht nur die Summe: eine Aenderung, die den schweren Fall
    rettet und den leichten opfert, ist keine Verbesserung (Abnahmekriterium 2 der Spec) —
    und in der Summe waere genau das unsichtbar.
    """
    laeufe = []
    for name in (args.a, args.b):
        with open(os.path.join("eval", "laeufe", name + ".json"), encoding="utf-8") as f:
            laeufe.append(json.load(f))
    a, b = laeufe
    print(f"{'Datei':<44} {'Zahl a/b/wahr':>14} {'V a->b':>16} {'Fehler a->b':>18}")
    for schluessel in sorted(set(a["dateien"]) | set(b["dateien"])):
        ea, eb = a["dateien"].get(schluessel), b["dateien"].get(schluessel)
        if not ea or not eb:
            print(f"{schluessel:<44} nur in einem Lauf")
            continue
        pfeil = "+" if eb["fehlerquote"] < ea["fehlerquote"] else (
            "-" if eb["fehlerquote"] > ea["fehlerquote"] else "=")
        print(f"{schluessel:<44} {ea['sprecherzahl']}/{eb['sprecherzahl']}/"
              f"{ea['sprecher_wahr']:>3}   {ea['v']:.3f}->{eb['v']:.3f}   "
              f"{ea['fehlerquote']*100:5.1f}%->{eb['fehlerquote']*100:5.1f}%  {pfeil}")
    print()
    _summe(a["name"], a["dateien"])
    _summe(b["name"], b["dateien"])
    return 0


def _lauf_name(wert: str) -> str:
    """Laufnamen gehen ungeprueft in einen Dateipfad. `run ../../projekte/...` schriebe genau
    dorthin, wo der wichtigste Constraint dieses Plans es verbietet — der darf nicht bloss
    durch Disziplin gesichert sein. Dieselbe Haltung wie `paths.safe_name`."""
    if not wert or not all(c.isalnum() or c in "-_." for c in wert) or wert.startswith("."):
        raise argparse.ArgumentTypeError(
            "nur Buchstaben, Ziffern, '-', '_' und '.', nicht mit '.' beginnend")
    return wert


EVAL = os.path.abspath("eval")


def _unter_eval(pfad: str) -> str:
    """Jeder Schreibpfad dieses Werkzeugs muss unter `eval/` landen — geprueft am AUFGELOESTEN
    Pfad, nicht am getippten.

    `--ziel ../../projekte/Rhyathlon/transkripte/00114307.edit.json` ginge sonst ungeprueft in
    ein `open(..., "w")` und ueberschriebe echtes Material. Der wichtigste Constraint dieses
    Plans („nie nach projekte\\ schreiben") war damit allein durch Disziplin gesichert, und ein
    Vertipper reicht. `os.path.realpath` auf BEIDEN Seiten, sonst kaeme ein Symlink daran vorbei.
    """
    ziel = os.path.realpath(pfad)
    wurzel = os.path.realpath(EVAL)
    if ziel != wurzel and not ziel.startswith(wurzel + os.sep):
        raise SystemExit(f"Ziel liegt ausserhalb von eval/: {ziel}")
    return ziel


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="befehl", required=True)

    f = sub.add_parser("freeze", help="handkorrigierte edit.json -> eval/referenz.json")
    f.add_argument("--projekte", required=True, help="Wurzel der Projektordner")
    f.add_argument("--liste", default=os.path.join("eval", "referenzsatz.txt"),
                   help="eine Zeile <Projekt>/<Base> je Datei; '#' ist Kommentar")
    f.add_argument("--ziel", default=os.path.join("eval", "referenz.json"))
    f.set_defaults(fn=cmd_freeze)

    r = sub.add_parser("run", help="Referenzsatz mit einer Konfiguration durchmessen")
    r.add_argument("name", type=_lauf_name, help="Name des Laufs (-> eval/laeufe/<name>.json)")
    r.add_argument("--referenz", default=os.path.join("eval", "referenz.json"))
    r.add_argument("--projekte", default=None, help="ueberschreibt die Wurzel aus der Referenz")
    r.add_argument("--min-speakers", type=int, default=2)
    r.add_argument("--num-speakers", type=int, default=None)
    r.add_argument("--sprecher-aus-referenz", action="store_true",
                   help="die WAHRE Sprecherzahl vorgeben (beantwortet Spec 1.3a)")
    r.add_argument("--config", default=None, help="alternative pyannote-config.yaml")
    r.set_defaults(fn=cmd_run)

    v = sub.add_parser("vergleich", help="zwei Laeufe gegenueberstellen")
    v.add_argument("a")
    v.add_argument("b")
    v.set_defaults(fn=cmd_vergleich)

    args = p.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
