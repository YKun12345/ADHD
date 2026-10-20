param([ValidateRange(1024,65535)][int]$Port = 8770, [switch]$NewSession, [string]$RuntimeDirectory = '')
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$demoRoot = Join-Path $projectRoot '.codex-tmp/competition-demo'
$python = Join-Path $projectRoot '.venv/Scripts/python.exe'
$server = Join-Path $PSScriptRoot 'competition_demo_server.py'
$url = "http://127.0.0.1:$Port"
New-Item -ItemType Directory -Force -Path $demoRoot | Out-Null
$currentPath = Join-Path $demoRoot 'current.json'
$expectedProjectKey = (& $python -c "import hashlib,sys; print(hashlib.sha256(sys.argv[1].casefold().encode()).hexdigest()[:24])" $projectRoot).Trim()
function Get-CompetitionDemoInfo {
    # Windows PowerShell 5 decodes charset-less JSON as the system code page.
    # FastAPI emits UTF-8 JSON; decode the bytes explicitly so Chinese runtime
    # paths survive both PowerShell 5 double-click launch and PowerShell 7.
    $response = Invoke-WebRequest "$url/api/v1/__synthetic__/competition-info" -UseBasicParsing -TimeoutSec 2
    $json = [System.Text.Encoding]::UTF8.GetString($response.RawContentStream.ToArray())
    return ($json | ConvertFrom-Json)
}
$existing = $null
try { $existing = Get-CompetitionDemoInfo } catch {}
if ($existing) {
    if ($existing.service -ne 'adhd-competition-demo/v1' -or -not $existing.synthetic -or $existing.project_key -ne $expectedProjectKey) {
        throw "Port $Port belongs to another service; nothing was stopped."
    }
    if ($NewSession) { throw "A demo is already running on $Port. Use another unused port for a new session." }
    $existing | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $currentPath -Encoding UTF8
    Write-Output "Demo already running: $($existing.url)"
    exit 0
}
$probe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
try { $probe.Start() } catch { throw "Port $Port is in use. No existing process was modified." } finally { $probe.Stop() }
if ($RuntimeDirectory -and $NewSession) { throw 'Choose an existing runtime or a new session, not both.' }
$store = $RuntimeDirectory
if (-not $store -and -not $NewSession -and (Test-Path -LiteralPath $currentPath)) {
    $previous = Get-Content -LiteralPath $currentPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($previous.service -eq 'adhd-competition-demo/v1' -and $previous.project_key -eq $expectedProjectKey) { $store = $previous.runtime }
}
if (-not $store) { $store = Join-Path $demoRoot ('stores/' + [guid]::NewGuid().ToString('N').Substring(0,16)) }
$runId = [guid]::NewGuid().ToString('N').Substring(0,12)
$stdout = Join-Path $demoRoot "$runId-stdout.log"
$stderr = Join-Path $demoRoot "$runId-stderr.log"
$process = Start-Process -FilePath $python -ArgumentList @('"' + $server + '"', '--runtime', '"' + $store + '"', '--port', "$Port") -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
Write-Output 'Preparing independent synthetic workflow and original-model inference. First startup takes about 1-3 minutes.'
$deadline = (Get-Date).AddMinutes(8)
while ((Get-Date) -lt $deadline) {
    if ($process.HasExited) { throw "Demo startup failed. See $stderr and $stdout" }
    try {
        $ready = Get-CompetitionDemoInfo
        if ($ready.service -eq 'adhd-competition-demo/v1' -and $ready.project_key -eq $expectedProjectKey -and $ready.synthetic) {
            $ready | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $currentPath -Encoding UTF8
            Write-Output "Ready: $($ready.url)"
            Write-Output "Store: $store"
            exit 0
        }
    } catch {}
    Start-Sleep -Milliseconds 700
}
throw "Startup did not become ready. No existing service was stopped. Check $stderr and $stdout"
