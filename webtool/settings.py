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


# Alle Namen, die whisper.load_model akzeptiert. Ein handverdrehtes "base" soll
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
            # Sprecher-Diarisierung (pyannote). Lag bisher nur in der .env, die ausschliesslich
            # webtool.ps1 laedt — in der Desktop-App gibt es die nicht, und ohne Token faellt die
            # Diarisierung still aus ("Sprecher nicht erkannt", ohne Hinweis).
            "hf_token": "",
            # Whisper-Stufe und -Sprache. large-v3/de ist das bisherige Verhalten —
            # eine Verhaltensaenderung fuer Bestandsnutzer waere unnoetig.
            "whisper_model": "large-v3", "whisper_lang": "de"}


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
            "has_hf_token": bool(cfg["hf_token"]),
            "whisper_model": cfg["whisper_model"], "whisper_lang": cfg["whisper_lang"]}


def job_env() -> dict:
    """Was die Job-Subprozesse aus den Einstellungen brauchen. Eine echte Umgebungsvariable
    gewinnt immer — wer HF_TOKEN oder WHISPER_MODEL gesetzt hat (webtool.ps1 aus der .env,
    CI), soll sie behalten."""
    cfg = load()
    paare = (("HF_TOKEN", "hf_token"), ("WHISPER_MODEL", "whisper_model"),
             ("WHISPER_LANG", "whisper_lang"))
    return {env: cfg[key] for env, key in paare
            if cfg[key] and not os.environ.get(env)}
