"""Opt-in Fehlerberichte an Bugsink (#530, Teil b) — die Python-Hälfte der Entscheidungen.

Die JS-Hälfte steht in ``electron/fehlerberichte.js`` (PR a, v0.52.0); diese Datei trägt
dieselben Zusagen für den Server-Prozess und die Subprozess-Einstiege (``transcribe.py``,
``webtool/correct.py``, ``webtool/fetch.py``) — genau dort stehen die Job-Tracebacks, die
vorher in KEINEM Bericht ankamen. Drei Zusagen, jede hier statt im SDK:

1. **Der Schalter ist eine Datei und wird JE EREIGNIS gelesen.** Eigentümer ist der
   Electron-Hauptprozess (``userData/fehlerberichte.json``), der Pfad kommt über
   ``TRANSKRIBOR_FEHLERBERICHTE``; eine fehlende, kaputte oder fremd geformte Datei heisst
   AUS — dieselbe Rückfallrichtung wie bei jeder Schutzflagge dieses Repos. AUS wirkt ohne
   Neustart, in beide Richtungen.
2. **Was mitgeht, ist maskiert** (Spec #530, Abschnitt 6 — eine Regel, zweimal umgesetzt):
   API-Schlüssel (wie ``electron/protokoll.js``), Benutzerpfade (``<home>``, ``<daten>``,
   ``<projekte>``) und die Namen von Projekten und Aufnahmen (``<projekt>``, ``<datei>``).
   Die Namensliste wird zum Sendezeitpunkt aus dem Projekte-Ordner gelesen: deterministisch,
   keine Regex-Vermutung. Ausnahmen aus ``webtool/llm.py`` verlieren ihre Meldung (Anbieter-
   Fragmente) und tragen nur Typ und Kategorie aus ``diagnose_fehler``.
3. **Keine Sitzungen, keine Breadcrumbs, keine lokalen Variablen, kein Request-Objekt.** Die
   Integrationen stehen auf einer Erlaubnisliste, nicht auf einer Verbotsliste — die Lehre
   aus ``LocalVariablesAsync``: eine Verbotsliste veraltet mit jedem SDK-Update still.

Die Transport-Warteschlange liegt im RAM und stirbt mit dem Prozess (an sentry_sdk 2.69.1
nachgemessen: kein ``open``/pickle/sqlite im Transportmodul). Ein Ereignis, das beim
Umschalten auf AUS schon erfasst ist, kann in den Folgesekunden noch versandt werden —
anders als beim Electron-Teil gibt es keine Platten-Warteschlange, die beim nächsten Start
weiterreichen würde; bewusst ohne zusätzliche Versand-Wache entschieden (Marcus, 2026-09-09).
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import sys
import unicodedata
from urllib.parse import quote

from . import paths

# Namen kürzer als das werden nicht maskiert — `ab` in jedem Wort zu ersetzen hilft niemandem
# (denselben Wert und dieselbe Begründung wie electron/fehlerberichte.js).
MIN_NAME = 3

# Port aus electron/protokoll.js:36-42 — dieselben fünf Muster, derselbe Ersatz.
SCHLUESSEL_MUSTER = tuple(re.compile(m) for m in (
    r"sk-[a-zA-Z0-9_-]{12,}",          # OpenAI / OpenRouter / generic API keys
    r"sk-ant-[a-zA-Z0-9_-]{12,}",      # Anthropic API keys
    r"AIzaSy[a-zA-Z0-9_-]{20,}",       # Google Gemini API keys
    r"gsk_[a-zA-Z0-9_-]{20,}",         # Groq API keys
    r"hf_[a-zA-Z0-9_-]{20,}",          # Hugging Face Tokens
))
SCHLUESSEL_ERSATZ = "***[API-KEY]***"

# Die Felder des Ereignisses, die Inhalt tragen und maskiert werden. Alles andere —
# sdkProcessingMetadata, event_id, timestamp, platform, sdk — gehört dem SDK; genau dort
# hängt es zyklische Objekte an, an denen die erste JS-Fassung still starb (RangeError in
# beforeSend, das SDK verwarf das Ereignis). Dasselbe Tupel wie INHALTSFELDER in JS.
INHALTSFELDER = (
    "message", "logentry", "exception", "extra", "contexts", "tags", "breadcrumbs",
    "request", "user", "transaction", "modules", "fingerprint", "threads", "debug_meta",
)

# Die Integrationen, die laufen DÜRFEN — Erlaubnisliste. Bewusst draussen: LoggingIntegration
# (Logmeldungen tragen Nutzertext), FastApiIntegration (liest Request-Bodies, die wir ohnehin
# streichen — Starlette reicht für die Ausnahme-Behandlung), ArgvIntegration (argv trägt den
# Projektnamen), alles Breadcrumb-/Tracing-/Session-artige. Die Namen werden im Test gegen
# das installierte Paket geprüft: ein Name, den es nicht gibt, ist ein still Loch in der Liste.
ERLAUBT = (
    "DedupeIntegration", "ExcepthookIntegration", "AtexitIntegration",
    "ThreadingIntegration", "AsyncioIntegration", "StarletteIntegration",
)

# Text der absichtlichen Ausnahme (TRANSKRIBOR_FEHLERPROBE=1) — daran erkennt man sie in
# Bugsink. Nur der Wert "1" zählt: true, ja oder leer werfen niemand aus Versehen.
FEHLERPROBE = "Fehlerprobe: absichtlich geworfen (TRANSKRIBOR_FEHLERPROBE=1)"

_aktiv = False


def aktiv() -> bool:
    """Ob in DIESEM Prozess ein Fehlerberichte-SDK initialisiert ist (Testriegel-Zeuge)."""
    return _aktiv


def _zuruecksetzen() -> None:
    """Nur für Tests: den Aktiv-Merker zurücknehmen (Muster ``_home`` in
    electron/fehlerberichte.js). Der conftest-Riegel ruft das vor jedem Test; wer init()
    absichtlich mit einer Attrappe fährt, räumt damit im finally auf."""
    global _aktiv
    _aktiv = False


def lesen(pfad: str) -> dict:
    """Den Schalter lesen — fehlend, kaputt oder fremd geformt heisst AUS.

    Ein führendes BOM wird abgestreift (encoding utf-8-sig): Notepad und PowerShells
    ``Set-Content -Encoding utf8`` schreiben eines, und ein simples ``json.load`` wirft daran.
    Gemessen im gepackten Lauf von PR (a): Schalter AN in der Datei, gelesen AUS, kein
    Envelope.
    """
    try:
        with open(pfad, encoding="utf-8-sig") as f:
            d = json.load(f)
    except (OSError, ValueError):
        return {"automatisch": False, "gefragt": None}
    if not isinstance(d, dict):
        return {"automatisch": False, "gefragt": None}
    gefragt = d.get("gefragt")
    return {
        "automatisch": d.get("automatisch") is True,
        "gefragt": gefragt if isinstance(gefragt, str) and gefragt else None,
    }


def basen(name: str) -> list[str]:
    """Alle Punkt-Präfixe eines Dateinamens, nicht nur der bis zum ersten Punkt.

    ``Dr. Mueller Interview.m4a`` trägt seinen Namen HINTER einem Punkt, ``Interview
    12.03.2026.m4a`` mitten in einer Zahl — der erste Punkt allein liess beide unmaskiert
    durch (Kalt-Review an der JS-Fassung). Die Längste-zuerst-Sortierung in ``namen()``
    ersetzt dann `Dr. Mueller Interview` vor `Dr`.
    """
    aus: list[str] = []
    i = name.find(".")
    while i > 0:
        aus.append(name[:i])
        i = name.find(".", i + 1)
    return aus or [name]


def namen(projekte_wurzel: str) -> dict:
    """Projekt- und Basisnamen, wie sie auf der Platte stehen — längste zuerst.

    Ein fehlender oder unlesbarer Ordner liefert leere Listen, kein Wurf: die Maskierung
    darf den Bericht nicht verhindern, nur entschärfen.
    """
    projekte: set[str] = set()
    dateien: set[str] = set()
    try:
        eintraege = os.scandir(projekte_wurzel)
    except OSError:
        return {"projekte": [], "dateien": []}
    with eintraege:
        for e in eintraege:
            try:
                if not e.is_dir():
                    continue
            except OSError:
                continue
            if len(e.name) >= MIN_NAME:
                projekte.add(e.name)
            for unter in ("audio", "transkripte"):
                try:
                    liste = os.listdir(os.path.join(projekte_wurzel, e.name, unter))
                except OSError:
                    continue
                for datei in liste:
                    for basis in basen(datei):
                        if len(basis) >= MIN_NAME:
                            dateien.add(basis)

    def laengste_zuerst(s: str) -> tuple[int, str]:
        return (-len(s), s)

    return {"projekte": sorted(projekte, key=laengste_zuerst),
            "dateien": sorted(dateien, key=laengste_zuerst)}


def pfad_muster(p: str) -> re.Pattern[str]:
    """Ein Pfad kommt in vier Schreibweisen vor: wie notiert, mit ``/`` statt ``\\``,
    JSON-kodiert mit ``\\\\`` und URL-kodiert — dieses mit rohem und kodiertem Doppelpunkt
    (``C:%5CUsers`` in einer Zugriffszeile). Windows-Pfade unterscheiden keine Gross- und
    Kleinschreibung, also IGNORECASE nur dort."""
    vorwaerts = p.replace("\\", "/")
    formen = {p, vorwaerts, p.replace("\\", "\\\\")}
    for f in (p, vorwaerts):
        k = quote(f, safe="")
        formen.update((k, k.replace("%3A", ":")))
    flags = re.IGNORECASE if sys.platform == "win32" else 0
    return re.compile("|".join(re.escape(f) for f in formen), flags)


def namens_formen(name: str) -> set[str]:
    """Ein Name in allen Formen, in denen er in einer Meldung stehen kann: roh, NFC und NFD
    (macOS legt Dateinamen zerlegt ab, eine Meldung aus dem Server trägt sie zusammengesetzt)
    und jede davon URL-kodiert (Zugriffszeilen mit 4xx/5xx bleiben im Bericht)."""
    roh = {name, unicodedata.normalize("NFC", name), unicodedata.normalize("NFD", name)}
    return roh | {quote(n, safe="") for n in roh}


def maskiere(text, ctx: dict | None = None):
    """Einen String durch alle Masken. Reihenfolge: Schlüssel, dann die längsten Pfade
    zuerst (``projekte`` liegt gepackt UNTER ``daten``), dann Aufnahmen vor Projekten.
    Nicht-Strings und leere Strings kommen unverändert zurück."""
    if not isinstance(text, str) or not text:
        return text
    ctx = ctx or {}
    t = text
    for m in SCHLUESSEL_MUSTER:
        t = m.sub(SCHLUESSEL_ERSATZ, t)
    pfade = sorted(
        ((k, ersatz) for k, ersatz in (("projekte", "<projekte>"), ("daten", "<daten>"),
                                       ("home", "<home>"))
         if isinstance(ctx.get(k), str) and len(ctx[k]) >= MIN_NAME),
        key=lambda pa: -len(ctx[pa[0]]),
    )
    for k, ersatz in pfade:
        t = pfad_muster(ctx[k]).sub(ersatz, t)
    n = ctx.get("namen") or {}
    # Die Längengrenze gilt HIER, nicht nur beim Sammeln: die Liste kann von anderswo kommen.
    for name in sorted((x for x in (n.get("dateien") or []) if isinstance(x, str) and len(x) >= MIN_NAME),
                       key=len, reverse=True):
        for form in namens_formen(name):
            t = t.replace(form, "<datei>")
    for name in sorted((x for x in (n.get("projekte") or []) if isinstance(x, str) and len(x) >= MIN_NAME),
                       key=len, reverse=True):
        for form in namens_formen(name):
            t = t.replace(form, "<projekt>")
    return t


def maskiere_tief(wert, ctx: dict | None = None, gesehen: set[int] | None = None):
    """Jeden String in einem Wert, wo er auch steckt. Zyklen werden erkannt und als
    ``[Zyklus]`` abgebrochen — das SDK hängt sich selbst zyklische Objekte unter
    ``sdkProcessingMetadata`` (die erste JS-Fassung lief endlos und das SDK verwarf still)."""
    if isinstance(wert, str):
        return maskiere(wert, ctx)
    if isinstance(wert, dict):
        gesehen = gesehen if gesehen is not None else set()
        if id(wert) in gesehen:
            return "[Zyklus]"
        gesehen = gesehen | {id(wert)}
        return {k: maskiere_tief(v, ctx, gesehen) for k, v in wert.items()}
    if isinstance(wert, (list, tuple)):
        gesehen = gesehen if gesehen is not None else set()
        if id(wert) in gesehen:
            return "[Zyklus]"
        gesehen = gesehen | {id(wert)}
        return [maskiere_tief(v, ctx, gesehen) for v in wert]
    return wert


def ereignis_maskieren(event: dict, ctx: dict | None = None) -> dict:
    """Ein Ereignis mit maskiertem Inhalt — dieselben Objekte für alles, was kein Inhalt ist."""
    aus = dict(event)
    for feld in INHALTSFELDER:
        if feld in aus:
            aus[feld] = maskiere_tief(aus[feld], ctx)
    return aus


def _llm_uebernehmen(event: dict) -> None:
    """Spec 6.4: Ausnahmen, deren Ursprungs-Frame in ``webtool/llm.py`` liegt, verlieren ihre
    Meldung — LLM-Antwortfragmente und Anbieter-Rohantworten reisen nie. An ihrer Stelle
    stehen Ausnahme-Typ und Kategorie aus ``diagnose_fehler``."""
    try:
        from . import llm
    except Exception:
        return
    for wert in ((event.get("exception") or {}).get("values") or []):
        frames = ((wert.get("stacktrace") or {}).get("frames") or [])
        herkunft = frames[-1].get("filename", "") if frames else ""
        if not herkunft.endswith("llm.py"):
            continue
        roh = wert.get("value") or ""
        try:
            kategorie = llm.diagnose_fehler(roh).get("kategorie", "unbekannt")
        except Exception:
            kategorie = "unbekannt"
        wert["value"] = f"[{wert.get('type', 'Fehler')}: {kategorie}]"


def _tags_setzen(event: dict) -> None:
    """Hardware-Tags (Spec 4) — nur wenn torch bereits geladen ist: bei echten Transkriptions-
    und Serverfehlern ist es das (dort zählt der Kontext), in fetch-Jobs kostet ein Import
    sonst Multi-Sekunden nur für Tags. ``device.describe()`` wirft nie (device.py)."""
    if "torch" not in sys.modules:
        return
    with contextlib.suppress(Exception):  # best effort: Tags duerfen den Bericht nie verhindern
        from . import device
        b = device.describe()
        event.setdefault("tags", {}).update({
            "device": b.get("device"),
            "gpu": b.get("name"),
            "asr_engine": b.get("asr_engine"),
            "torch_ok": b.get("torch_ok"),
            "whisper_model": os.environ.get("WHISPER_MODEL", "large-v3"),
        })


def _kontext(env) -> dict:
    """Die Maskier-Kontexte: home, daten (das Verzeichnis der Schalterdatei — im gepackten
    Lauf userData), projekte und die Namensliste zum Sendezeitpunkt."""
    schalter = env.get("TRANSKRIBOR_FEHLERBERICHTE", "")
    # Ohne TRANSKRIBOR_PROJEKTE laeuft die Arbeit gegen <repo>/projekte (transcribe.py:23,
    # paths.projekte_root()) — die Maske muss dieselbe Wurzel scannen, sonst reisen Namen
    # aus genau dem Lauf unmaskiert, den sie schuetzen soll (CodeRabbit-CLI, Major).
    projekte = env.get("TRANSKRIBOR_PROJEKTE") or paths.projekte_root()
    return {
        "home": os.path.expanduser("~"),
        "daten": os.path.dirname(schalter) if schalter else "",
        "projekte": projekte,
        "namen": namen(projekte),
    }


def before_send(event: dict, hint=None):
    """Der Riegel. Gibt ``None`` zurück, wenn der Nutzer nicht zugestimmt hat — das SDK
    verwirft das Ereignis dann, ohne dass ein Byte die Maschine verlässt. Streicht ``request``
    GANZ (Spec 6.5) und maskiert alle Inhaltsfelder."""
    schalter_pfad = os.environ.get("TRANSKRIBOR_FEHLERBERICHTE")
    if not schalter_pfad or not lesen(schalter_pfad)["automatisch"]:
        return None
    # Ein Abbruch ist kein Fehler: Ctrl+C im Konsolenlauf schlaegt als KeyboardInterrupt bis
    # zum sys.excepthook durch (transcribe.py faengt ihn nirgends), und die SDK-Integration
    # meldet ihn — der Nutzer haette seinen eigenen Abbruch als Fehlerbericht. Gewollter
    # Abbruch über jobs.cancel_all() ist ohnehin harter Kill und erreicht Python nie.
    if any(w.get("type") == "KeyboardInterrupt"
           for w in (event.get("exception") or {}).get("values") or []):
        return None
    event.pop("request", None)
    _llm_uebernehmen(event)
    _tags_setzen(event)
    return ereignis_maskieren(event, _kontext(os.environ))


def init(env=None) -> bool:
    """SDK initialisieren — no-op, wenn eine der drei Variablen fehlt (das ist zugleich der
    Browser-Modus, jeder Testlauf und der Testbau ohne Secret). **Wirft nie** (Vertrag wie
    ``ytdlp_update.beim_start``: ein kaputtes SDK darf Serverstart und Job nie töten; der
    Grund erscheint als eine Zeile auf stderr). Das SDK wird LAZY importiert — Tests und CI
    laufen damit auch ohne installiertes Paket."""
    global _aktiv
    env = env if env is not None else os.environ
    dsn = env.get("TRANSKRIBOR_BUGSINK_DSN")
    version = env.get("TRANSKRIBOR_VERSION")
    schalter = env.get("TRANSKRIBOR_FEHLERBERICHTE")
    if not (dsn and version and schalter):
        return False
    try:
        import sentry_sdk
        from sentry_sdk.integrations.asyncio import AsyncioIntegration
        from sentry_sdk.integrations.atexit import AtexitIntegration
        from sentry_sdk.integrations.dedupe import DedupeIntegration
        from sentry_sdk.integrations.excepthook import ExcepthookIntegration
        from sentry_sdk.integrations.starlette import StarletteIntegration
        from sentry_sdk.integrations.threading import ThreadingIntegration

        sentry_sdk.init(
            dsn=dsn,
            release=f"transkribor@{version}",
            environment="gepackt",  # init läuft praktisch nur in der gepackten App; Messläufe ebenso
            send_default_pii=False,
            server_name="",  # Der Rechnername ist PII — die JS-Hälfte schaltet ihn mit
            # includeServerName:false ab (electron/fehlerberichte.js, „Rechnername ist PII");
            # das SDK füllt hier sonst socket.gethostname() in JEDES Ereignis (gemessen am
            # Stub-Transport: 'workstation' reiste unmaskiert, Fund beider Reviewer).
            include_local_variables=False,
            max_breadcrumbs=0,
            before_breadcrumb=lambda crumb, hint: None,
            auto_session_tracking=False,  # Sitzungen wären Installations-Zählung
            send_client_reports=False,  # Verwerfungs-Zähler: bei AUS verlässt KEIN Byte die
            # Maschine — gemessen am Sammler meldete das SDK sonst einen 186-Byte-Umschlag
            # (client_report) trotz before_send-Verwurf; die Electron-Hälfte mass 0
            # (Marcus, 2026-09-09).
            default_integrations=False,
            integrations=[
                DedupeIntegration(), ExcepthookIntegration(), AtexitIntegration(),
                ThreadingIntegration(), AsyncioIntegration(), StarletteIntegration(),
            ],
            before_send=before_send,
        )
        _aktiv = True
        if env.get("TRANSKRIBOR_FEHLERPROBE") == "1":
            sentry_sdk.capture_exception(Exception(FEHLERPROBE))
            sentry_sdk.flush(10000)
        return True
    except Exception as fehler:  # noqa: BLE001 — der Vertrag ist: nie werfen
        print(f"[fehlerberichte] init gescheitert: {type(fehler).__name__}",
              file=sys.stderr, flush=True)
        return False
