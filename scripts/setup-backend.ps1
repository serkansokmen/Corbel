param(
    [ValidateSet('cuda', 'cpu')][string]$Device = 'cuda',
    [ValidateSet('english', 'multilingual', 'typed-decisions')][string]$Model = 'english'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$environmentPath = Join-Path $projectRoot '.backend-venv'
$pythonPath = Join-Path $environmentPath 'Scripts/python.exe'

if (-not (Test-Path -LiteralPath $pythonPath)) {
    if (Get-Command uv -ErrorAction SilentlyContinue) {
        & uv venv --python 3.12 $environmentPath --seed
    } elseif (Get-Command py -ErrorAction SilentlyContinue) {
        & py -3.12 -m venv $environmentPath
    } else {
        & python -m venv $environmentPath
    }
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the backend environment. Install Python 3.12 and retry.' }
}

$index = if ($Device -eq 'cuda') { 'https://download.pytorch.org/whl/cu128' } else { 'https://download.pytorch.org/whl/cpu' }
& $pythonPath -m pip install --upgrade 'torch==2.10.0' --index-url $index
if ($LASTEXITCODE -ne 0) { throw 'PyTorch installation failed.' }
& $pythonPath -m pip install -r (Join-Path $projectRoot 'backend/requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Backend dependency installation failed.' }

if ($Device -eq 'cuda') {
    & $pythonPath -c "import torch; assert torch.cuda.is_available(), 'CUDA unavailable: check the NVIDIA driver'; x=torch.ones(8, device='cuda'); print(torch.cuda.get_device_name(0)); print('CUDA:', torch.version.cuda, '| capability:', torch.cuda.get_device_capability(0)); print('GPU check:', (x+x).sum().item())"
    if ($LASTEXITCODE -ne 0) { throw 'CUDA verification failed. Install a current NVIDIA driver supporting CUDA 12.8 and retry.' }
}

$configPath = Join-Path $projectRoot '.backend.env'
if (-not (Test-Path -LiteralPath $configPath)) {
    $keyBytes = New-Object byte[] 32
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $generator.GetBytes($keyBytes)
    $generator.Dispose()
    $sharedKey = [Convert]::ToBase64String($keyBytes)
    $precision = if ($Device -eq 'cuda') { 'bf16' } else { 'fp32' }
    $bindAddress = if ($Device -eq 'cuda') { '0.0.0.0' } else { '127.0.0.1' }
    @("LAYA_DEVICE=$Device", "LAYA_MODEL=$Model", "LAYA_PRECISION=$precision", "LAYA_HOST=$bindAddress", 'LAYA_PORT=5177', "LAYA_API_KEY=$sharedKey", 'LAYA_REVISION=') | Set-Content -LiteralPath $configPath -Encoding utf8
    Write-Host 'Created .backend.env. On this machine ./corbel.ps1 copies its LAYA_API_KEY into .env; copy it by hand only for a separate SvelteKit machine.'
} else {
    Write-Host 'Kept existing .backend.env. Check its device and model settings before starting.'
}
Write-Host 'Start everything with: ./corbel.ps1'
Write-Host 'On the SvelteKit machine, set LAYA_BACKEND_URL=http://WORKSTATION_IP:5177 in .env.'
