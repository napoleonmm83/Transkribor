"""Pfade + Namensvalidierung (Trust-Boundary: project/base kommen aus der URL)."""
import glob
import os
import stat
import unicodedata

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def projekte_root() -> str:
    return os.environ.get("TRANSKRIBOR_PROJEKTE") or os.path.join(ROOT, "projekte")


def downloads_dir() -> str:
    """Standard-Downloads-Verzeichnis des Nutzers."""
    return os.environ.get("TRANSKRIBOR_DOWNLOADS") or os.path.join(os.path.expanduser("~"), "Downloads")


def safe_name(name: str) -> str:
    # "." / ".." resolven auf Eltern-/Self-Verzeichnis -> dürfen project_dir()
    # nie erreichen (sonst rmtree auf projekte_root() selbst, siehe Task 4 Review).
    # Steuerzeichen (\t, \r, \n, ord < 32, ord == 127) zerbrechen Protokoll- und Scope-Zeilen (#378).
    # Windows entfernt abschliessende Punkte und Leerzeichen bei der Pfadauflösung. Ohne
    # diese Wache bekämen etwa "Demo" und "Demo." verschiedene Sperren für denselben Ordner.
    if (not name or name in (".", "..") or name.endswith((".", " "))
            or "/" in name or "\\" in name
            or ":" in name or ".." in name or any(ord(c) < 32 or ord(c) == 127 for c in name)):
        raise ValueError(f"unsicherer Name: {name!r}")
    return name


# Abgeleitet aus den KONSUMENTEN des Zeilenstroms, nicht geraten: jobs.py parst
# scope/scope+/active/done (Präfix-Konstanten jobs.py:31-41), jobPhases.ts ausserdem
# fetch (:163-188, dort mit eigenem Warnkommentar zum gleichnamigen Projekt). NICHT
# reserviert sind die nur druckenden Marken ohne Parse-Zweig (autocorrect, ytdlp,
# sperre). Wer beim Parser eine Marke dazubaut, nimmt das Wort hier mit — und
# umgekehrt. Exakt und kleingeschrieben: die Parser matchen case-sensitiv, ein
# Projekt "Active" kollidiert mit der Marke "[active] " nicht.
RESERVIERTE_NAMEN = {"scope", "scope+", "active", "done", "fetch"}


def sicherer_projektname(roh: str) -> str:
    """safe_name PLUS Namensraum-Riegel — NUR fuer Anlege-/Umbenennpfade (#416).

    Markenraum und Projektnamensraum sind derselbe: die Laefe praefixen gewoehnliche
    Zeilen mit "[{Projektname}] ", die Marken ([active] …, [done] …, [scope] …,
    [scope+] …) aber ohne Projektnamen. Ein Projekt namens "active" ist damit
    zeilengleich mit der Marke und vergiftet Buchfuehrung und Anzeige (#478/#487).
    Eckige Klammern machen die Zeile zusaetzlich fuer den Parser mehrdeutig (#416).

    Der LESEPFAD (jeder Endpunkt auf ein bestehendes Projekt) bleibt bei safe_name:
    dort verschaeft hiesse ein Altprojekt "active", dass sich der Nutzer von seinen
    eigenen Daten aussperrt. Umbenennen auf einen sauberen Namen ist der Reparaturweg
    (rename_project prueft nur den ZIELnamen). ValueError mit benanntem Grund.
    """
    name = safe_name(roh.strip())
    if "[" in name or "]" in name:
        raise ValueError(f"Projektname darf keine eckigen Klammern enthalten: {name!r}")
    if name in RESERVIERTE_NAMEN:
        raise ValueError(f"Projektname ist reserviert (Protokoll-Marke): {name!r}")
    return name


def project_dir(project: str) -> str:
    return os.path.join(projekte_root(), safe_name(project))


def vorhandener_projektname(project: str) -> str:
    """Liefert die echte Verzeichnis-Schreibweise eines vorhandenen Projekts.

    ``normcase`` kennt nur die Python-Plattform, nicht das konkrete Volume. Auf einem
    case-insensitiven APFS-Volume ist es deshalb wirkungslos. ``samefile`` fragt dagegen
    das Dateisystem und laesst case-sensitive Volumes weiterhin getrennt.
    """
    name = safe_name(project)
    kandidat = os.path.join(projekte_root(), name)
    try:
        with os.scandir(projekte_root()) as eintraege:
            kandidaten = list(eintraege)
    except FileNotFoundError:
        return name
    except OSError:
        raise
    for eintrag in kandidaten:
        if eintrag.name == name:
            return name
    for eintrag in kandidaten:
        if namensform(eintrag.name) != namensform(name):
            continue
        try:
            if eintrag.is_dir() and os.path.samefile(eintrag.path, kandidat):
                return eintrag.name
        except FileNotFoundError:
            continue
        except OSError:
            raise
    return name


def namensform(name: str) -> str:
    """Nur Vorfilter fuer samefile; die Dateisystemprobe bleibt das Urteil."""
    return unicodedata.normalize("NFD", name).casefold()


_TRANSKRIPT_ENDUNGEN = (
    ".edit.json", ".correction.json", ".diar.json", ".segments.json",
    ".json", ".md", ".srt", ".vtt", ".txt",
)


def vorhandene_aufnahmenamen(project: str, bases) -> dict[str, str]:
    """Loest mehrere Aufnahmen mit genau einem Scan je Artefaktordner auf.

    Ein exakt sichtbarer Stamm gewinnt immer. Erst wenn er fehlt, darf ``samefile``
    eine andere Schreibweise desselben Dateisystemobjekts liefern. Damit bleiben zwei
    sichtbare Hardlink-Namen fachlich getrennt. Unerwartete Dateisystemfehler werden
    weitergegeben, damit Sperrentscheidungen nicht mit einer geratenen Identitaet laufen.
    """
    project = vorhandener_projektname(project)
    gesucht = {base: safe_name(base) for base in bases}
    if not gesucht:
        return {}
    formen = {namensform(name) for name in gesucht.values()}
    pdir = project_dir(project)
    audio = os.path.join(pdir, "audio")
    try:
        audio_ordner = audio if stat.S_ISDIR(os.stat(audio).st_mode) else pdir
    except FileNotFoundError:
        audio_ordner = pdir
    except OSError:
        raise
    ordner = [transkripte_dir(project), audio_ordner]
    gesehen: set[str] = set()
    kandidaten: dict[str, list[tuple[str, str, str]]] = {}
    for verzeichnis in ordner:
        real = os.path.realpath(verzeichnis)
        if real in gesehen:
            continue
        gesehen.add(real)
        try:
            with os.scandir(verzeichnis) as eintraege:
                eintragsliste = list(eintraege)
        except FileNotFoundError:
            continue
        except OSError:
            raise
        for eintrag in eintragsliste:
            endungen = [e for e in _TRANSKRIPT_ENDUNGEN if eintrag.name.endswith(e)]
            if not endungen:
                _stamm, endung = os.path.splitext(eintrag.name)
                endungen = [endung] if endung else []
            for endung in endungen:
                wirklich = eintrag.name[:-len(endung)]
                form = namensform(wirklich)
                if form not in formen:
                    continue
                try:
                    if not eintrag.is_file():
                        continue
                except FileNotFoundError:
                    continue
                except OSError:
                    raise
                kandidaten.setdefault(form, []).append((wirklich, eintrag.path, endung))

    ergebnis: dict[str, str] = {}
    for roh, name in gesucht.items():
        passende = kandidaten.get(namensform(name), [])
        if any(wirklich == name for wirklich, _pfad, _endung in passende):
            ergebnis[roh] = name
            continue
        ergebnis[roh] = name
        for wirklich, eintragspfad, endung in passende:
            kandidat = os.path.join(os.path.dirname(eintragspfad), name + endung)
            try:
                if os.path.samefile(eintragspfad, kandidat):
                    ergebnis[roh] = wirklich
                    break
            except FileNotFoundError:
                continue
            except OSError:
                raise
    return ergebnis


def vorhandener_aufnahmename(project: str, base: str) -> str:
    """Liefert die echte Schreibweise einer vorhandenen Aufnahme."""
    return vorhandene_aufnahmenamen(project, [base])[base]


def transkripte_dir(project: str) -> str:
    return os.path.join(project_dir(project), "transkripte")


def audio_dir(project: str) -> str:
    d = os.path.join(project_dir(project), "audio")
    return d if os.path.isdir(d) else project_dir(project)


def transcript_bases(project: str) -> list:
    """Basisnamen der Roh-Transkripte (<base>.json), ohne abgeleitete
    <base>.edit.json / <base>.correction.json / <base>.diar.json und ohne
    Meta-Artefakte (_*.json, z.B. _glossar.json aus Stufe 2b)."""
    tdir = transkripte_dir(project)
    if not os.path.isdir(tdir):
        return []
    out = set()
    for p in glob.glob(os.path.join(tdir, "*.json")):
        name = os.path.basename(p)
        if name.startswith("_") or p.endswith((".edit.json", ".correction.json", ".diar.json")):
            continue
        out.add(os.path.splitext(name)[0])
    return sorted(out)


def atomic_write(path: str, text: str) -> None:
    """Schreibe erst in .tmp, dann os.replace() -> nie halb-geschriebene Datei."""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.replace(tmp, path)


def kennung(pfad: str):
    """Dateiidentitaet — ANWESENHEIT ist zu wenig. `None`, wenn `os.stat` wirft.

    Loeschen ist waehrend eines Laufs erlaubt, solange nicht gerade an der Aufnahme gerechnet
    wird (#80). Legt jemand danach eine Datei DESSELBEN Namens neu an, ist es fuer jeden Leser
    eine NEUE Aufnahme — am blossen Namen ist das nicht zu sehen, und erst recht nicht, wenn
    Loeschen und Neuanlegen in dieselbe Runde fallen (der Lauf steckt dann minutenlang in
    Whisper und sieht die Luecke nie).

    Dieselben drei Felder wie `edit_model`s `dateistand`: `st_ino` traegt die Eindeutigkeit,
    Zeit und Groesse fangen den Fall ab, in dem ein Dateisystem die Inode wiederverwendet.
    Ein Wurf ist kein Fehler, sondern „ich weiss es nicht".

    **Die Richtung des Zweifels ist beim AUFRUFER, nicht hier** — und sie ist bei den beiden
    Lesern verschieden, deshalb steht sie nicht in dieser Funktion:
    `transcribe._kennung` (Bereichs-Nachtrag, #485) meldet bei `None` lieber einmal zu viel;
    `correct.cmd_run` (#523) ueberspringt dann lieber eine Datei, denn eine nicht korrigierte
    Aufnahme holt der naechste Lauf, eine falsch korrigierte ueberschreibt Nutzertext.

    Hier statt in `transcribe.py`, seit `correct.py` derselbe Vergleich braucht (#523):
    `correct` importiert `paths` ohnehin, `transcribe` importiert `webtool` nur verzoegert —
    andersherum haette einer der beiden eine zweite Fassung derselben Regel bekommen."""
    try:
        s = os.stat(pfad)
        return (s.st_ino, s.st_mtime_ns, s.st_size)
    except OSError:
        return None


def beiseitelegen(pfad: str) -> str:
    """Eine nicht lesbare Datei retten, BEVOR ein Read-Modify-Write sie mit Defaults ersetzt.

    `settings.save()` und `projekt.speichern`/`setze_datei` lesen ueber einen Leser, der bei
    kaputten Bytes auf Defaults zurueckfaellt (#190) — und schreiben genau diese Defaults
    zurueck. Gemessen war danach der API-Key weg (#192) bzw. Sprache und Korrektur-Tiefe ALLER
    Dateien eines Projekts (#196). Der Inhalt war dabei mit blossem Auge noch lesbar: ein
    einzelnes kaputtes Byte macht die Datei fuer `json.load` unbrauchbar, nicht fuer den
    Menschen. Rueckgabe: der Pfad der Rettung, oder "" wenn nichts gerettet wurde.

    **Die ERSTE Rettung gewinnt.** Nach ihr steht in der Datei nur noch Default-Inhalt — eine
    zweite Beschaedigung ueberschriebe also ausgerechnet das, was man retten wollte. Dieselbe
    Richtung wie ueberall in diesem Repo: ein Rueckfall darf nichts freigeben, was er schuetzen
    soll.

    Best effort: schlaegt das Umbenennen fehl, laeuft der Schreibvorgang trotzdem. Der Aufruf
    dient dem Schutz, er ist nicht sein Zweck (dieselbe Regel wie beim Lock in `sperre.py`).
    """
    ziel = pfad + ".kaputt"
    try:
        if os.path.exists(ziel):
            print(f"⚠ {pfad} ist erneut nicht lesbar — {ziel} bleibt die aeltere Rettung "
                  f"und wird NICHT ueberschrieben", flush=True)
            return ""
        os.replace(pfad, ziel)
    except OSError as e:
        print(f"⚠ {pfad} liess sich nicht beiseitelegen ({type(e).__name__}: {e}) — "
              f"der Inhalt geht beim naechsten Schreibvorgang verloren", flush=True)
        return ""
    print(f"⚠ {pfad} war nicht lesbar — die alte Fassung liegt jetzt als {ziel}", flush=True)
    return ziel
