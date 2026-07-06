# Startet den Transkribor-Editor lokal und öffnet den Browser.
$py = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
Start-Process "http://127.0.0.1:8000/"
& $py -m uvicorn webtool.app:app --host 127.0.0.1 --port 8000
