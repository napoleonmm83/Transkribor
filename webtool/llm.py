"""Ein LLM-Aufruf — ueber das Claude-Code-Abo oder ueber einen API-Key.

Die beiden Welten unterscheiden sich darin, WER die Dateien anfasst:

- Abo (`claude-cli`): headless `claude -p` liest die Eingaben und schreibt das Ergebnis mit
  seinen Read/Write-Tools SELBST. Der Prompt nennt nur Pfade.
- API-Key: dort gibt es keine Werkzeuge. Also legen wir die Eingabedateien in den Prompt und
  schreiben die Antwort hier weg.

Deshalb nimmt `complete_to_file` Ein- und Ausgabe als Pfade: nur so kann derselbe Aufrufer
(correct.py) beide Welten bedienen, ohne seine Prompts zu verdoppeln.

Kein SDK, kein neues Paket: die Anbieter sprechen zwei HTTP-Dialekte (Anthropic und
OpenAI-kompatibel), und fuer zwei JSON-Formen lohnt keine Abhaengigkeit — urllib reicht.
Das haelt auch den Auto-Installer klein, der sonst pro Anbieter ein SDK mitschleppen muesste.
"""
import json
import os
import re
import shutil
import urllib.error
import urllib.request

from . import paths
from . import settings

TIMEOUT = 900          # s pro Aufruf; gleiche Groessenordnung wie der CLI-Weg
MAX_TOKENS = 32000     # Korrektur-Bloecke sind gross; bei Anthropic zaehlt Denken mit hinein

# Ein Eintrag je Anbieter. `shape` waehlt den HTTP-Dialekt — mehr als diese zwei gibt es in der
# Praxis nicht: fast alle Anbieter (Groq, Mistral, DeepSeek, xAI, Ollama, LM Studio) sprechen
# den OpenAI-Dialekt, und wer nicht in der Liste steht, kommt ueber "custom" mit eigener URL rein.
PROVIDERS = {
    "claude-cli": {"label": "Claude Code Abo (kein Key)", "shape": "cli", "needs_key": False,
                   "hint": "Nutzt das angemeldete Claude-Code-Abo auf diesem Rechner."},
    "anthropic": {"label": "Anthropic (Claude)", "shape": "anthropic", "needs_key": True,
                  "base": "https://api.anthropic.com/v1", "default_model": "claude-opus-5",
                  "keys_url": "https://console.anthropic.com/settings/keys"},
    "openai": {"label": "OpenAI", "shape": "openai", "needs_key": True,
               "base": "https://api.openai.com/v1",
               "keys_url": "https://platform.openai.com/api-keys"},
    "google": {"label": "Google (Gemini)", "shape": "openai", "needs_key": True,
               "base": "https://generativelanguage.googleapis.com/v1beta/openai",
               "keys_url": "https://aistudio.google.com/apikey"},
    "openrouter": {"label": "OpenRouter (viele Modelle, ein Key)", "shape": "openai", "needs_key": True,
                   "base": "https://openrouter.ai/api/v1",
                   "keys_url": "https://openrouter.ai/keys"},
    "custom": {"label": "Anderer (OpenAI-kompatibel)", "shape": "openai", "needs_key": False,
               "base": "", "hint": "Eigene Basis-URL, z.B. http://localhost:11434/v1 (Ollama) "
                                   "oder ein anderer OpenAI-kompatibler Dienst."},
}


class LLMError(RuntimeError):
    """Anbieterseitiger Fehler in nutzerlesbarer Form (Netz, Key, Modell, Kontingent)."""


def provider_list() -> list:
    return [{"id": pid, "label": p["label"], "needs_key": p["needs_key"],
             "base": p.get("base", ""), "default_model": p.get("default_model", ""),
             "keys_url": p.get("keys_url", ""), "hint": p.get("hint", "")}
            for pid, p in PROVIDERS.items()]


def _cfg() -> tuple:
    cfg = settings.load()
    p = PROVIDERS.get(cfg["provider"]) or PROVIDERS["claude-cli"]
    return cfg, p


def use_api() -> bool:
    """True, sobald ein anderer Anbieter als das Abo eingestellt ist. Bewusst KEIN stiller
    Rueckfall auf das Abo, wenn der Key fehlt: wer einen Anbieter einstellt, soll den
    Konfigurationsfehler sehen und nicht heimlich etwas anderes bekommen."""
    return _cfg()[1]["shape"] != "cli"


def available() -> tuple:
    """(nutzbar, Begruendung) — prueft die FAEHIGKEIT zu korrigieren, nicht die Absicht.

    Ein frisch installierter Nutzer hat "claude-cli" als Voreinstellung und kein
    claude-Binary. Ohne diese Pruefung startet nach jedem Upload automatisch eine
    Korrektur, die scheitert — das waere der erste Eindruck der App. Ueber die
    Faehigkeit statt ueber einen anderen Default zu gehen erspart eine Migration:
    wer claude installiert hat, merkt nichts.
    """
    cfg, prov = _cfg()
    if prov["shape"] == "cli":
        if shutil.which("claude"):
            return True, ""
        return False, "Claude Code ist auf diesem Rechner nicht installiert."
    if prov["needs_key"] and not cfg["api_key"]:
        return False, f"Kein API-Key fuer {prov['label']} hinterlegt."
    if not _base_url(cfg, prov):
        return False, "Keine Basis-URL eingestellt."
    if not cfg["model"]:
        return False, "Kein Modell ausgewaehlt."
    return True, ""


def _base_url(cfg: dict, prov: dict) -> str:
    return (cfg["base_url"] or prov.get("base", "")).rstrip("/")


def _request(url: str, headers: dict, body=None, timeout: int = 60):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers,
                                 method="POST" if data else "GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:400] if e.fp else ""
        raise LLMError(f"HTTP {e.code} von {url}: {detail or e.reason}") from None
    except urllib.error.URLError as e:
        raise LLMError(f"Kein Kontakt zu {url}: {e.reason}") from None
    except (TimeoutError, json.JSONDecodeError) as e:
        raise LLMError(f"Ungueltige Antwort von {url}: {e}") from None


def _headers(cfg: dict, prov: dict) -> dict:
    h = {"content-type": "application/json"}
    if prov["shape"] == "anthropic":
        h["x-api-key"] = cfg["api_key"]
        h["anthropic-version"] = "2023-06-01"
    elif cfg["api_key"]:
        h["authorization"] = f"Bearer {cfg['api_key']}"
    return h


def complete(prompt: str) -> str:
    """Eine Runde gegen den eingestellten API-Anbieter. Liefert den Antworttext."""
    cfg, prov = _cfg()
    base = _base_url(cfg, prov)
    if not base:
        raise LLMError("Keine Basis-URL eingestellt")
    if prov["needs_key"] and not cfg["api_key"]:
        raise LLMError(f"Kein API-Key fuer {prov['label']} hinterlegt")
    if not cfg["model"]:
        raise LLMError("Kein Modell ausgewaehlt")
    msg = [{"role": "user", "content": prompt}]
    if prov["shape"] == "anthropic":
        r = _request(f"{base}/messages", _headers(cfg, prov),
                     {"model": cfg["model"], "max_tokens": MAX_TOKENS, "messages": msg}, TIMEOUT)
        if r.get("stop_reason") == "refusal":
            raise LLMError("Anbieter hat die Anfrage abgelehnt (Sicherheitsfilter)")
        return "".join(b.get("text", "") for b in (r.get("content") or [])
                       if b.get("type") == "text")
    # ponytail: kein max_tokens im OpenAI-Dialekt — neuere Modelle wollen max_completion_tokens,
    # aeltere max_tokens, und der Default des Anbieters reicht fuer unsere Bloecke.
    r = _request(f"{base}/chat/completions", _headers(cfg, prov),
                 {"model": cfg["model"], "messages": msg}, TIMEOUT)
    choices = r.get("choices") or []
    if not choices:
        raise LLMError(f"Antwort ohne Inhalt: {str(r)[:200]}")
    return (choices[0].get("message") or {}).get("content") or ""


def list_models() -> list:
    """Modelle des eingestellten Anbieters (beide Dialekte kennen GET /models). Eine feste
    Liste im Code waere nach dem naechsten Modellwechsel falsch — lieber live fragen."""
    cfg, prov = _cfg()
    if prov["shape"] == "cli":
        return []
    base = _base_url(cfg, prov)
    if not base:
        raise LLMError("Keine Basis-URL eingestellt")
    if prov["needs_key"] and not cfg["api_key"]:
        raise LLMError(f"Kein API-Key fuer {prov['label']} hinterlegt")
    r = _request(f"{base}/models", _headers(cfg, prov), None, 30)
    out = []
    for m in (r.get("data") or []):
        mid = m.get("id")
        if mid:
            out.append({"id": mid, "label": m.get("display_name") or mid})
    return sorted(out, key=lambda m: m["id"])


_FENCE = re.compile(r"^\s*```(?:json)?\s*|\s*```\s*$")


def parse_json(text: str) -> dict:
    """JSON aus einer Modellantwort. Modelle verpacken es gern in ```-Zaeune oder schreiben
    einen Satz davor — beides hier abfangen, statt es in jeden Prompt zu schreiben."""
    t = _FENCE.sub("", (text or "").strip())
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        pass
    a, b = t.find("{"), t.rfind("}")
    if a == -1 or b <= a:
        raise LLMError(f"Keine JSON-Antwort erhalten: {t[:200]!r}")
    try:
        return json.loads(t[a:b + 1])
    except json.JSONDecodeError as e:
        raise LLMError(f"JSON-Antwort nicht lesbar: {e}") from None


def _with_files(prompt: str, inputs) -> str:
    teile = [prompt, "\n\n--- DATEIEN (Volltext, im Prompt statt per Werkzeug) ---"]
    for p in inputs:
        try:
            with open(p, encoding="utf-8") as fh:
                inhalt = fh.read()
        except OSError as e:
            raise LLMError(f"Eingabedatei nicht lesbar: {p} ({e})") from None
        teile.append(f"\n=== {p} ===\n{inhalt}")
    teile.append("\n--- ENDE DATEIEN ---\n\nWICHTIG: Du hast KEINE Werkzeuge. Ignoriere die "
                 "Anweisungen zum Read-/Write-Tool: die Dateien stehen oben im Volltext, und "
                 "statt zu schreiben antwortest du AUSSCHLIESSLICH mit dem JSON-Objekt — kein "
                 "Markdown, kein Text davor oder danach.")
    return "".join(teile)


def complete_to_file(prompt: str, inputs, output: str) -> None:
    """Der API-Gegenpart zu `claude -p`: Eingaben in den Prompt, Antwort nach `output`.
    Geschrieben wird nur gueltiges JSON — eine halbe Datei wuerde der naechste Lauf als
    'schon erledigt' durchwinken."""
    doc = parse_json(complete(_with_files(prompt, inputs)))
    paths.atomic_write(output, json.dumps(doc, ensure_ascii=False, indent=1))


def check() -> dict:
    """Kurzer Verbindungstest fuer die Einstellungsseite."""
    cfg, prov = _cfg()
    if prov["shape"] == "cli":
        import shutil
        exe = shutil.which("claude") or shutil.which("claude.cmd")
        return {"ok": bool(exe), "detail": exe or "claude CLI nicht auf PATH (Abo-Modus braucht "
                                                 "eine Claude-Code-Installation)"}
    antwort = complete("Antworte exakt mit dem JSON {\"ok\": true} und sonst nichts.")
    return {"ok": bool(parse_json(antwort).get("ok", True)),
            "detail": f"{prov['label']} · {cfg['model']} antwortet"}


def env_key_hint() -> str:
    """Bereits gesetzte Umgebungsvariable als Vorschlag (einmal-Einrichtung leichter machen)."""
    for name in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY"):
        if os.environ.get(name):
            return name
    return ""
