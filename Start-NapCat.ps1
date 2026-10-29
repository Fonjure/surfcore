$ErrorActionPreference = 'Stop'
$workspace = $PSScriptRoot
$projectRoot = Join-Path (Split-Path -Parent $workspace) '大肥鱼'
$napcatRoot = Join-Path $projectRoot 'NapCat'
$nodePath = Join-Path $napcatRoot 'node.exe'
$entryPath = Join-Path $napcatRoot 'index.js'
$pidFile = Join-Path $projectRoot 'napcat.pid'
$settingsPath = Join-Path $workspace 'config.json'
$installPath = Join-Path $projectRoot 'installation.json'
$passwordPath = Join-Path $projectRoot 'qq-password.dpapi'

function Test-QQGateway([string]$expectedAccount) {
    try {
        $settings = Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $endpoint = [Uri]$settings.snowluma.httpUrl
        if ($endpoint.Scheme -ne 'http' -or $endpoint.Host -ne '127.0.0.1') { return $false }
        $token = [string]$settings.snowluma.accessToken
        $headers = @{}
        if ($token) { $headers.Authorization = 'Bearer ' + $token }
        $url = $endpoint.AbsoluteUri.TrimEnd('/') + '/get_login_info'
        $result = Invoke-RestMethod -Method Post -Uri $url -Headers $headers -ContentType 'application/json' -Body '{}' -TimeoutSec 2
        return ($result.status -eq 'ok' -and $result.retcode -eq 0 -and [string]$result.data.user_id -eq $expectedAccount)
    } catch { return $false }
}

$mutex = [Threading.Mutex]::new($false, 'Local\SurfCore-NapCat-Start')
$ownsMutex = $false
try {
    try { $ownsMutex = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { throw 'QQ 网关正在启动，请稍后再试。' }
    foreach ($file in @($nodePath, $entryPath, $settingsPath, $installPath, $passwordPath)) {
        if (-not (Test-Path -LiteralPath $file)) { throw '缺少网关程序、账号配置或加密密码，请检查大肥鱼目录。' }
    }
    $installation = Get-Content -LiteralPath $installPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $account = [string]$installation.bot_qq
    if ($account -notmatch '^\d{5,15}$') { throw '大肥鱼的机器人 QQ 账号配置无效。' }
    if (Test-QQGateway $account) { Write-Output 'QQ 网关已经在线。'; exit 0 }

    $existing = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
        $_.ExecutablePath -ieq $nodePath -and ($_.CommandLine -like ('*' + $entryPath + '*') -or $_.CommandLine -match 'napcat\.mjs')
    })
    if ($existing.Count) { throw 'NapCat 进程已存在，但网关还未就绪；请检查登录状态，避免重复启动。' }

    $stamp = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $PID
    $logDir = Join-Path $workspace 'state\napcat-logs'
    $backupDir = Join-Path $workspace 'backups\gateway-start'
    New-Item -ItemType Directory -Path $logDir, $backupDir -Force | Out-Null
    if (Test-Path -LiteralPath $pidFile) {
        Copy-Item -LiteralPath $pidFile -Destination (Join-Path $backupDir ('napcat-' + $stamp + '.pid'))
    }

    Add-Type -AssemblyName System.Security
    $protected = [Convert]::FromBase64String(([IO.File]::ReadAllText($passwordPath)).Trim())
    $passwordBytes = [Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    try {
        $env:NAPCAT_QUICK_ACCOUNT = $account
        $env:NAPCAT_WORKDIR = Join-Path $napcatRoot 'napcat'
        $env:NAPCAT_DISABLE_TIME_SYNC = '1'
        $env:NAPCAT_QUICK_PASSWORD_MD5 = [Text.Encoding]::ASCII.GetString($passwordBytes)
        $argument = '"' + $entryPath + '"'
        $process = Start-Process -FilePath $nodePath -WorkingDirectory $napcatRoot -ArgumentList @($argument) -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $logDir ('napcat-' + $stamp + '.out.log')) `
            -RedirectStandardError (Join-Path $logDir ('napcat-' + $stamp + '.err.log')) -PassThru
        [IO.File]::WriteAllText($pidFile, [string]$process.Id, [Text.Encoding]::ASCII)
    } finally {
        [Array]::Clear($passwordBytes, 0, $passwordBytes.Length)
        $env:NAPCAT_QUICK_PASSWORD_MD5 = $null
        $env:NAPCAT_QUICK_ACCOUNT = $null
        $env:NAPCAT_WORKDIR = $null
        $env:NAPCAT_DISABLE_TIME_SYNC = $null
    }

    $deadline = (Get-Date).AddSeconds(30)
    do {
        if (Test-QQGateway $account) { Write-Output 'QQ 网关已启动并登录，SurfCore 会自动连接。'; exit 0 }
        if (-not (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) { throw 'NapCat 已退出，请查看 state\napcat-logs 中的启动日志。' }
        Start-Sleep -Milliseconds 1000
    } while ((Get-Date) -lt $deadline)
    throw 'QQ 网关尚未就绪，请检查 QQ 登录状态及 state\napcat-logs 中的日志。'
} catch {
    Write-Error $_.Exception.Message
    exit 1
} finally {
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
