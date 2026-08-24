import json
import pytest
from webtool import llm, settings


@pytest.fixture(autouse=True)
def _cache_leeren():
    """`available()`s kurzlebiger Cache (#250) ueberdauert Tests — ohne das Leeren
    spezifisch die Nachbarreihen: `test_available_abo_mit_claude_binary` cacht (True, "")
    fuer den Anbieter, und `test_available_abo_installiert_aber_nicht_angemeldet` kaeme
    damit nie dazu, seinen eigenen (gefälschten) Status zu lesen. Der Cache gehoert zum
    Modul, nicht zur Test-Instanz; autouse, weil KEIN available-Test ihn mitbringen darf."""
    llm.verfuegbar_vergessen()
    yield
    llm.verfuegbar_vergessen()


@pytest.fixture
def cfg(monkeypatch, tmp_path):
    """Einstellungen ins tmp_path — nie die echte Datei des Entwicklers anfassen."""
    monkeypatch.setenv("TRANSKRIBOR_SETTINGS", str(tmp_path / "settings.json"))
    monkeypatch.setenv("TRANSKRIBOR_PROJEKTE", str(tmp_path / "projekte"))
    monkeypatch.setenv("TRANSKRIBOR_YTDLP_UPDATE", "0")
    # Isoliere auch Whisper-Umgebungsvariablen, sonst sind die Tests nichtdeterministisch
    # auf einer Maschine, wo .env oder die Shell diese setzen.
    for name in ("WHISPER_MODEL", "WHISPER_LANG"):
        monkeypatch.delenv(name, raising=False)
    return tmp_path


def _antwort(monkeypatch, payload, gesehen=None):
    def fake(url, headers, body=None, timeout=60):
        if gesehen is not None:
            gesehen.update(url=url, headers=headers, body=body)
        return payload
    monkeypatch.setattr(llm, "_request", fake)


# --- Einstellungen -----------------------------------------------------------

def test_defaults_ohne_datei(cfg):
    assert settings.load()["provider"] == "claude-cli"
    assert settings.public()["has_key"] is False
    assert llm.use_api() is False


def test_save_merge_behaelt_key(cfg):
    settings.save({"provider": "anthropic", "model": "claude-opus-5", "api_key": "sk-geheim"})
    # Modellwechsel ohne api_key im Patch darf den Key NICHT loeschen (das Frontend kennt ihn nicht)
    settings.save({"model": "claude-sonnet-5"})
    s = settings.load()
    assert s["api_key"] == "sk-geheim" and s["model"] == "claude-sonnet-5"


def test_public_verraet_den_key_nicht(cfg):
    settings.save({"provider": "openai", "api_key": "sk-geheim"})
    pub = settings.public()
    assert pub["has_key"] is True
    assert "sk-geheim" not in json.dumps(pub)


def test_kaputte_datei_faellt_auf_abo_zurueck(cfg):
    (cfg / "settings.json").write_text("{kein json", encoding="utf-8")
    assert settings.load()["provider"] == "claude-cli"   # Transkription darf daran nicht scheitern


# --- JSON aus Modellantworten ------------------------------------------------

@pytest.mark.parametrize("text", [
    '{"a": 1}',
    '```json\n{"a": 1}\n```',
    '```\n{"a": 1}\n```',
    'Hier ist das Ergebnis:\n{"a": 1}\nFertig.',
])
def test_parse_json_ueberlebt_verpackung(text):
    assert llm.parse_json(text) == {"a": 1}


def test_parse_json_ohne_json_meldet_fehler():
    with pytest.raises(llm.LLMError):
        llm.parse_json("Tut mir leid, das kann ich nicht.")


# --- HTTP-Dialekte -----------------------------------------------------------

def test_anthropic_shape(cfg, monkeypatch):
    settings.save({"provider": "anthropic", "model": "claude-opus-5", "api_key": "sk-a"})
    gesehen = {}
    _antwort(monkeypatch, {"content": [{"type": "text", "text": '{"ok": true}'}]}, gesehen)
    assert llm.complete("hallo") == '{"ok": true}'
    assert gesehen["url"] == "https://api.anthropic.com/v1/messages"
    assert gesehen["headers"]["x-api-key"] == "sk-a"
    assert gesehen["headers"]["anthropic-version"] == "2023-06-01"
    assert gesehen["body"]["model"] == "claude-opus-5"


def test_anthropic_refusal_wird_zum_fehler(cfg, monkeypatch):
    settings.save({"provider": "anthropic", "model": "claude-opus-5", "api_key": "sk-a"})
    _antwort(monkeypatch, {"stop_reason": "refusal", "content": []})
    with pytest.raises(llm.LLMError, match="abgelehnt"):
        llm.complete("hallo")


def test_openai_shape_mit_bearer(cfg, monkeypatch):
    settings.save({"provider": "openai", "model": "gpt-test", "api_key": "sk-o"})
    gesehen = {}
    _antwort(monkeypatch, {"choices": [{"message": {"content": "hi"}}]}, gesehen)
    assert llm.complete("hallo") == "hi"
    assert gesehen["url"] == "https://api.openai.com/v1/chat/completions"
    assert gesehen["headers"]["authorization"] == "Bearer sk-o"


def test_custom_base_url_gewinnt(cfg, monkeypatch):
    settings.save({"provider": "custom", "model": "llama", "base_url": "http://localhost:11434/v1/"})
    gesehen = {}
    _antwort(monkeypatch, {"choices": [{"message": {"content": "hi"}}]}, gesehen)
    llm.complete("hallo")
    assert gesehen["url"] == "http://localhost:11434/v1/chat/completions"
    assert "authorization" not in gesehen["headers"]      # lokaler Server braucht keinen Key


def test_fehlender_key_meldet_sich_statt_still_zu_scheitern(cfg):
    settings.save({"provider": "anthropic", "model": "claude-opus-5"})
    assert llm.use_api() is True          # KEIN stiller Rueckfall aufs Abo
    with pytest.raises(llm.LLMError, match="Kein API-Key"):
        llm.complete("hallo")


def test_fehlendes_modell_meldet_sich(cfg):
    settings.save({"provider": "anthropic", "api_key": "sk-a"})
    with pytest.raises(llm.LLMError, match="Kein Modell"):
        llm.complete("hallo")


def test_list_models_beide_dialekte(cfg, monkeypatch):
    settings.save({"provider": "anthropic", "model": "m", "api_key": "sk-a"})
    _antwort(monkeypatch, {"data": [{"id": "b"}, {"id": "a", "display_name": "A"}]})
    assert llm.list_models() == [{"id": "a", "label": "A"}, {"id": "b", "label": "b"}]


# --- Datei rein, Datei raus --------------------------------------------------

def test_complete_to_file_legt_eingaben_in_den_prompt(cfg, monkeypatch, tmp_path):
    settings.save({"provider": "openai", "model": "m", "api_key": "sk-o"})
    quelle = tmp_path / "roh.txt"
    quelle.write_text("[0] Hallo Welt", encoding="utf-8")
    ziel = tmp_path / "out.json"
    gesehen = {}
    _antwort(monkeypatch, {"choices": [{"message": {"content": '```json\n{"segments": [1]}\n```'}}]}, gesehen)

    llm.complete_to_file("Korrigiere das.", [str(quelle)], str(ziel))

    prompt = gesehen["body"]["messages"][0]["content"]
    assert "[0] Hallo Welt" in prompt          # Inhalt statt Read-Tool
    assert "KEINE Werkzeuge" in prompt
    assert json.loads(ziel.read_text(encoding="utf-8")) == {"segments": [1]}


def test_complete_to_file_schreibt_bei_muell_nichts(cfg, monkeypatch, tmp_path):
    """Halb geschriebene correction.json wuerde der naechste Lauf als 'fertig' durchwinken."""
    settings.save({"provider": "openai", "model": "m", "api_key": "sk-o"})
    quelle = tmp_path / "roh.txt"; quelle.write_text("x", encoding="utf-8")
    ziel = tmp_path / "out.json"
    _antwort(monkeypatch, {"choices": [{"message": {"content": "Kann ich nicht."}}]})
    with pytest.raises(llm.LLMError):
        llm.complete_to_file("p", [str(quelle)], str(ziel))
    assert not ziel.exists()


# --- Verfuegbarkeit (available) -----------------------------------------------

def test_available_abo_ohne_claude_binary(monkeypatch, tmp_path):
    """Der Erstnutzer-Fall: claude-cli ist Default, claude ist nicht installiert."""
    monkeypatch.setenv("TRANSKRIBOR_SETTINGS", str(tmp_path / "s.json"))
    monkeypatch.setattr(llm.shutil, "which", lambda n: None)
    ok, grund = llm.available()
    assert ok is False
    assert "Claude Code" in grund


def _anmeldung(monkeypatch, angemeldet: bool):
    """Anmeldezustand vortaeuschen, ohne die echte CLI zu befragen."""
    from webtool import auth
    monkeypatch.setattr(auth, "status", lambda p: {
        "unterstuetzt": True, "angemeldet": angemeldet,
        "detail": "Angemeldet." if angemeldet else "Nicht angemeldet."})


def test_available_abo_mit_claude_binary(monkeypatch, tmp_path):
    monkeypatch.setenv("TRANSKRIBOR_SETTINGS", str(tmp_path / "s.json"))
    monkeypatch.setattr(llm.shutil, "which", lambda n: "C:/claude.cmd")
    _anmeldung(monkeypatch, True)
    assert llm.available() == (True, "")


def test_available_abo_installiert_aber_nicht_angemeldet(monkeypatch, tmp_path):
    """Vorher meldete das gruen, und die Auto-Korrektur startete einen Lauf, der am Login
    scheiterte — genau das soll available() verhindern."""
    monkeypatch.setenv("TRANSKRIBOR_SETTINGS", str(tmp_path / "s.json"))
    monkeypatch.setattr(llm.shutil, "which", lambda n: "C:/claude.cmd")
    _anmeldung(monkeypatch, False)
    ok, grund = llm.available()
    assert ok is False and "nicht angemeldet" in grund


def test_available_cacht_den_abo_zweig_kurzlebig(monkeypatch, tmp_path):
    """#250: der 1,5-s-Poll der Einstellungsseite startete je GET einen Subprozess (274 ms,
    gemessen; 226 Spawn-Vorgaenge in einem 340-s-pip-Lauf). Innerhalb der TTL liest der
    Abo-Zweig jetzt aus dem Cache — gemessen an den auth.status-AUFRUFEN, nicht an der Uhr:
    die Zahl ist die Zusicherung, eine Dauer waere eine Nebenschauplatz."""
    monkeypatch.setenv("TRANSKRIBOR_SETTINGS", str(tmp_path / "s.json"))
    monkeypatch.setattr(llm.shutil, "which", lambda n: "C:/claude.cmd")
    aufrufe = []
    from webtool import auth
    monkeypatch.setattr(auth, "status", lambda p: aufrufe.append(p) or {
        "unterstuetzt": True, "angemeldet": True, "detail": "Angemeldet."})
    assert llm.available() == (True, "")
    assert llm.available() == (True, "")            # aus dem Cache …
    assert llm.available() == (True, "")            # … auch ein drittes Mal
    assert aufrufe == ["claude-cli"]                # EIN Subprozess, nicht drei

    # Nach der TTL wird wieder gemessen — gefälschte Uhr, kein Sleep. Die echte Zeit wird
    # VOR dem Patch eingefangen: die Lambda haette sich sonst selbst aufgerufen (die
    # Rekursion sah man erst im Lauf — gruen waere der Test auch ohne die Zeile darunter).
    import time as _echt
    _jetzt = _echt.monotonic()
    monkeypatch.setattr(_echt, "monotonic", lambda: _jetzt + llm._VERFUEGBAR_TTL + 1)
    llm.available()
    assert aufrufe == ["claude-cli", "claude-cli"]

    # Und das Vergessen ist der sofortige Rueckweg — nach einer Anmeldung darf der Cache
    # nicht bis zur TTL „nicht angemeldet" weitererzaehlen (Invalidierung in auth.py).
    llm.verfuegbar_vergessen()
    llm.available()
    assert aufrufe == ["claude-cli", "claude-cli", "claude-cli"]


def test_available_cacht_den_abo_zweig_NICHT_über_anbieter_hinweg(monkeypatch, tmp_path):
    """Der Schluessel ist der Anbieter — ein Wechsel greift ohne Neustart, heisst es in der
    Doku. Ohne den Schluessel waere die Zusicherung gelogen: der zweite Anbieter erbte den
    ersten Status und die Einstellungsseite zeigte ihn als angemeldet, obwohl niemand je
    `codex login` laufen liess."""
    monkeypatch.setenv("TRANSKRIBOR_SETTINGS", str(tmp_path / "s.json"))
    monkeypatch.setattr(llm.shutil, "which", lambda n: "C:/claude.cmd")
    from webtool import auth
    monkeypatch.setattr(auth, "status", lambda p: {
        "unterstuetzt": True, "angemeldet": p == "claude-cli", "detail": ""})
    assert llm.available() == (True, "")            # claude-cli: angemeldet, gecacht
    settings.save({"provider": "codex"})
    ok, grund = llm.available()                      # codex: anderer Schluessel …
    assert ok is False and "nicht angemeldet" in grund   # … NICHT das gecacht (True, "")


def test_available_api_ohne_key(monkeypatch, tmp_path):
    monkeypatch.setenv("TRANSKRIBOR_SETTINGS", str(tmp_path / "s.json"))
    settings.save({"provider": "openai", "model": "gpt-4o"})
    ok, grund = llm.available()
    assert ok is False and "API-Key" in grund


def test_available_api_ohne_modell(monkeypatch, tmp_path):
    monkeypatch.setenv("TRANSKRIBOR_SETTINGS", str(tmp_path / "s.json"))
    settings.save({"provider": "openai", "api_key": "sk-x", "model": ""})
    ok, grund = llm.available()
    assert ok is False and "Modell" in grund


def test_available_api_vollstaendig(monkeypatch, tmp_path):
    monkeypatch.setenv("TRANSKRIBOR_SETTINGS", str(tmp_path / "s.json"))
    settings.save({"provider": "openai", "api_key": "sk-x", "model": "gpt-4o"})
    assert llm.available() == (True, "")


def test_available_custom_ohne_basis_url(monkeypatch, tmp_path):
    monkeypatch.setenv("TRANSKRIBOR_SETTINGS", str(tmp_path / "s.json"))
    settings.save({"provider": "custom", "model": "llama3", "base_url": ""})
    ok, grund = llm.available()
    assert ok is False and "Basis-URL" in grund


# --- Abo-CLIs: Claude-Aliase und Codex ----------------------------------------

def _codex(monkeypatch, tmp_path, *, antwort=None, rc=0, stderr=""):
    """Faengt den codex-Aufruf ab. Liefert das gesehene argv zurueck und schreibt
    `antwort` in die Datei hinter `-o` — genau wie es das echte `codex exec` tut."""
    monkeypatch.setattr(llm.shutil, "which", lambda n: "C:/fake/codex" if "codex" in n else None)
    gesehen = {}

    class Fertig:
        returncode = rc
        stdout = ""

    def fake_run(cmd, **kw):
        gesehen.update(cmd=cmd, input=kw.get("input"))
        if antwort is not None:
            with open(cmd[cmd.index("-o") + 1], "w", encoding="utf-8") as fh:
                fh.write(antwort)
        f = Fertig()
        f.stderr = stderr
        return f

    monkeypatch.setattr(llm.subprocess, "run", fake_run)
    return gesehen


def test_codex_laeuft_nur_im_lesemodus(cfg, monkeypatch):
    """Der wichtigste Test der Datei: in den Prompt wandert Transkripttext, der aus einem
    URL-Import stammen kann. Faellt `--sandbox read-only` je aus dem Aufruf, darf das nicht
    still passieren — eine Injektion haette sonst Schreibzugriff."""
    settings.save({"provider": "codex-cli", "model": ""})
    gesehen = _codex(monkeypatch, cfg, antwort='{"ok": true}')
    assert llm.complete("hallo") == '{"ok": true}'
    cmd = gesehen["cmd"]
    assert cmd[1] == "exec"
    assert "--sandbox" in cmd and cmd[cmd.index("--sandbox") + 1] == "read-only"
    assert "--dangerously-bypass-approvals-and-sandbox" not in cmd
    # Dieselbe Regel wie `--strict-mcp-config` beim claude-Weg: die persoenliche
    # ~/.codex/config.toml bringt MCP-Server und eigene Instruktionen mit, die in einem Lauf
    # ueber fremden Transkripttext nichts zu suchen haben.
    assert "--ignore-user-config" in cmd


def test_codex_prompt_geht_ueber_stdin(cfg, monkeypatch):
    """Mit eingebetteten Transkripten sprengt der Prompt das Windows-Laengenlimit der
    Kommandozeile — er darf also nicht als Argument auftauchen."""
    settings.save({"provider": "codex-cli", "model": ""})
    gross = "x" * 40000
    gesehen = _codex(monkeypatch, cfg, antwort="ok")
    llm.complete(gross)
    assert gesehen["input"] == gross
    assert gesehen["cmd"][-1] == "-"
    assert not any(gross in teil for teil in gesehen["cmd"])


def test_codex_ohne_modell_laesst_die_cli_entscheiden(cfg, monkeypatch):
    settings.save({"provider": "codex-cli", "model": ""})
    gesehen = _codex(monkeypatch, cfg, antwort="ok")
    llm.complete("hi")
    assert "-m" not in gesehen["cmd"]


def test_codex_mit_modell_reicht_es_durch(cfg, monkeypatch):
    settings.save({"provider": "codex-cli", "model": "gpt-5"})
    gesehen = _codex(monkeypatch, cfg, antwort="ok")
    llm.complete("hi")
    assert gesehen["cmd"][gesehen["cmd"].index("-m") + 1] == "gpt-5"


def test_codex_ohne_antwort_meldet_sich_trotz_exitcode_null(cfg, monkeypatch):
    """`codex exec` endet auch nach gescheitertem Login mit 0 — die fehlende Antwortdatei
    ist das verlaessliche Signal, nicht der Exitcode."""
    settings.save({"provider": "codex-cli", "model": ""})
    _codex(monkeypatch, cfg, antwort=None, rc=0, stderr="not logged in")
    with pytest.raises(llm.LLMError) as e:
        llm.complete("hi")
    assert "not logged in" in str(e.value)


def test_codex_ohne_binaer_ist_nicht_nutzbar(cfg, monkeypatch):
    settings.save({"provider": "codex-cli", "model": ""})
    monkeypatch.setattr(llm.shutil, "which", lambda n: None)
    ok, grund = llm.available()
    assert ok is False and "codex" in grund


def test_abo_modelle_sind_aliase_ohne_netz(cfg, monkeypatch):
    """Fuer die Abo-CLIs gibt es keine Liste zu holen — es darf also auch keine HTTP-Anfrage
    versucht werden."""
    def platzt(*a, **k):
        raise AssertionError("kein HTTP fuer eine Abo-CLI")
    monkeypatch.setattr(llm, "_request", platzt)
    settings.save({"provider": "claude-cli"})
    assert [m["id"] for m in llm.list_models()] == ["opus", "sonnet", "haiku", "fable"]
    settings.save({"provider": "codex-cli"})
    assert llm.list_models() == []


def test_provider_list_nennt_die_abo_clis(cfg):
    nach_id = {p["id"]: p for p in llm.provider_list()}
    assert nach_id["claude-cli"]["cli"] is True and nach_id["claude-cli"]["needs_key"] is False
    assert nach_id["codex-cli"]["cli"] is True
    assert nach_id["anthropic"]["cli"] is False
    # Gemini bleibt als API-Anbieter, aber NICHT als Abo — der CLI-Zugang ist fuer
    # Einzelpersonen abgeschaltet (IneligibleTierError).
    assert "gemini-cli" not in nach_id and nach_id["google"]["cli"] is False


def test_check_meldet_die_fehlende_anmeldung_statt_eines_rohen_401(cfg, monkeypatch):
    """Gemeldet wurde beim Testknopf: `401 Unauthorized: Missing bearer … cf-ray: …`.
    Technisch richtig und unbrauchbar — die Antwort darauf ist "anmelden", und genau die
    stand nicht da. check() fragt jetzt zuerst available()."""
    settings.save({"provider": "codex-cli", "model": ""})
    monkeypatch.setattr(llm.shutil, "which", lambda n: "C:/fake/codex")
    _anmeldung(monkeypatch, False)

    def platzt(*a, **k):
        raise AssertionError("check() darf bei fehlender Anmeldung gar nicht erst aufrufen")
    monkeypatch.setattr(llm, "_run_codex", platzt)

    r = llm.check()
    assert r["ok"] is False and "nicht angemeldet" in r["detail"]
    assert "cf-ray" not in r["detail"]


# --- #190: nicht dekodierbare Bytes sind KEIN JSONDecodeError ----------------

def test_nicht_dekodierbare_codex_antwort_wird_zur_llmerror(cfg, monkeypatch):
    """Die Antwortdatei schreibt ein FREMDES Binaerprogramm. Der Rueckfall fing nur
    `OSError`; ein `UnicodeDecodeError` entkam als roher `ValueError` durch `complete()`
    und `check()` bis in den Handler, der nur `LLMError` faengt — also 500 auf der
    Einstellungsseite statt der Meldung "keine Antwort erhalten" (#190)."""
    settings.save({"provider": "codex-cli", "model": ""})
    monkeypatch.setattr(llm.shutil, "which", lambda n: "C:/fake/codex" if "codex" in n else None)

    class Fertig:
        returncode = 0
        stdout = ""
        stderr = ""

    def fake_run(cmd, **kw):
        with open(cmd[cmd.index("-o") + 1], "wb") as fh:
            fh.write(b"\xe9 keine gueltige UTF-8-Antwort")
        return Fertig()

    monkeypatch.setattr(llm.subprocess, "run", fake_run)
    with pytest.raises(llm.LLMError):        # NICHT UnicodeDecodeError
        llm.complete("hallo")


def test_nicht_dekodierbare_eingabedatei_wird_zur_llmerror(tmp_path):
    """`_with_files` verspricht "Eingabedatei nicht lesbar -> saubere Anbietermeldung".
    Fuer die haeufigste Unlesbarkeit galt das nicht (#190)."""
    p = tmp_path / "S1.tagged.txt"
    p.write_bytes(b"Interview mit Gr\xfcnder")     # ANSI/CP1252
    with pytest.raises(llm.LLMError) as e:
        llm._with_files("prompt", [str(p)])
    assert "UnicodeDecodeError" in str(e.value)


# --- SSL-Kontext & Google-Provider (#385) ------------------------------------

def test_ssl_kontext_nutzt_certifi(monkeypatch):
    import ssl
    import sys
    aufrufe = {}

    class FakeCertifi:
        @staticmethod
        def where():
            aufrufe["where"] = aufrufe.get("where", 0) + 1
            return "/pfad/zu/fake-ca.pem"

    fake_ctx = object()

    def fake_create_default_context(cafile=None):
        aufrufe["cafile"] = cafile
        return fake_ctx

    monkeypatch.setitem(sys.modules, "certifi", FakeCertifi)
    monkeypatch.setattr(ssl, "create_default_context", fake_create_default_context)

    ctx = llm._ssl_kontext()
    assert ctx is fake_ctx
    assert aufrufe["where"] == 1
    assert aufrufe["cafile"] == "/pfad/zu/fake-ca.pem"


def test_ssl_kontext_ohne_certifi_faellt_auf_die_vorgabe(monkeypatch):
    import sys
    monkeypatch.setitem(sys.modules, "certifi", None)
    assert llm._ssl_kontext() is None


def test_request_uebergibt_ssl_kontext(monkeypatch):
    gesehen = {}
    fake_kontext = object()
    monkeypatch.setattr(llm, "_ssl_kontext", lambda: fake_kontext)

    class DummyResponse:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def read(self):
            return b'{"ok": true}'

    def fake_urlopen(req, timeout=60, context=None):
        gesehen["context"] = context
        return DummyResponse()

    monkeypatch.setattr(llm.urllib.request, "urlopen", fake_urlopen)
    res = llm._request("https://example.com/api", {"header": "val"})
    assert res == {"ok": True}
    assert gesehen["context"] is fake_kontext


def test_google_provider_hat_default_model():
    nach_id = {p["id"]: p for p in llm.provider_list()}
    assert nach_id["google"]["default_model"] == "gemini-flash-latest"


def test_env_key_hint_erkennt_google_api_key(monkeypatch):
    for k in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("GOOGLE_API_KEY", "AIzaSyTest")
    assert llm.env_key_hint() == "GOOGLE_API_KEY"


# --- Fehlerdiagnostik & Limit-Erkennung ---------------------------------------

def test_diagnose_fehler_erkennt_ratelimit():
    # HTTP 429
    d1 = llm.diagnose_fehler("HTTP 429 von https://api.openai.com/v1/chat/completions: Rate limit reached")
    assert d1["kategorie"] == "ratelimit"
    assert "Limit" in d1["titel"]
    assert "Pause" in d1["hinweis"]

    # Google RESOURCE_EXHAUSTED
    d2 = llm.diagnose_fehler("HTTP 429: Quota exceeded for quota metric 'Generate Content API requests'")
    assert d2["kategorie"] == "ratelimit"

    # Claude CLI / Codex CLI
    d3 = llm.diagnose_fehler("You've reached your usage limit until 3:00 PM")
    assert d3["kategorie"] == "ratelimit"

    d4 = llm.diagnose_fehler("Rate limit reached for default model")
    assert d4["kategorie"] == "ratelimit"


def test_diagnose_fehler_erkennt_guthaben_leer():
    # HTTP 402 / insufficient_quota
    d1 = llm.diagnose_fehler("HTTP 402: Payment Required (Out of credits)")
    assert d1["kategorie"] == "quota"
    assert "Guthaben" in d1["titel"]
    assert "aufladen" in d1["hinweis"]

    d2 = llm.diagnose_fehler("You exceeded your current quota, please check your plan and billing details (insufficient_quota)")
    assert d2["kategorie"] == "quota"


def test_diagnose_fehler_erkennt_auth_fehler():
    d1 = llm.diagnose_fehler("HTTP 401 von https://api.anthropic.com: Invalid API Key")
    assert d1["kategorie"] == "auth"
    assert "Schlüssel" in d1["titel"] or "Anmeldung" in d1["titel"]

    d2 = llm.diagnose_fehler("Kein API-Key fuer Google (Gemini) hinterlegt")
    assert d2["kategorie"] == "auth"

    d3 = llm.diagnose_fehler("Angemeldet? Einmalig `codex login` ausfuehren.")
    assert d3["kategorie"] == "auth"


def test_diagnose_fehler_erkennt_modell_fehler():
    d1 = llm.diagnose_fehler("HTTP 404: models/gemini-1.5-flash is no longer available to new users")
    assert d1["kategorie"] == "model"
    assert "Modell" in d1["titel"]

    d2 = llm.diagnose_fehler("Kein Modell ausgewaehlt")
    assert d2["kategorie"] == "model"


def test_diagnose_fehler_erkennt_netzwerk_und_ssl():
    d1 = llm.diagnose_fehler("[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed")
    assert d1["kategorie"] == "network"
    assert "Verbindung" in d1["titel"]

    d2 = llm.diagnose_fehler("Kein Kontakt zu https://generativelanguage.googleapis.com: Connection refused")
    assert d2["kategorie"] == "network"


def test_diagnose_fehler_erkennt_timeout():
    d = llm.diagnose_fehler("Claude Code Abo hat nach 1800s nicht geantwortet")
    assert d["kategorie"] == "timeout"
    assert "Timeout" in d["titel"] or "Zeitüberschreitung" in d["titel"]


