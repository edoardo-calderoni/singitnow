# Installazione di SingITnow su Windows 11.
# Uso:  powershell -ExecutionPolicy Bypass -File setup.ps1

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Need($cmd, $hint) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Write-Host "Manca '$cmd'. Installalo con:  $hint" -ForegroundColor Red
        exit 1
    }
}

Write-Host "== SingITnow: controllo prerequisiti ==" -ForegroundColor Magenta
Need "python" "winget install Python.Python.3.12"
Need "node"   "winget install OpenJS.NodeJS.LTS"
Need "ffmpeg" "winget install Gyan.FFmpeg"

Write-Host "== Ambiente Python (3.12, via uv) ==" -ForegroundColor Magenta
python -m pip install --quiet --user uv
python -m uv venv .venv --python 3.12 --allow-existing
python -m uv pip install --python .venv\Scripts\python.exe -r requirements.txt

Write-Host "== Interfaccia (React) ==" -ForegroundColor Magenta
Push-Location frontend
npm install
npm run build
Pop-Location

Write-Host "== Firewall (accesso dai telefoni) ==" -ForegroundColor Magenta
& "$PSScriptRoot\firewall.ps1"

Write-Host ""
Write-Host "Fatto! Avvia SingITnow con SingITnow.bat" -ForegroundColor Green
Write-Host "PC e telefoni devono essere sulla stessa rete Wi-Fi, impostata in Windows come rete 'Privata'."
