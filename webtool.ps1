# Startet den Transkribor-Editor lokal und öffnet den Browser.
$py = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
$index = Join-Path $PSScriptRoot "webtool\static\index.html"
if (-not (Test-Path $index)) {
  Write-Host "Frontend-Build fehlt — baue (npm)..."
  npm --prefix (Join-Path $PSScriptRoot "webtool\frontend") install
  npm --prefix (Join-Path $PSScriptRoot "webtool\frontend") run build
}
Start-Process "http://127.0.0.1:8000/"
& $py -m uvicorn webtool.app:app --host 127.0.0.1 --port 8000
