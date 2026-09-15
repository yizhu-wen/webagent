$projectRoot = Split-Path -Parent $PSScriptRoot
$collectionRoot = Join-Path $projectRoot "data_collection"

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    throw "uv is not installed or is not available on PATH. Install it from https://docs.astral.sh/uv/"
}

Push-Location $collectionRoot
try {
    uv sync
}
finally {
    Pop-Location
}
