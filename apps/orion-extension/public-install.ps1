# Orion Sync — Installer Windows
# Uso: irm http://209.50.63.149/download/install.ps1 | iex

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "  ___       _" -ForegroundColor Cyan
Write-Host " / _ \ _ __(_) ___  _ __" -ForegroundColor Cyan
Write-Host "| | | | '__| |/ _ \| '_ \" -ForegroundColor Cyan
Write-Host "| |_| | |  | | (_) | | | |  Sync" -ForegroundColor Cyan
Write-Host " \___/|_|  |_|\___/|_| |_|" -ForegroundColor Cyan
Write-Host ""

$installDir = Join-Path $env:LOCALAPPDATA "Orion\extension"
$tarballUrl = "http://209.50.63.149/download/orion-extension.tar.gz"
$tarballPath = Join-Path $env:TEMP "orion-extension.tar.gz"

Write-Host "[1/3] Descargando..." -ForegroundColor Yellow
try {
    Invoke-WebRequest -Uri $tarballUrl -OutFile $tarballPath -UseBasicParsing
} catch {
    Write-Host "  [X] Error descargando: $_" -ForegroundColor Red
    exit 1
}

Write-Host "[2/3] Extrayendo a $installDir" -ForegroundColor Yellow
# Carpeta existente = ACTUALIZACION: los pasos son otros (recargar, no volver a cargar).
# Sin ese aviso Chrome se queda con la version vieja en memoria (fallo del 29-jul-2026).
$isUpdate = Test-Path $installDir
if ($isUpdate) {
    Remove-Item -Recurse -Force $installDir
}
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
& tar -xzf $tarballPath -C $installDir
Remove-Item $tarballPath -Force

$version = ((Get-Content (Join-Path $installDir "manifest.json") | Select-String '"version"') -split ':')[1].Trim(' ",')

Write-Host "[3/3] Listo! Version $version en:" -ForegroundColor Green
Write-Host "  $installDir" -ForegroundColor Cyan
Write-Host ""
if ($isUpdate) {
    Write-Host "ACTUALIZACION - Chrome AUN corre la version vieja en memoria. Falta:" -ForegroundColor White
    Write-Host "  1. Se va a abrir chrome://extensions en 3 segundos" -ForegroundColor Gray
    Write-Host "  2. Busca 'Orion Sync' y dale al boton RECARGAR (flecha circular)" -ForegroundColor Gray
    Write-Host "  3. Refresca la pestana de LinkedIn" -ForegroundColor Gray
    Write-Host "  4. Confirma que debajo de 'Orion Sync' diga: $version" -ForegroundColor Gray
} else {
    Write-Host "Siguiente paso (1 vez por Chrome):" -ForegroundColor White
    Write-Host "  1. Se va a abrir chrome://extensions en 3 segundos" -ForegroundColor Gray
    Write-Host "  2. Activa 'Modo de desarrollador' (esquina superior derecha)" -ForegroundColor Gray
    Write-Host "  3. Click 'Cargar extension sin empaquetar'" -ForegroundColor Gray
    Write-Host "  4. Selecciona la carpeta:" -ForegroundColor Gray
    Write-Host "     $installDir" -ForegroundColor Cyan
}
Write-Host ""

# Copy path to clipboard for easy paste
$installDir | Set-Clipboard
Write-Host "[Path copiado al portapapeles]" -ForegroundColor DarkGray
Write-Host ""

Start-Sleep -Seconds 3

# Abrir chrome://extensions
$chromePaths = @(
    "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "${env:LOCALAPPDATA}\Google\Chrome\Application\chrome.exe"
)
$chrome = $chromePaths | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($chrome) {
    Start-Process $chrome -ArgumentList "chrome://extensions/"
} else {
    Write-Host "Chrome no encontrado. Abre manualmente chrome://extensions" -ForegroundColor Yellow
}
