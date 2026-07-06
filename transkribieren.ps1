# Transkribor-Starter. Ruft transcribe.py in der venv auf (ffmpeg wird automatisch gefunden).
#   .\transkribieren.ps1 <Projektname>
#   .\transkribieren.ps1 --list
#   .\transkribieren.ps1 --all
param([Parameter(ValueFromRemainingArguments = $true)] $Rest)
& "$PSScriptRoot\.venv\Scripts\python.exe" "$PSScriptRoot\transcribe.py" @Rest
