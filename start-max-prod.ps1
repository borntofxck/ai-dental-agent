param(
  [switch]$SkipDocker,
  [switch]$NoRestart,
  [string]$N8nContainer = "n8n",
  [int]$AgentPort = 3002,
  [int]$MaxPort = 3001,
  [int]$MaxIntervalMs = 5000,
  [int]$MaxWorkerIntervalMs = 1500,
  [int]$ReminderIntervalMs = 60000,
  [string]$MaxProfileDir = "",
  [string]$MaxArtifactsDir = ""
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$LogsDir = Join-Path $Root "logs"
$AgentLog = Join-Path $LogsDir "agent-api.prod.out.log"
$AgentErr = Join-Path $LogsDir "agent-api.prod.err.log"
$MaxLog = Join-Path $LogsDir "max-adapter.prod.out.log"
$MaxErr = Join-Path $LogsDir "max-adapter.prod.err.log"

function Write-Step($Message) {
  Write-Host ""
  Write-Host "==> $Message"
}

function Stop-PortProcess($Port) {
  $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  $processIds = $connections | Select-Object -ExpandProperty OwningProcess -Unique

  foreach ($processId in $processIds) {
    if (-not $processId) { continue }
    Write-Host "Stopping PID $processId on port $Port"
    taskkill /PID $processId /T /F | Out-Null
  }
}

function Wait-Http($Name, $Url, $TimeoutSec = 60) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $lastError = $null

  while ((Get-Date) -lt $deadline) {
    try {
      return Invoke-RestMethod -Uri $Url -Method Get -TimeoutSec 5
    } catch {
      $lastError = $_.Exception.Message
      Start-Sleep -Seconds 2
    }
  }

  throw "$Name is not ready at $Url. Last error: $lastError"
}

function Post-Json($Url, $Body) {
  $json = $Body | ConvertTo-Json -Compress
  return Invoke-RestMethod -Uri $Url -Method Post -ContentType "application/json" -Body $json -TimeoutSec 90
}

New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null

$env:AGENT_API_PORT = [string]$AgentPort
$env:AGENT_API_URL = "http://localhost:$AgentPort"
$env:MAX_ADAPTER_PORT = [string]$MaxPort
if (-not $env:N8N_WEBHOOK_URL) {
  $env:N8N_WEBHOOK_URL = "http://localhost:5678/webhook/incoming-message"
}
$env:MAX_OPEN_BROWSER = "false"
$env:MAX_HEADLESS = "false"

if ($MaxProfileDir) {
  New-Item -ItemType Directory -Force -Path $MaxProfileDir | Out-Null
  $env:MAX_USER_DATA_DIR = $MaxProfileDir
}

if ($MaxArtifactsDir) {
  New-Item -ItemType Directory -Force -Path $MaxArtifactsDir | Out-Null
  $env:MAX_ARTIFACTS_DIR = $MaxArtifactsDir
}

Write-Step "Checking n8n Docker container"
if (-not $SkipDocker) {
  $containerName = docker ps -a --filter "name=^/$N8nContainer$" --format "{{.Names}}" 2>$null
  if ($containerName -eq $N8nContainer) {
    docker start $N8nContainer | Out-Null
    Write-Host "n8n container is running: $N8nContainer"
  } else {
    Write-Warning "n8n container '$N8nContainer' was not found. Start n8n manually or pass -SkipDocker."
  }
} else {
  Write-Host "Docker start skipped by -SkipDocker"
}

if (-not $NoRestart) {
  Write-Step "Stopping old local Node services"
  Stop-PortProcess $MaxPort
  Stop-PortProcess $AgentPort
  Start-Sleep -Seconds 2
}

Write-Step "Starting agent-api on port $AgentPort"
Set-Content -Path $AgentLog -Value ""
Set-Content -Path $AgentErr -Value ""
Start-Process -FilePath "npm.cmd" `
  -ArgumentList "run", "agent:start" `
  -WorkingDirectory $Root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $AgentLog `
  -RedirectStandardError $AgentErr

Wait-Http "agent-api" "http://localhost:$AgentPort/health" 60 | Out-Null
Write-Host "agent-api OK: http://localhost:$AgentPort"

Write-Step "Starting max-adapter on port $MaxPort"
Set-Content -Path $MaxLog -Value ""
Set-Content -Path $MaxErr -Value ""
Start-Process -FilePath "npm.cmd" `
  -ArgumentList "run", "start" `
  -WorkingDirectory (Join-Path $Root "max-adapter") `
  -WindowStyle Hidden `
  -RedirectStandardOutput $MaxLog `
  -RedirectStandardError $MaxErr

Wait-Http "max-adapter" "http://localhost:$MaxPort/health" 90 | Out-Null
Write-Host "max-adapter OK: http://localhost:$MaxPort"

Write-Step "Checking n8n health"
try {
  Wait-Http "n8n" "http://localhost:5678/healthz" 30 | Out-Null
  Write-Host "n8n OK: http://localhost:5678"
} catch {
  Write-Warning $_.Exception.Message
}

Write-Step "Starting MAX browser and watchers"
Invoke-RestMethod -Uri "http://localhost:$MaxPort/max/start" -Method Post -TimeoutSec 90 | Out-Null

$maxWatch = Post-Json "http://localhost:$MaxPort/max/watch/start" @{
  interval_ms = $MaxIntervalMs
  mode = "all"
  worker_interval_ms = $MaxWorkerIntervalMs
}

$reminderWatch = Post-Json "http://localhost:$MaxPort/reminders/watch/start" @{
  interval_ms = $ReminderIntervalMs
}

Write-Step "Production status"
$maxStatus = Invoke-RestMethod -Uri "http://localhost:$MaxPort/max/status" -Method Get -TimeoutSec 10
$watchStatus = Invoke-RestMethod -Uri "http://localhost:$MaxPort/max/watch/status" -Method Get -TimeoutSec 10
$reminderStatus = Invoke-RestMethod -Uri "http://localhost:$MaxPort/reminders/watch/status" -Method Get -TimeoutSec 10
$queueStatus = Invoke-RestMethod -Uri "http://localhost:$MaxPort/max/queue/status" -Method Get -TimeoutSec 10

[pscustomobject]@{
  agent_api = "http://localhost:$AgentPort"
  max_adapter = "http://localhost:$MaxPort"
  n8n = "http://localhost:5678"
  max_started = $maxStatus.started
  max_title = $maxStatus.title
  max_profile = $maxStatus.profile_dir
  max_watcher_running = $watchStatus.running
  max_chats_seen = $watchStatus.last_scan_result.chats_seen
  max_last_error = $watchStatus.last_error
  reminders_running = $reminderStatus.running
  reminders_last_error = $reminderStatus.last_error
  queue = $queueStatus.queue
  logs = $LogsDir
} | Format-List

Write-Host ""
Write-Host "Done. If max_chats_seen is 0, open the MAX browser window and log in by QR, then run:"
Write-Host "Invoke-RestMethod -Uri http://localhost:$MaxPort/max/watch/start -Method Post -ContentType application/json -Body '{`"interval_ms`":5000,`"mode`":`"all`",`"worker_interval_ms`":1500}'"
