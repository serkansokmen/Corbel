<#
.SYNOPSIS
    Start Corbel: the Laya backend and the SvelteKit UI, from one command.

.DESCRIPTION
    Reads .backend.env for the port, key and model. Starts the backend, waits for
    /health to report ready, then runs the UI in the foreground. Stopping the UI
    with Ctrl+C also stops the backend.

    Before starting the UI it creates .env from .env.example if missing, then
    writes LAYA_BACKEND_URL=http://127.0.0.1:<LAYA_PORT> and copies LAYA_API_KEY
    from .backend.env into it, so a one-machine setup needs no manual copying.
    -BackendOnly and -Stop do not write LAYA_BACKEND_URL or LAYA_API_KEY.

    Run ./scripts/setup-backend.ps1 once before the first start.

.EXAMPLE
    ./corbel.ps1
    Start both services with the configured model.

.EXAMPLE
    ./corbel.ps1 -Model multilingual
    Switch the checkpoint (writes LAYA_MODEL to .backend.env and .env), then start.

.EXAMPLE
    ./corbel.ps1 -BackendOnly
    Start the backend and leave it running. Stop it later with ./corbel.ps1 -Stop.

.EXAMPLE
    ./corbel.ps1 -Stop
    Stop whatever is listening on the backend and UI ports.
#>
param(
    [ValidateSet('english', 'multilingual', 'typed-decisions')][string]$Model,
    [switch]$BackendOnly,
    [switch]$NoBrowser,
    [switch]$Stop,
    [int]$ReadyTimeoutSeconds = 900
)

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
Set-Location -LiteralPath $projectRoot

$configPath = Join-Path $projectRoot '.backend.env'
$uiEnvPath = Join-Path $projectRoot '.env'
$pythonPath = Join-Path $projectRoot '.backend-venv\Scripts\python.exe'
$logPath = Join-Path $projectRoot 'backend.log'
$outLogPath = Join-Path $projectRoot 'backend.out.log'
$uiPort = 5173

function Read-EnvFile([string]$path) {
    $map = @{}
    if (Test-Path -LiteralPath $path) {
        foreach ($line in @(Get-Content -LiteralPath $path -Encoding UTF8)) {
            $trimmed = $line.Trim()
            if ($trimmed -and -not $trimmed.StartsWith('#') -and $trimmed.Contains('=')) {
                $split = $trimmed.IndexOf('=')
                $map[$trimmed.Substring(0, $split).Trim()] = $trimmed.Substring($split + 1).Trim()
            }
        }
    }
    return $map
}

# Rewrites one key in place, preserving comments and ordering. Writes UTF-8
# without a BOM so the first key stays parseable by both Python and Vite.
function Set-EnvValue([string]$path, [string]$key, [string]$value) {
    if (-not (Test-Path -LiteralPath $path)) { return }
    $lines = @(Get-Content -LiteralPath $path -Encoding UTF8)
    $found = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match "^\s*$([regex]::Escape($key))\s*=") {
            $lines[$i] = "$key=$value"
            $found = $true
        }
    }
    if (-not $found) { $lines += "$key=$value" }
    [System.IO.File]::WriteAllLines($path, $lines, (New-Object System.Text.UTF8Encoding $false))
}

function Get-ListenerPid([int]$port) {
    $connection = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($connection) { return ($connection | Select-Object -First 1).OwningProcess }
    return $null
}

function Stop-Listener([int]$port, [string]$label) {
    $listenerPid = Get-ListenerPid $port
    if ($listenerPid) {
        $name = (Get-Process -Id $listenerPid -ErrorAction SilentlyContinue).ProcessName
        Stop-Process -Id $listenerPid -Force -ErrorAction SilentlyContinue
        Write-Host "Stopped $label on $port (pid $listenerPid, $name)"
    } else {
        Write-Host "$label port $port already free"
    }
}

$config = Read-EnvFile $configPath
$backendPort = 5177
if ($config['LAYA_PORT']) { $backendPort = [int]$config['LAYA_PORT'] }

if ($Stop) {
    Stop-Listener $backendPort 'backend'
    Stop-Listener $uiPort 'UI'
    return
}

if (-not (Test-Path -LiteralPath $pythonPath)) {
    throw 'No .backend-venv found. Run ./scripts/setup-backend.ps1 -Device cuda first.'
}
if (-not (Test-Path -LiteralPath $configPath)) {
    throw 'No .backend.env found. Run ./scripts/setup-backend.ps1 -Device cuda first.'
}

# The UI talks to the backend this script starts, so point .env at it and copy
# the shared key across. The key value is never printed.
if (-not $BackendOnly) {
    if (-not (Test-Path -LiteralPath $uiEnvPath)) {
        Copy-Item -LiteralPath (Join-Path $projectRoot '.env.example') -Destination $uiEnvPath
        Write-Host 'Created .env from .env.example'
    }
    if ($config['LAYA_API_KEY']) { Set-EnvValue $uiEnvPath 'LAYA_API_KEY' $config['LAYA_API_KEY'] }
    Set-EnvValue $uiEnvPath 'LAYA_BACKEND_URL' "http://127.0.0.1:$backendPort"
}

if ($Model) {
    Set-EnvValue $configPath 'LAYA_MODEL' $Model
    Set-EnvValue $uiEnvPath 'LAYA_MODEL' $Model
    $config = Read-EnvFile $configPath
    Write-Host "Model set to $Model. The first start of a new checkpoint downloads its weights."
}

$modelName = $config['LAYA_MODEL']
if (-not $modelName) { $modelName = 'english' }
$headers = @{}
if ($config['LAYA_API_KEY']) { $headers['Authorization'] = 'Bearer ' + $config['LAYA_API_KEY'] }

$backendProcess = $null
$existingPid = Get-ListenerPid $backendPort
if ($existingPid) {
    Write-Host "Backend already listening on $backendPort (pid $existingPid). Reusing it."
} else {
    Write-Host "Starting Laya backend ($modelName) on 127.0.0.1:$backendPort"
    $backendProcess = Start-Process -FilePath $pythonPath -ArgumentList '-m', 'backend.serve' `
        -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardError $logPath -RedirectStandardOutput $outLogPath
}

$health = $null
$watch = [Diagnostics.Stopwatch]::StartNew()
$lastStatus = ''
while ($watch.Elapsed.TotalSeconds -lt $ReadyTimeoutSeconds) {
    if ($backendProcess -and $backendProcess.HasExited) {
        throw "Backend exited with code $($backendProcess.ExitCode) before reporting ready. See $logPath"
    }
    $probe = $null
    try {
        $probe = Invoke-RestMethod -Uri "http://127.0.0.1:$backendPort/health" -Headers $headers -TimeoutSec 5 -ErrorAction Stop
    } catch {
        $probe = $null
    }
    if ($probe) {
        if ($probe.status -ne $lastStatus) {
            Write-Host ("[{0,5:N0}s] {1}" -f $watch.Elapsed.TotalSeconds, $probe.status)
            $lastStatus = $probe.status
        }
        if ($probe.status -eq 'ready') { $health = $probe; break }
        if ($probe.status -eq 'error') { throw "Laya failed to load: $($probe.message) See $logPath" }
    }
    Start-Sleep -Milliseconds 700
}

if (-not $health) {
    throw "Backend did not report ready within $ReadyTimeoutSeconds seconds. See $logPath"
}

Write-Host ''
Write-Host ("Laya ready  : {0} / {1} / {2}" -f $health.model, $health.precision, $health.gpu)
Write-Host ("Backend     : http://127.0.0.1:{0}" -f $backendPort)

if ($BackendOnly) {
    Write-Host 'Backend running in the background. Stop it with: ./corbel.ps1 -Stop'
    return
}

Write-Host ("UI          : http://127.0.0.1:{0}" -f $uiPort)
Write-Host 'Ctrl+C stops both.'
Write-Host ''

$browserJob = $null
if (-not $NoBrowser) {
    $browserJob = Start-Job -ScriptBlock {
        param($url)
        for ($attempt = 0; $attempt -lt 90; $attempt++) {
            try {
                Invoke-WebRequest -Uri $url -TimeoutSec 2 -UseBasicParsing | Out-Null
                Start-Process $url
                break
            } catch {
                Start-Sleep -Milliseconds 500
            }
        }
    } -ArgumentList "http://127.0.0.1:$uiPort"
}

try {
    npm run dev
} finally {
    if ($browserJob) { Remove-Job -Job $browserJob -Force -ErrorAction SilentlyContinue }
    if ($backendProcess -and -not $backendProcess.HasExited) {
        Stop-Process -Id $backendProcess.Id -Force -ErrorAction SilentlyContinue
        Write-Host "Stopped backend (pid $($backendProcess.Id))"
    }
}
