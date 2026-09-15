param(
    [Parameter(Mandatory = $true)]
    [string]$Config,

    [switch]$SkipExisting
)

$projectRoot = Split-Path -Parent $PSScriptRoot
$collectionRoot = Join-Path $projectRoot "data_collection"
$configPath = Join-Path $collectionRoot $Config

if (-not (Test-Path -LiteralPath $configPath)) {
    throw "Experiment configuration not found: $configPath"
}

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    throw "uv is not installed or is not available on PATH."
}

$arguments = @("run", "scripts/task_automation.py", "-c", $Config)
if ($SkipExisting) {
    $arguments += "--skip_existing"
}

$sourceRoot = Join-Path $collectionRoot "src"
$previousPythonPath = $env:PYTHONPATH
$env:PYTHONPATH = if ($previousPythonPath) {
    "$sourceRoot$([System.IO.Path]::PathSeparator)$previousPythonPath"
} else {
    $sourceRoot
}

Push-Location $collectionRoot
try {
    & uv @arguments
}
finally {
    Pop-Location
    $env:PYTHONPATH = $previousPythonPath
}
