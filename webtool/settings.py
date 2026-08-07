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


def path() -> str:
    override = os.environ.get("TRANSKRIBOR_SETTINGS")
    if override:
        return override
    if os.name == "nt":
        base = os.environ.get("APPDATA") or os.path.expanduser("~")
    else:
        base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(base, "Transkribor", "settings.json")


DEFAULTS = {"provider": "claude-cli", "model": "", "base_url": "", "api_key": ""}


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
    return {**DEFAULTS, **{k: v for k, v in data.items() if k in DEFAULTS and isinstance(v, str)}}


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
    """Fuers Frontend: alles ausser dem Key."""
    cfg = cfg if cfg is not None else load()
    return {"provider": cfg["provider"], "model": cfg["model"],
            "base_url": cfg["base_url"], "has_key": bool(cfg["api_key"])}
