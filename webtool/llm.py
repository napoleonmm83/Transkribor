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
import subprocess
import tempfile
import urllib.error
import urllib.request

from . import paths
from . import settings

TIMEOUT = 900          # s pro Aufruf; gleiche Groessenordnung wie der CLI-Weg
MAX_TOKENS = 32000     # Korrektur-Bloecke sind gross; bei Anthropic zaehlt Denken mit hinein

# Ein Eintrag je Anbieter. `shape` waehlt den HTTP-Dialekt — mehr als diese zwei gibt es in der
# Praxis nicht: fast alle Anbieter (Groq, Mistral, DeepSeek, xAI, Ollama, LM Studio) sprechen
# den OpenAI-Dialekt, und wer nicht in der Liste steht, kommt ueber "custom" mit eigener URL rein.
#
# `models` gibt es nur bei den Abo-CLIs, und zwar als ALIASE. Fragen kann man sie nicht:
# weder `claude` noch `codex` kennt einen Befehl, der Modelle auflistet, und die Fehlermeldung
# eines ungueltigen Modells zaehlt auch keine auf (beides geprueft). Aliase sind hier aber
# genau das Richtige statt eine Notloesung: 'opus' zeigt immer auf die neueste
# Opus-Generation, weil Anthropic den Zeiger umbiegt. Eine Liste konkreter Modell-IDs waere
# in drei Monaten falsch — diese hier bleibt richtig. Leeres Modell heisst bei beiden CLIs
# "nimm deine eigene Voreinstellung", darum ist es kein Pflichtfeld.
PROVIDERS = {
    "claude-cli": {"label": "Claude Code Abo (kein Key)", "shape": "cli", "needs_key": False,
                   "bin": "claude", "models": ["opus", "sonnet", "haiku", "fable"],
                   "default_model": "opus",
                   "hint": "Nutzt das angemeldete Claude-Code-Abo auf diesem Rechner."},
    "codex-cli": {"label": "ChatGPT-Abo (Codex CLI, kein Key)", "shape": "codex",
                  "needs_key": False, "bin": "codex",
                  "models": ["gpt-4o", "gpt-4o-mini", "o3-mini", "o1", "o1-mini", "gpt-4.5-preview"],
                  "default_model": "gpt-4o",
                  "hint": "Nutzt das angemeldete ChatGPT-Abo auf diesem Rechner "
                          "(einmalig `codex login`)."},
    "anthropic": {"label": "Anthropic (Claude)", "shape": "anthropic", "needs_key": True,
                  "base": "https://api.anthropic.com/v1", "default_model": "claude-opus-5",
                  "models": ["claude-opus-5", "claude-3-7-sonnet-latest", "claude-3-5-sonnet-latest", "claude-3-5-haiku-latest"],
                  "keys_url": "https://console.anthropic.com/settings/keys"},
    "openai": {"label": "OpenAI", "shape": "openai", "needs_key": True,
               "base": "https://api.openai.com/v1",
               "default_model": "gpt-4o",
               "models": ["gpt-4o", "gpt-4o-mini", "o3-mini", "o1", "o1-mini", "gpt-4-turbo"],
               "keys_url": "https://platform.openai.com/api-keys"},
    "google": {"label": "Google (Gemini)", "shape": "openai", "needs_key": True,
               "base": "https://generativelanguage.googleapis.com/v1beta/openai",
               "default_model": "gemini-flash-latest",
               "models": ["gemini-flash-latest", "gemini-1.5-pro-latest", "gemini-2.0-flash", "gemini-2.0-pro-exp-02-05"],
               "keys_url": "https://aistudio.google.com/apikey"},
    "openrouter": {"label": "OpenRouter (viele Modelle, ein Key)", "shape": "openai", "needs_key": True,
                   "base": "https://openrouter.ai/api/v1",
                   "default_model": "anthropic/claude-3.5-sonnet",
                   "models": ["anthropic/claude-3.5-sonnet", "openai/gpt-4o", "google/gemini-2.0-flash-001", "deepseek/deepseek-chat"],
                   "keys_url": "https://openrouter.ai/keys"},
    "custom": {"label": "Anderer (OpenAI-kompatibel)", "shape": "openai", "needs_key": False,
               "base": "", "hint": "Eigene Basis-URL, z.B. http://localhost:11434/v1 (Ollama) "
                                   "oder ein anderer OpenAI-kompatibler Dienst."},
}

# Die Gemini-CLI fehlt hier ABSICHTLICH als Abo. Sie ist installierbar und kann headless
# (`gemini -p`), aber ihr Abo-Zugang ist fuer Einzelpersonen abgeschaltet: sie antwortet mit
# `IneligibleTierError: This client is no longer supported for Gemini Code Assist for
# individuals`. Gemessen, nicht vermutet — auch mit gesetztem GEMINI_CLI_TRUST_WORKSPACE.
# Das ist eine PRODUKTENTSCHEIDUNG, kein Kontoproblem: die Meldung verweist selbst auf die
# Ablösung durch Antigravity (https://antigravity.google). Wer den Fehler sieht, braucht
# also weder seine Anmeldung zu reparieren noch spaeter erneut zu probieren.
# Nebenbefund fuer den Fall, dass Google das je zurueckdreht: `--approval-mode plan`
# (Lesemodus) wird in einem nicht vertrauten Ordner STILL auf "default" herabgestuft. Wer
# gemini hier aufnimmt, muss den Lesemodus also nachpruefen statt ihn anzunehmen.
# Als API-Anbieter mit eigenem Key bleibt Gemini oben unter "google" unveraendert nutzbar.


class LLMError(RuntimeError):
    """Anbieterseitiger Fehler in nutzerlesbarer Form (Netz, Key, Modell, Kontingent)."""


def provider_list() -> list:
    # Ohne `models`: die Liste holt das Frontend ueber /api/settings/models — egal ob sie
    # live vom Anbieter kommt oder aus den Aliasen oben. Sie hier ZUSAETZLICH mitzuschicken
    # waere ein zweiter Weg zu denselben Daten und damit eine zweite Wahrheit.
    # `cli` statt `shape`: die Oberflaeche muss wissen, ob es hier ein Key-Feld braucht —
    # nicht, welchen HTTP-Dialekt der Anbieter spricht. Den Dialektnamen nach aussen zu
    # geben hiesse, eine interne Entscheidung zur API-Zusage zu machen.
    return [{"id": pid, "label": p["label"], "needs_key": p["needs_key"],
             "cli": p["shape"] in ("cli", "codex"),
             "base": p.get("base", ""), "default_model": p.get("default_model", ""),
             "keys_url": p.get("keys_url", ""), "hint": p.get("hint", "")}
            for pid, p in PROVIDERS.items()]


def _cfg(cfg: dict | None = None) -> tuple:
    """Einstellungen + Anbieter-Steckbrief. `cfg` uebergeben heisst „nimm DIESEN Stand".

    Gebraucht wird das von `app._settings_body`: dort steht der gerade geschriebene Snapshot
    schon fest, und ihn NICHT durchzureichen erzeugte eine Antwort mit zwei Wahrheiten —
    `provider` aus dem eigenen Schreibvorgang, `ai_reason` aus dem eines gleichzeitigen
    Konkurrenten. Der Nutzer laese dann „Anbieter: Anthropic" neben „claude ist auf diesem
    Rechner nicht installiert" (CodeRabbit-Bot an PR #248, Major).
    """
    cfg = cfg if cfg is not None else settings.load()
    p = PROVIDERS.get(cfg["provider"]) or PROVIDERS["claude-cli"]
    return cfg, p


def use_api() -> bool:
    """True, sobald ein anderer Anbieter als das Abo eingestellt ist. Bewusst KEIN stiller
    Rueckfall auf das Abo, wenn der Key fehlt: wer einen Anbieter einstellt, soll den
    Konfigurationsfehler sehen und nicht heimlich etwas anderes bekommen."""
    return _cfg()[1]["shape"] != "cli"


# Kurzlebiger Cache fuer `available()`s ABO-Zweig (#250). Gemessen: ein GET /api/settings
# zahlt auf dem Poll-Pfad der Einstellungsseite 274 ms (claude-cli), und ein pip-Lauf von
# 340 s bedeutet 226 Spawn-Vorgaenge — 62 s Prozessarbeit fuer eine Auskunft, die sich in
# dieser Zeit praktisch nie aendert. Der Cache sitzt BEWUSST hier und nicht in auth.status:
# available() beantwortet die FAEHIGKEIT ("kann korrigiert werden"), auth.status den
# LIVE-Zustand (Anmeldeblock, Testknopf, und der Login misst an auth.py:219 seinen eigenen
# Erfolg — kein einziger dieser Wege darf je einen gecachten Wert sehen, also cachen wir sie
# gar nicht erst). Schluessel ist der Anbieter; ein Wechsel greift damit ohne Neustart.
# Zugriffe sind GIL-atomar genug: das Schlimmste unter Nebenlaeufigkeit ist ein doppelter
# Subprozess, kein falscher Wert.
_VERFUEGBAR_CACHE: dict[str, tuple[float, tuple]] = {}
_VERFUEGBAR_TTL = 5.0


def verfuegbar_vergessen() -> None:
    """Cache leeren — nach einer Anmeldung. `available()` kann sonst bis zur TTL lang
    „nicht angemeldet" sagen, obwohl der Anmeldeblock daneben bereits Erfolg meldet; die
    Warnleiste „Korrektur nicht moeglich" stünde dann sichtbar neben einer gelungenen
    Anmeldung. Ebenso nach einem Abbruch-Vorgang, der den Zustand angefasst haben koennte."""
    _VERFUEGBAR_CACHE.clear()


def available(cfg: dict | None = None) -> tuple:
    """(nutzbar, Begruendung) — prueft die FAEHIGKEIT zu korrigieren, nicht die Absicht.

    Ein frisch installierter Nutzer hat "claude-cli" als Voreinstellung und kein
    claude-Binary. Ohne diese Pruefung startet nach jedem Upload automatisch eine
    Korrektur, die scheitert — das waere der erste Eindruck der App. Ueber die
    Faehigkeit statt ueber einen anderen Default zu gehen erspart eine Migration:
    wer claude installiert hat, merkt nichts.

    `cfg` uebergeben heisst „beurteile DIESEN Stand" — siehe `_cfg`. Ohne den Parameter las
    diese Funktion die Datei neu, und eine Einstellungs-Antwort trug zwei Wahrheiten.
    """
    cfg, prov = _cfg(cfg)
    if prov["shape"] in ("cli", "codex"):
        if not _exe(prov):
            return False, f"{prov['label']}: '{prov['bin']}' ist auf diesem Rechner nicht installiert."
        # Installiert heisst nicht angemeldet. Vorher meldete die App hier gruen, und die
        # Auto-Korrektur startete einen Lauf, der am Login scheiterte — genau das, was diese
        # Funktion verhindern soll. Die Abfrage kostet 0,09s (codex) bzw. 0,27s (claude),
        # gemessen; ein abgebrochener Korrekturlauf kostet Minuten. #250 kommt der
        # Abo-Zweig aus dem kurzlebigen Cache — die 274 ms zahlt nur die erste Anfrage je
        # TTL-Fenster, nicht mehr jede Poll-Runde.
        from . import auth        # lazy: auth importiert llm, ein Modulimport waere zirkulaer
        import time as _t
        schluessel = cfg["provider"]
        jetzt = _t.monotonic()
        getroffen = _VERFUEGBAR_CACHE.get(schluessel)
        if getroffen and jetzt - getroffen[0] < _VERFUEGBAR_TTL:
            ergebnis = getroffen[1]
        else:
            st = auth.status(schluessel)
            ergebnis = (False, f"{prov['label']}: nicht angemeldet — in den Einstellungen anmelden.")                 if st["unterstuetzt"] and not st["angemeldet"] else (True, "")
            _VERFUEGBAR_CACHE[schluessel] = (jetzt, ergebnis)
        return ergebnis
    if prov["needs_key"] and not cfg["api_key"]:
        return False, f"Kein API-Key fuer {prov['label']} hinterlegt."
    if not _base_url(cfg, prov):
        return False, "Keine Basis-URL eingestellt."
    if not cfg["model"]:
        return False, "Kein Modell ausgewaehlt."
    return True, ""


def _exe(prov: dict) -> str:
    """Pfad zur CLI des Anbieters, oder "". `.cmd` mitpruefen: npm-Installationen legen unter
    Windows einen Shim mit dieser Endung ab, den `which` ohne Endung nicht findet."""
    name = prov.get("bin", "")
    return (shutil.which(name) or shutil.which(name + ".cmd")) if name else ""


def _run_codex(cfg: dict, prov: dict, prompt: str) -> str:
    """Eine Runde gegen das ChatGPT-Abo ueber `codex exec`. Liefert den Antworttext.

    **`--sandbox read-only` ist Pflicht, nicht Vorsicht.** Im Prompt steht Transkripttext,
    der aus einem URL-Import stammen kann — also aus einer Quelle, die dem Nutzer nicht
    gehoert. Eine Injektion darf hoechstens Unsinn ANTWORTEN, niemals Dateien anfassen.
    Werkzeuge braucht dieser Weg ohnehin nicht: die Eingaben stehen dank `_with_files`
    vollstaendig im Prompt, geschrieben wird die Datei hier.

    **`--ignore-user-config` ist dieselbe Regel wie `--strict-mcp-config` beim claude-Weg:**
    die persoenliche `~/.codex/config.toml` bringt MCP-Server, eigene Anbieter und eigene
    Instruktionen mit — nichts davon hat in einem Lauf zu suchen, der fremden Transkripttext
    verarbeitet. Die Anmeldung bleibt davon unberuehrt (sie haengt an `CODEX_HOME`, nicht an
    der config.toml), E2E nachgeprueft.

    **`-o` statt die Konsolenausgabe zu lesen:** `codex exec` druckt seinen Sitzungsverlauf
    mit, und darin steht der PROMPT im Klartext. `parse_json` sucht von der ersten `{` bis
    zur letzten `}` und griffe quer durch dieses Echo. `-o` schreibt ausschliesslich die
    Schlussantwort.

    Der Prompt kommt ueber stdin (`-`), nicht als Argument: mit eingebetteten Transkripten
    sprengt er unter Windows das Laengenlimit der Kommandozeile — dieselbe Regel wie bei
    `correct._run_claude`.
    """
    exe = _exe(prov)
    if not exe:
        raise LLMError(f"{prov['label']}: '{prov['bin']}' ist nicht auf dem PATH")
    with tempfile.TemporaryDirectory() as tmp:
        ziel = os.path.join(tmp, "antwort.txt")
        cmd = [exe, "exec", "--sandbox", "read-only", "--skip-git-repo-check",
               "--ignore-user-config", "-o", ziel]
        if cfg["model"]:
            cmd += ["-m", cfg["model"]]
        cmd.append("-")
        try:
            p = subprocess.run(cmd, input=prompt, capture_output=True, text=True,
                               encoding="utf-8", errors="replace", timeout=TIMEOUT)
        except subprocess.TimeoutExpired:
            raise LLMError(f"{prov['label']} hat nach {TIMEOUT}s nicht geantwortet") from None
        except OSError as e:
            raise LLMError(f"{prov['label']} liess sich nicht starten: {e}") from None
        try:
            with open(ziel, encoding="utf-8") as fh:
                antwort = fh.read().strip()
        except (OSError, ValueError):
            # ValueError deckt auch UnicodeDecodeError (#190): die Antwortdatei schreibt ein
            # FREMDES Binaerprogramm. Ungefangen entkaeme er als roher ValueError durch
            # `complete()`/`check()` bis in den Handler, der nur `LLMError` faengt — also
            # 500 auf der Einstellungsseite statt der Meldung "keine Antwort erhalten".
            antwort = ""
    if not antwort:
        # Der Exitcode allein taugt nicht: `codex exec` endet auch nach einem gescheiterten
        # Login mit 0. Die fehlende Antwortdatei ist das verlaessliche Signal.
        spur = (p.stderr or p.stdout or "").strip()[-400:]
        raise LLMError(f"{prov['label']} lieferte keine Antwort (Exitcode {p.returncode}). "
                       f"{spur or 'Angemeldet? Einmalig `codex login` ausfuehren.'}")
    return antwort


def _base_url(cfg: dict, prov: dict) -> str:
    return (cfg["base_url"] or prov.get("base", "")).rstrip("/")


def _ssl_kontext():
    """CA-Bundle fuer HTTP-Anfragen an API-Anbieter (Anthropic, OpenAI, Google etc.).

    Von python.org installiertes Python nutzt auf macOS NICHT die System-Keychain,
    sondern ein eigenes Bundle, das ohne den Schritt "Install Certificates.command"
    fehlt. urlopen scheitert dort mit CERTIFICATE_VERIFY_FAILED — und genau so ein
    Python legt electron/setup.js in der venv an (#385).
    """
    try:
        import certifi
        import ssl
    except ImportError:
        return None
    return ssl.create_default_context(cafile=certifi.where())


def _request(url: str, headers: dict, body=None, timeout: int = 60):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers,
                                 method="POST" if data else "GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_ssl_kontext()) as r:
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
    # Der Abo-Weg ueber eine CLI hat weder URL noch Key noch Pflichtmodell — die Pruefungen
    # darunter gelten nur den HTTP-Anbietern.
    if prov["shape"] == "codex":
        return _run_codex(cfg, prov, prompt)
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
    if prov["shape"] in ("cli", "codex"):
        # Die Aliase aus PROVIDERS — es gibt keine Quelle, die man fragen koennte (siehe
        # den Kommentar dort).
        return [{"id": m, "label": m} for m in prov.get("models", ())]
    base = _base_url(cfg, prov)
    if not base:
        raise LLMError("Keine Basis-URL eingestellt")
    if prov["needs_key"] and not cfg["api_key"]:
        raise LLMError(f"Kein API-Key fuer {prov['label']} hinterlegt")
    try:
        r = _request(f"{base}/models", _headers(cfg, prov), None, 30)
        out = []
        for m in (r.get("data") or []):
            mid = m.get("id")
            if not mid:
                continue
            # OpenAI / generische OpenAI-Dialekte: Ausschluss von Embeddings / Whisper / TTS
            if prov.get("shape") == "openai" and "openai.com" in base:
                mid_low = mid.lower()
                if not re.match(r"^(gpt-|o\d|chatgpt)", mid_low):
                    continue
                if any(x in mid_low for x in ("audio", "realtime", "transcription", "tts", "search", "embedding", "instruct")):
                    continue
            out.append({"id": mid, "label": m.get("display_name") or mid})
        if out:
            return sorted(out, key=lambda m: m["id"])
    except Exception:
        models = prov.get("models", ())
        if models:
            return [{"id": m, "label": m} for m in models]
        raise
    return [{"id": m, "label": m} for m in prov.get("models", ())]


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
        except (OSError, ValueError) as e:     # ValueError deckt auch UnicodeDecodeError (#190)
            raise LLMError(f"Eingabedatei nicht lesbar: {p} ({type(e).__name__}: {e})") from None
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
    if prov["shape"] in ("cli", "codex"):
        # Erst das Naheliegende fragen. Ohne das rannte der Testknopf bei abgemeldetem Codex
        # in den echten Aufruf und legte dem Nutzer ein rohes "401 Unauthorized: Missing
        # bearer … cf-ray: …" vor — richtig, aber unbrauchbar: die Antwort darauf ist
        # "anmelden", und genau die stand nicht da.
        ok, grund = available()
        if not ok:
            return {"ok": False, "detail": grund}
        if prov["shape"] == "cli":
            # Fuer claude bleibt es dabei: ein echter `claude -p`-Testlauf kostet ~8s
            # Startzeit plus Kontingent und beweist nichts, was der Anmeldezustand nicht
            # schon sagt.
            return {"ok": True, "detail": f"{prov['label']} · {auth_detail()}"}
    # Fuer codex laeuft hier bewusst ein ECHTER Aufruf durch: anders als bei claude sagt die
    # blosse Anwesenheit des Binaers nichts ueber die Anmeldung, und ein nicht angemeldetes
    # `codex exec` scheitert erst mitten im ersten Korrekturlauf.
    antwort = complete("Antworte exakt mit dem JSON {\"ok\": true} und sonst nichts.")
    return {"ok": bool(parse_json(antwort).get("ok", True)),
            "detail": f"{prov['label']} · {cfg['model'] or 'Voreinstellung'} antwortet"}


def auth_detail() -> str:
    """Einzeiler zum Anmeldezustand des eingestellten Anbieters, oder "" wenn es dort keinen
    gibt. Lazy importiert, weil auth seinerseits llm braucht."""
    from . import auth
    return auth.status(settings.load()["provider"])["detail"]


def env_key_hint() -> str:
    """Bereits gesetzte Umgebungsvariable als Vorschlag (einmal-Einrichtung leichter machen)."""
    for name in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"):
        if os.environ.get(name):
            return name
    return ""


def _has_status(text: str, code: str) -> bool:
    """Prüft auf echte HTTP-/Statuscodes (z. B. 'HTTP 404', 'Status 404', isoliert '404'),
    verhindert aber Fehlmatches bei IDs wie 'req_4042' oder 'doc_401'."""
    return bool(re.search(rf"(?<![a-zA-Z0-9_]){code}(?![a-zA-Z0-9_])", text))


def diagnose_fehler(fehler: str | Exception) -> dict:
    """Klassifiziert einen Fehler bei der LLM-Korrektur und liefert verständliche
    Diagnose- und Hilfetexte für den Benutzer.

    Rückgabe:
        {"kategorie": "ratelimit"|"quota"|"auth"|"model"|"network"|"timeout"|"unbekannt",
         "titel": str, "hinweis": str, "kurz": str}
    """
    text = str(fehler or "").strip()
    low = text.lower()

    # 1. Guthaben erschöpft (Payment / Quota) — vor 429 prüfen, da OpenAI 429 für insufficient_quota nutzt
    if (
        _has_status(text, "402")
        or "insufficient_quota" in low
        or "out of credits" in low
        or "payment required" in low
        or "credit balance" in low
        or "guthaben" in low
        or "plan and billing" in low
    ):
        return {
            "kategorie": "quota",
            "titel": "Guthaben aufgebraucht",
            "hinweis": "Das Guthaben für diesen API-Schlüssel ist erschöpft. Bitte beim Anbieter aufladen.",
            "kurz": "Guthaben aufgebraucht: Bitte beim Anbieter aufladen",
        }

    # 2. Rate-Limit / Kontingent-Limit
    if (
        _has_status(text, "429")
        or "rate_limit" in low
        or "ratelimit" in low
        or "rate limit" in low
        or "resource_exhausted" in low
        or "too many requests" in low
        or "usage limit" in low
        or "quota exceeded" in low
        or "anfrage-limit" in low
    ):
        return {
            "kategorie": "ratelimit",
            "titel": "Anfrage-Limit erreicht (Rate Limit)",
            "hinweis": "Der Anbieter bittet um eine kurze Pause. Bitte in 1–2 Minuten erneut auf „Korrigieren“ klicken.",
            "kurz": "Anfrage-Limit erreicht: Bitte 1–2 Min. warten",
        }

    # 3. Authentifizierung / API-Key
    if (
        _has_status(text, "401")
        or "invalid api key" in low
        or "invalid_api_key" in low
        or "unauthorized" in low
        or "authentication" in low
        or "authenticate" in low
        or "not logged in" in low
        or "please log in" in low
        or "login required" in low
        or "kein api-key" in low
        or "nicht angemeldet" in low
        or "codex login" in low
        or "claude login" in low
        or "oauth" in low
    ):
        return {
            "kategorie": "auth",
            "titel": "Anmeldung / API-Schlüssel ungültig",
            "hinweis": "Der API-Schlüssel ist ungültig oder die CLI-Sitzung ist abgelaufen. Bitte in den Einstellungen prüfen.",
            "kurz": "API-Schlüssel ungültig oder nicht angemeldet",
        }

    # 4. Modell nicht verfügbar / veraltet
    if (
        _has_status(text, "404")
        or "model_not_found" in low
        or "no longer available" in low
        or "kein modell" in low
        or ("not found" in low and ("model" in low or _has_status(text, "404")))
    ):
        return {
            "kategorie": "model",
            "titel": "Modell nicht verfügbar",
            "hinweis": "Das gewählte Modell wird vom Anbieter nicht mehr unterstützt. Bitte in den Einstellungen ein anderes Modell wählen.",
            "kurz": "Modell nicht verfügbar: Bitte in den Einstellungen ändern",
        }

    # 5. Netzwerk & SSL
    if (
        "ssl" in low
        or "certificate_verify_failed" in low
        or "connection refused" in low
        or "name or service not known" in low
        or "getaddrinfo failed" in low
        or "kein netz" in low
        or "kein kontakt" in low
    ):
        return {
            "kategorie": "network",
            "titel": "Keine Verbindung zum Anbieter",
            "hinweis": "Der Server konnte nicht erreicht werden. Bitte Internetverbindung prüfen.",
            "kurz": "Keine Verbindung zum Anbieter",
        }

    # 6. Timeout
    if (
        "timeout" in low
        or "timed out" in low
        or "hat nach" in low
        or "zeitüberschreitung" in low
    ):
        return {
            "kategorie": "timeout",
            "titel": "Zeitüberschreitung (Timeout)",
            "hinweis": "Der Anbieter hat nicht rechtzeitig geantwortet. Bitte erneut versuchen.",
            "kurz": "Zeitüberschreitung beim Anbieter",
        }

    # 7. Unbekannt / Fallback
    return {
        "kategorie": "unbekannt",
        "titel": "Fehler bei der KI-Korrektur",
        "hinweis": text or "Unbekannter Fehler beim Aufruf des Sprachmodells.",
        "kurz": text or "Unbekannter Fehler",
    }
