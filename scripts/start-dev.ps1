# Opens one PowerShell window per HoneyChain service.
# Usage (from the project folder):  .\scripts\start-dev.ps1
# Requires: PostgreSQL and MongoDB services running, dependencies installed (README step 3).

$root = Split-Path -Parent $PSScriptRoot

function Start-Window($title, $dir, $command) {
    Start-Process powershell -ArgumentList @(
        '-NoExit', '-Command',
        "`$Host.UI.RawUI.WindowTitle = '$title'; Set-Location '$dir'; $command"
    )
}

Write-Host 'Starting Hardhat node...'
Start-Window 'HoneyChain - blockchain' (Join-Path $root 'blockchain') 'npx hardhat node'
Start-Sleep -Seconds 8

Write-Host 'Deploying contract to the local chain...'
Push-Location (Join-Path $root 'blockchain')
npx hardhat run scripts/deploy.js --network localhost
Pop-Location

Write-Host 'Starting AI service, backend and frontend...'
Start-Window 'HoneyChain - AI service' (Join-Path $root 'ai-service') '.\.venv\Scripts\Activate.ps1; uvicorn app.main:app --host 127.0.0.1 --port 8000'
Start-Window 'HoneyChain - backend' (Join-Path $root 'backend') 'npm run dev'
Start-Window 'HoneyChain - frontend' (Join-Path $root 'frontend') 'npm run dev'

Write-Host ''
Write-Host 'Open http://localhost:5173  (health: http://localhost:4000/api/v1/health)'
