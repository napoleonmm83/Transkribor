# Startet den Transkribor-Editor lokal und öffnet den Browser.
$py = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"

# Die .env (git-ignoriert, Vorlage .env.example) laedt der Server selbst — siehe
# webtool/settings.py:load_env(). Sie hier nochmal zu parsen hiesse, denselben Parser in
# zwei Sprachen zu pflegen.

$index = Join-Path $PSScriptRoot "webtool\static\index.html"
if (-not (Test-Path $index)) {
  Write-Host "Frontend-Build fehlt — baue (npm)..."
  npm --prefix (Join-Path $PSScriptRoot "webtool\frontend") install
  # Vorbestehend ungeprueft, hier mitgenommen: dieselbe Fehlerklasse und derselbe
  # Mechanismus wie unten (PowerShell wertet den Rueckgabewert eines externen Befehls
  # nicht aus) — eine Zeile weiter oben. Ohne die Pruefung lief nach einem
  # gescheiterten `install` der Bau trotzdem an und meldete Folgefehler, die nach etwas
  # ganz anderem aussehen. Kein `Remove-Item` noetig: ohne Bau gibt es keine
  # `index.html`, wir stehen ja gerade im Zweig „sie fehlt".
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  npm --prefix (Join-Path $PSScriptRoot "webtool\frontend") run build
  # ZWEI Dinge, und die zweite ist die wichtigere.
  #
  # (1) PowerShell wertet den Rueckgabewert eines externen Befehls nicht von selbst aus —
  #     ohne die Pruefung lief der Waechter aus `build` zwar, hielt hier aber NICHTS auf:
  #     Browser und uvicorn starteten, und ihre Ausgabe schob seine Meldung weg.
  #
  # (2) `index.html` muss WEG, sonst wirkt der Abbruch nur ein einziges Mal. `vite build`
  #     schreibt `webtool\static\` vollstaendig, BEVOR der Waechter dahinter laeuft —
  #     gemessen: nach einem Bau mit rc=1 liegt die Datei da (481 Byte). Die Bedingung
  #     oben ueberspraenge den Bau beim naechsten Start also ganz, und der Server fuehre
  #     genau das Frontend aus, das eben durchgefallen ist.
  #     Damit ist die Zusage von oben wiederhergestellt: ein gescheiterter Bau
  #     hinterlaesst keine `index.html`. Vor diesem Waechter galt sie von selbst — `tsc`
  #     rot heisst kein `vite`, und `vite` schreibt erst nach dem Buendeln. Der Waechter
  #     ist die erste Ausfallart, bei der der Bau MATERIELL gelingt und nur der
  #     Rueckgabewert rot ist.
  if ($LASTEXITCODE -ne 0) {
    $bauFehler = $LASTEXITCODE
    Remove-Item -LiteralPath $index -Force -ErrorAction SilentlyContinue
    exit $bauFehler
  }
}
Start-Process "http://127.0.0.1:8000/"
& $py -m uvicorn webtool.app:app --host 127.0.0.1 --port 8000
