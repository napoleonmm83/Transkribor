# Startet den Transkribor-Editor lokal und öffnet den Browser.
$py = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"

# .env (git-ignoriert) laden, falls vorhanden — HF_TOKEN / TRANSKRIBOR_DIARIZE EINMAL dort
# eintragen statt bei jedem Start in der Shell. Nur KEY=VALUE-Zeilen (# = Kommentar). Vorlage: .env.example
$envFile = Join-Path $PSScriptRoot ".env"
if (Test-Path $envFile) {
  foreach ($line in Get-Content $envFile) {
    $t = $line.Trim()
    if (-not $t -or $t.StartsWith("#") -or -not $t.Contains("=")) { continue }
    $k, $v = $t -split "=", 2
    [Environment]::SetEnvironmentVariable($k.Trim(), $v.Trim().Trim('"').Trim("'"), "Process")
  }
}

if ($env:HF_TOKEN) {
  Write-Host "Diarisierung aktiv (HF_TOKEN geladen)." -ForegroundColor Green
} else {
  Write-Host "Diarisierung aus: kein HF_TOKEN — Sprecher werden nur aus dem Text geraten." -ForegroundColor Yellow
  Write-Host "  -> Token in .env eintragen (Vorlage: .env.example)." -ForegroundColor Yellow
}

$index = Join-Path $PSScriptRoot "webtool\static\index.html"
if (-not (Test-Path $index)) {
  Write-Host "Frontend-Build fehlt — baue (npm)..."
  npm --prefix (Join-Path $PSScriptRoot "webtool\frontend") install
  npm --prefix (Join-Path $PSScriptRoot "webtool\frontend") run build
}
Start-Process "http://127.0.0.1:8000/"
& $py -m uvicorn webtool.app:app --host 127.0.0.1 --port 8000
