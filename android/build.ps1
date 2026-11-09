# Compila l'app Android di SingITnow e la copia dove il PC la offre ai telefoni
# (singitnow/static/SingITnow.apk, scaricabile da http://<PC>:8765/download/SingITnow.apk).
# Serve l'SDK di Android (Android Studio) e un JDK 17 o più recente.
$ErrorActionPreference = "Stop"
Push-Location $PSScriptRoot
try {
    if (-not $env:JAVA_HOME) {
        $jdk = Get-ChildItem "$env:USERPROFILE\.jdks" -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '(\d+)\.' -and [int]$Matches[1] -ge 17 } | Select-Object -First 1
        if ($jdk) { $env:JAVA_HOME = $jdk.FullName }
    }
    if (-not (Test-Path local.properties)) {
        $sdk = "$env:LOCALAPPDATA\Android\Sdk" -replace '\\', '/'
        Set-Content local.properties "sdk.dir=$sdk" -Encoding ascii
    }
    # le avvertenze del compilatore arrivano su stderr: non sono errori (conta solo il codice di uscita)
    $ErrorActionPreference = "Continue"
    .\gradlew.bat --no-daemon -q assembleRelease 2>&1 | Out-Host
    $ErrorActionPreference = "Stop"
    if ($LASTEXITCODE -ne 0) { throw "Compilazione non riuscita" }
    $dest = Join-Path $PSScriptRoot "..\singitnow\static\SingITnow.apk"
    New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
    Copy-Item "app\build\outputs\apk\release\app-release.apk" $dest -Force
    Write-Host "App pronta: $dest"
} finally {
    Pop-Location
}
