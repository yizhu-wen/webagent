param(
    [ValidateRange(1, 65535)]
    [int]$Port = 34567
)

$projectRoot = Split-Path -Parent $PSScriptRoot
$siteRoot = Join-Path $projectRoot "honey_website"
$launcher = Join-Path $siteRoot "local_server.py"

if (-not (Test-Path -LiteralPath $launcher)) {
    throw "Local website launcher not found: $launcher"
}

Write-Host "Starting the website at http://localhost:$Port/LOCALDEV01/"
Push-Location $siteRoot
try {
    python local_server.py -p $Port
}
finally {
    Pop-Location
}
