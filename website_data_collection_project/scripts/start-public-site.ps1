<#
.SYNOPSIS
Publishes the local website over an HTTPS tunnel.

.DESCRIPTION
Starts local_server.py in public mode and puts a Cloudflare quick tunnel in
front of it, then prints the public task URL. Ultrasound sensing needs a secure
context: browsers only grant microphone access over HTTPS or on localhost, so a
plain http:// address reachable by IP will not work.

Public mode refuses the endpoints that write uploads to disk and run analysis
subprocesses. Each session still exports its complete ZIP archive in the
browser.

.PARAMETER Port
Local port for the website. Defaults to 34567.

.PARAMETER Version
Website version segment to advertise. Defaults to the first line of
honey_website/versions.txt.

.EXAMPLE
.\scripts\start-public-site.ps1
#>
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 34567,

    [string]$Version
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$siteRoot = Join-Path $projectRoot "honey_website"
$launcher = Join-Path $siteRoot "local_server.py"

if (-not (Test-Path -LiteralPath $launcher)) {
    throw "Local website launcher not found: $launcher"
}

if (-not $Version) {
    $versionsFile = Join-Path $siteRoot "versions.txt"
    $Version = (Get-Content -LiteralPath $versionsFile | Where-Object { $_.Trim() } | Select-Object -First 1).Trim()
}

$cloudflared = Get-Command cloudflared -ErrorAction SilentlyContinue
if (-not $cloudflared) {
    Write-Error @"
cloudflared is not installed. Install it with:

    winget install --id Cloudflare.cloudflared

An SSH-based tunnel needs no install and works the same way, but the two free
providers were unreachable from this network on 2026-09-08 (TCP 443 connected
and the TLS handshake was then reset, which looks like SNI filtering), so
confirm your network allows one before relying on it:

    ssh -R 80:localhost:$Port nokey@localhost.run    # *.lhr.life
    ssh -R 80:localhost:$Port serveo.net             # *.serveo.net

Note that a tunnel is only needed for browsers on other machines. Agents driven
on this machine can use http://localhost:$Port/ directly: localhost counts as a
secure context, so the microphone works without TLS.
"@
    exit 1
}

$serverProcess = $null
$tunnelProcess = $null
$tunnelLog = Join-Path $env:TEMP "webagent-tunnel-$Port.log"

try {
    Write-Host "Starting the website on port $Port in public mode..."
    # Start-Process has no -Environment parameter on Windows PowerShell 5.1, so
    # the variable is set here and inherited by the child process.
    $previousPublicMode = $env:SENSING_PUBLIC_MODE
    $env:SENSING_PUBLIC_MODE = "1"
    $serverProcess = Start-Process -PassThru -NoNewWindow -FilePath "python" `
        -ArgumentList @("local_server.py", "-p", "$Port") `
        -WorkingDirectory $siteRoot

    # Fail fast if the server exited instead of binding the port.
    for ($i = 0; $i -lt 30; $i++) {
        if ($serverProcess.HasExited) {
            throw "The website server exited with code $($serverProcess.ExitCode)."
        }
        try {
            Invoke-WebRequest -Uri "http://127.0.0.1:$Port/healthz" -UseBasicParsing -TimeoutSec 2 | Out-Null
            break
        }
        catch { Start-Sleep -Milliseconds 500 }
    }

    Write-Host "Opening the HTTPS tunnel..."
    if (Test-Path -LiteralPath $tunnelLog) { Remove-Item -LiteralPath $tunnelLog -Force }
    $tunnelProcess = Start-Process -PassThru -NoNewWindow -FilePath $cloudflared.Source `
        -ArgumentList @("tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:$Port") `
        -RedirectStandardError $tunnelLog

    $publicUrl = $null
    for ($i = 0; $i -lt 60; $i++) {
        if (Test-Path -LiteralPath $tunnelLog) {
            $match = Select-String -LiteralPath $tunnelLog -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" |
                Select-Object -First 1
            if ($match) {
                $publicUrl = $match.Matches[0].Value
                break
            }
        }
        Start-Sleep -Milliseconds 500
    }

    if (-not $publicUrl) {
        throw "The tunnel did not report a public URL. See $tunnelLog"
    }

    Write-Host ""
    Write-Host "The website is live at $publicUrl/$Version/"
    Write-Host "Set WEBSITE_BASE_URL=$publicUrl for the data collection runners."
    Write-Host "Press Ctrl+C to take it offline."
    Write-Host ""

    while (-not $serverProcess.HasExited -and -not $tunnelProcess.HasExited) {
        Start-Sleep -Seconds 1
    }
}
finally {
    foreach ($process in @($tunnelProcess, $serverProcess)) {
        if ($process -and -not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
    }
    $env:SENSING_PUBLIC_MODE = $previousPublicMode
    Write-Host "The website is offline."
}
