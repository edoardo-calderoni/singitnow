# Consente ai telefoni della rete di casa di collegarsi a SingITnow (porta 8765, solo reti private).
# Uso:  powershell -ExecutionPolicy Bypass -File firewall.ps1   (chiede i permessi di amministratore)

param([int]$Port = $(if ($env:SINGITNOW_PORT) { [int]$env:SINGITNOW_PORT } else { 8765 }))

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
    Start-Process powershell -Verb RunAs -Wait -ArgumentList "-ExecutionPolicy Bypass -File `"$PSCommandPath`" -Port $Port"
    exit
}

Remove-NetFirewallRule -DisplayName "SingITnow" -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName "SingITnow" -Description "Telefoni -> SingITnow (karaoke)" `
    -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Private | Out-Null
Write-Host "Regola firewall 'SingITnow' creata: porta $Port aperta sulle reti private." -ForegroundColor Green
