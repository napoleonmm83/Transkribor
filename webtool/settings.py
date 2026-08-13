"""Nutzer-Einstellungen (KI-Anbieter, Modell, API-Key).

Liegt bewusst NICHT im Repo, sondern im Nutzerprofil (%APPDATA%\\Transkribor): der Key hat in
einem git-Verzeichnis nichts verloren, und die Einstellung ueberlebt so ein neues Checkout.
Gelesen wird bei jedem Zugriff frisch — genau wie die Env-Variablen. Damit greift ein Wechsel
im Browser sofort, ohne uvicorn neu zu starten.

Der Key verlaesst dieses Modul nie ungefragt: `public()` liefert die Einstellungen fuers
Frontend mit `has_key` statt dem Schluessel selbst.
"""
import json
import os

from . import paths


# Alle Namen, die faster-whisper akzeptiert (identisch zu denen von openai-whisper — sie
# werden auf `Systran/faster-whisper-<name>` abgebildet). Ein handverdrehtes "base" soll
# funktionieren, ein vertipptes "larg-v3" aber nicht erst beim Modell-Laden auffallen.
KNOWN_WHISPER_MODELS = (
    "tiny.en", "tiny", "base.en", "base", "small.en", "small", "medium.en", "medium",
    "large-v1", "large-v2", "large-v3", "large", "large-v3-turbo", "turbo",
)

# Was die Einstellungsseite anbietet. Die .en-Varianten sind fuer deutschsprachige
# Interviews sinnlos, large-v1/v2 sind von v3 ueberholt — 14 Namen zur Auswahl zu
# stellen hiesse, dem Nutzer eine Recherche aufzuhalsen.
WHISPER_CHOICES = (
    {"id": "tiny", "label": "Sehr schnell", "hint": "grobe Fehler, nur zum Ausprobieren"},
    {"id": "small", "label": "Schnell", "hint": "brauchbar bei klarem Hochdeutsch"},
    {"id": "medium", "label": "Ausgewogen", "hint": ""},
    # Umlaute: die ASCII-Konvention dieses Repos gilt Kommentaren, nicht der Oberflaeche.
    # Diese Werte stehen als Text im Auswahlmenue; "Qualitaet" las dort jeder Nutzer mit.
    {"id": "turbo", "label": "Schnell und gut", "hint": "nahe large-Qualität, deutlich schneller"},
    {"id": "large-v3", "label": "Beste Qualität", "hint": "langsamste, bester Dialekt"},
)


def env_path() -> str:
    """Pfad der `.env`. TRANSKRIBOR_ENV, weil die gepackte App ihre Datei in `userData`
    hat — neben der .exe liegt sie nie (Program Files ist schreibgeschuetzt)."""
    return os.environ.get("TRANSKRIBOR_ENV") or os.path.join(paths.ROOT, ".env")


def load_env() -> list:
    """`.env` (KEY=VALUE je Zeile, `#` = Kommentar) nach os.environ. Gibt die gesetzten
    Namen zurueck (fuers Protokoll). Eine fehlende Datei ist der Normalfall, kein Fehler.

    Lag vorher doppelt in webtool.ps1 und electron/backend.js — zwei Parser in zwei
    Sprachen fuer dieselbe Datei, und wer uvicorn von Hand startete, bekam sie gar nicht.
    Die Datei gewinnt gegen eine bereits gesetzte Variable: genau das taten beide Launcher
    (webtool.ps1 setzte unbedingt, backend.js legte die .env ueber die geerbte Umgebung).
    """
    gesetzt = []
    try:
        with open(env_path(), encoding="utf-8-sig") as fh:
            zeilen = fh.readlines()
    except OSError:
        return gesetzt
    for zeile in zeilen:
        t = zeile.strip()
        if not t or t.startswith("#") or "=" not in t:
            continue
        k, v = t.split("=", 1)                      # nur beim ERSTEN =, Werte duerfen welche enthalten
        k = k.strip()
        if k:
            os.environ[k] = v.strip().strip('"').strip("'")
            gesetzt.append(k)
    return gesetzt


def path() -> str:
    override = os.environ.get("TRANSKRIBOR_SETTINGS")
    if override:
        return override
    if os.name == "nt":
        base = os.environ.get("APPDATA") or os.path.expanduser("~")
    else:
        base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(base, "Transkribor", "settings.json")


DEFAULTS = {"provider": "claude-cli", "model": "", "base_url": "", "api_key": "",
            # Kein hf_token mehr: die Diarisierung laedt ihr Modell aus models/ statt von
            # Hugging Face. Ein in einer alten settings.json verbliebener Token faellt beim
            # naechsten load() heraus (der Filter kennt nur DEFAULTS) — keine Migration noetig.
            # Whisper-Stufe und -Sprache. large-v3/de ist das bisherige Verhalten —
            # eine Verhaltensaenderung fuer Bestandsnutzer waere unnoetig.
            "whisper_model": "large-v3", "whisper_lang": "de",
            # yt-dlp-Selbstaktualisierung: Schalter + Merker der letzten Pruefung (ISO-Datum).
            # STRINGS, nicht bool/date — `save()` filtert auf isinstance(str) und wuerde alles
            # andere still verwerfen (dieselbe Falle wie `mehrsprachig` in projekt.py).
            "ytdlp_auto": "1", "ytdlp_geprueft": ""}


def load() -> dict:
    """Einstellungen inkl. Key. Fehlend/kaputt -> Defaults (Abo-Modus), nie ein Fehler:
    eine unlesbare Einstellungsdatei darf die Transkription nicht blockieren."""
    try:
        with open(path(), encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return dict(DEFAULTS)
    if not isinstance(data, dict):
        return dict(DEFAULTS)
    cfg = {**DEFAULTS, **{k: v for k, v in data.items()
                          if k in DEFAULTS and isinstance(v, str)}}
    if cfg["whisper_model"] not in KNOWN_WHISPER_MODELS:
        cfg["whisper_model"] = DEFAULTS["whisper_model"]
    return cfg


def save(patch: dict) -> dict:
    """Merge-Speichern. Ein fehlendes 'api_key' laesst den gespeicherten Key stehen — das
    Frontend bekommt ihn nie zu sehen und koennte ihn sonst beim Modellwechsel loeschen."""
    cur = load()
    for k in DEFAULTS:
        if k in patch and isinstance(patch[k], str):
            cur[k] = patch[k].strip()
    p = path()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(cur, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, p)
    try:                       # nur der Besitzer darf lesen; auf Windows no-op, dort schuetzt das Profil
        os.chmod(p, 0o600)
    except OSError:
        pass
    return cur


def public(cfg: dict = None) -> dict:
    """Fuers Frontend: alles ausser den Geheimnissen."""
    cfg = cfg if cfg is not None else load()
    return {"provider": cfg["provider"], "model": cfg["model"],
            "base_url": cfg["base_url"], "has_key": bool(cfg["api_key"]),
            "whisper_model": cfg["whisper_model"], "whisper_lang": cfg["whisper_lang"],
            # Der gespeicherte Wert, nicht der wirksame: der Haken im Browser soll zeigen,
            # was IN der Datei steht. Ob eine Env-Variable ihn ueberstimmt, sagt
            # `ytdlp_update.zustand()["auto"]` — das Frontend vergleicht beides.
            "ytdlp_auto": cfg["ytdlp_auto"]}


def job_env() -> dict:
    """Was die Job-Subprozesse aus den Einstellungen brauchen. Eine echte Umgebungsvariable
    gewinnt immer — wer WHISPER_MODEL gesetzt hat (webtool.ps1 aus der .env, CI), soll sie
    behalten."""
    cfg = load()
    paare = (("WHISPER_MODEL", "whisper_model"), ("WHISPER_LANG", "whisper_lang"))
    return {env: cfg[key] for env, key in paare
            if cfg[key] and not os.environ.get(env)}
