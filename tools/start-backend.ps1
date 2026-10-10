[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 8000,
    [switch]$NoPause,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$projectRoot = [System.IO.Directory]::GetParent($PSScriptRoot).FullName
$pythonPath = Join-Path $projectRoot '.venv\Scripts\python.exe'
$backendDir = Join-Path $projectRoot 'backend'
$baseUrl = 'http://127.0.0.1:' + $Port
$exitCode = 0
$stdoutLog = $null
$stderrLog = $null

function Test-BackendReady {
    try {
        $health = Invoke-RestMethod -Uri ($baseUrl + '/api/v1/health') -TimeoutSec 2
        if ($health.status -ne 'ok') { return $false }
        $schema = Invoke-RestMethod -Uri ($baseUrl + '/openapi.json') -TimeoutSec 2
        $sessionPath = $schema.paths.PSObject.Properties['/api/v1/imaging/session']
        return ($null -ne $sessionPath -and
            $null -ne $sessionPath.Value.PSObject.Properties['post'] -and
            $null -ne $sessionPath.Value.PSObject.Properties['delete'])
    } catch {
        return $false
    }
}

function Find-ProjectServer {
    param([int]$ProcessId)
    $seen = @{}
    for ($depth = 0; $depth -lt 8 -and $ProcessId -gt 0; $depth++) {
        if ($seen.ContainsKey($ProcessId)) { break }
        $seen[$ProcessId] = $true
        $serverProcess = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $ProcessId)
        if ($null -eq $serverProcess) { break }
        $command = [string]$serverProcess.CommandLine
        $command = $command.Replace('/', '\')
        if ($command.IndexOf($pythonPath, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
            $command.IndexOf('backend.app.main:app', [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
            $command.IndexOf('uvicorn', [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            return $serverProcess
        }
        $ProcessId = [int]$serverProcess.ParentProcessId
    }
    return $null
}

try {
    Write-Host ''
    Write-Host '知行合医 - 后端一键启动' -ForegroundColor Cyan
    Write-Host ('项目位置：' + $projectRoot)
    Write-Host ('服务地址：' + $baseUrl)
    Write-Host ''
    if (-not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) {
        throw '没有找到项目的 .venv Python 环境。请先恢复该环境，再双击启动。'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $backendDir 'app\main.py') -PathType Leaf)) {
        throw '没有找到后端入口。请将完整项目保存在桌面的 ADHD-AB协作版 文件夹中。'
    }

    # Inspect only listeners that can accept connections on our local address.
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
        Where-Object { $_.LocalPort -eq $Port -and $_.LocalAddress -in @('127.0.0.1', '0.0.0.0', '::') })
    if ($listeners.Count -gt 0) {
        foreach ($listener in $listeners) {
            if ($null -eq (Find-ProjectServer -ProcessId $listener.OwningProcess)) {
                throw ('端口 ' + $Port + ' 已被其他程序占用。本脚本没有关闭该程序，请先处理端口占用。')
            }
        }
        if (-not (Test-BackendReady)) {
            throw '现有后端未通过检查，可能仍在启动或运行旧代码。请关闭原来的后端启动窗口后重试；本脚本不会自动结束现有进程。'
        }
        Write-Host '后端已经在运行，无需重复启动。' -ForegroundColor Green
    } elseif ($CheckOnly) {
        throw '后端尚未运行。'
    } else {
        Write-Host '正在启动，请稍候……'
        $logDir = Join-Path $projectRoot 'logs'
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
        $stdoutLog = Join-Path $logDir ('backend-start-' + $stamp + '.stdout.log')
        $stderrLog = Join-Path $logDir ('backend-start-' + $stamp + '.stderr.log')
        # Start-Process joins ArgumentList, so quote paths that may contain spaces.
        $arguments = @('-X', 'utf8', '-m', 'uvicorn', 'backend.app.main:app',
            '--host', '127.0.0.1', '--port', [string]$Port,
            '--reload', '--reload-dir', ('"' + $backendDir + '"'))
        $startOptions = @{
            FilePath = $pythonPath
            ArgumentList = $arguments
            WorkingDirectory = $projectRoot
            WindowStyle = 'Hidden'
            PassThru = $true
            RedirectStandardOutput = $stdoutLog
            RedirectStandardError = $stderrLog
        }
        $startedProcess = Start-Process @startOptions
        $deadline = [DateTime]::UtcNow.AddSeconds(45)
        $ready = $false
        do {
            Start-Sleep -Milliseconds 750
            $ready = Test-BackendReady
            if ($ready) { break }
            $startedProcess.Refresh()
            if ($startedProcess.HasExited) {
                throw ('后端进程提前退出，退出码：' + $startedProcess.ExitCode)
            }
        } while ([DateTime]::UtcNow -lt $deadline)
        if (-not $ready) {
            throw '等待启动超时。请查看下方日志；如果后端稍后启动成功，再次双击即可检查。'
        }
        Write-Host '后端启动成功，健康检查和影像接口检查均已通过。' -ForegroundColor Green
        Write-Host ('启动日志：' + $stderrLog)
    }
    Write-Host ('接口文档：' + $baseUrl + '/docs')
    Write-Host '现在可以刷新网页继续使用。'
    Write-Host '后端在后台运行，关闭本窗口后仍可使用；后端代码修改会自动重新加载。'
} catch {
    $exitCode = 1
    Write-Host ('启动未完成：' + $_.Exception.Message) -ForegroundColor Red
    foreach ($logPath in @($stderrLog, $stdoutLog)) {
        if ($logPath -and (Test-Path -LiteralPath $logPath -PathType Leaf)) {
            Write-Host ('日志：' + $logPath)
            Get-Content -LiteralPath $logPath -Tail 15 -Encoding UTF8 | ForEach-Object { Write-Host $_ }
        }
    }
}

if (-not $NoPause) {
    Write-Host ''
    Read-Host '按回车关闭此窗口' | Out-Null
}
exit $exitCode
