[CmdletBinding()]
param([ValidateRange(1024,65535)][int]$Port=8767, [string]$RuntimeDirectory='')

$ErrorActionPreference='Stop'
$projectRoot=[System.IO.Directory]::GetParent($PSScriptRoot).FullName
$pythonPath=Join-Path $projectRoot '.venv\Scripts\python.exe'
$serverPath=Join-Path $projectRoot 'tests\web\isolated_federated_server.py'
$temporaryRoot=Join-Path $projectRoot '.codex-tmp'
$baseUrl='http://127.0.0.1:'+$Port
if(-not (Test-Path -LiteralPath $pythonPath -PathType Leaf)){throw '业务环境不存在；请先恢复原环境。'}
if(-not (Test-Path -LiteralPath $temporaryRoot)){New-Item -ItemType Directory -Path $temporaryRoot | Out-Null}

if(-not $RuntimeDirectory){
    $sourcePath=Join-Path $temporaryRoot 'w11-no-training-source.json'
    if(Test-Path -LiteralPath $sourcePath -PathType Leaf){
        $source=Get-Content -LiteralPath $sourcePath -Raw | ConvertFrom-Json
        if($source.synthetic_only -eq $true){$RuntimeDirectory=[string]$source.runtime}
    }
}
if($RuntimeDirectory){
    $RuntimeDirectory=[System.IO.Path]::GetFullPath($RuntimeDirectory)
    $inside=$RuntimeDirectory.StartsWith($temporaryRoot.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)
    if(-not $inside -or -not (Test-Path -LiteralPath (Join-Path $RuntimeDirectory 'browser-source.json') -PathType Leaf)){
        throw '只允许复用项目.codex-tmp中的原合成体验库。'
    }
}
$hash=[System.Security.Cryptography.SHA256]::Create()
try{$projectKey=([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($projectRoot.ToLowerInvariant())))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}
function Get-PreviewMode {
    try{Invoke-RestMethod -Uri ($baseUrl+'/api/v1/__synthetic__/research-preview-mode') -TimeoutSec 2}catch{return $null}
}
$existing=Get-PreviewMode
if($existing){
    if($existing.service -ne 'synthetic-federated-preview/v1' -or $existing.project_key -ne $projectKey -or $existing.synthetic_only -ne $true -or $existing.training_enabled -ne $false){throw '该端口不是本项目的不训练体验服务，请选择其他端口。'}
    Write-Output ($baseUrl+'/__synthetic__/research-preview')
    return
}
$probe=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,$Port)
try{$probe.Start()}catch{throw '端口被其他服务占用；保留原服务，请另选端口。'}finally{$probe.Stop()}
$backupReuse=[Environment]::GetEnvironmentVariable('W11_REUSE_SYNTHETIC_RUNTIME','Process')
$backupTraining=[Environment]::GetEnvironmentVariable('W11_SYNTHETIC_TRAINING_AUTHORIZED','Process')
try{
    [Environment]::SetEnvironmentVariable('W11_REUSE_SYNTHETIC_RUNTIME',$RuntimeDirectory,'Process')
    [Environment]::SetEnvironmentVariable('W11_SYNTHETIC_TRAINING_AUTHORIZED','','Process')
    $stdout=Join-Path $temporaryRoot ('research-preview-'+$Port+'-out.txt')
    $stderr=Join-Path $temporaryRoot ('research-preview-'+$Port+'-err.txt')
    $process=Start-Process -FilePath $pythonPath -ArgumentList @('-B',('"'+$serverPath+'"'),[string]$Port) -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
}finally{
    [Environment]::SetEnvironmentVariable('W11_REUSE_SYNTHETIC_RUNTIME',$backupReuse,'Process')
    [Environment]::SetEnvironmentVariable('W11_SYNTHETIC_TRAINING_AUTHORIZED',$backupTraining,'Process')
}
for($attempt=0;$attempt -lt 45;$attempt++){
    $ready=Get-PreviewMode
    if($ready){break}
    if($process.HasExited){throw ('合成服务未能启动，请查看：'+$stderr)}
    Start-Sleep -Milliseconds 500
}
if(-not $ready -or $ready.project_key -ne $projectKey -or $ready.training_enabled -ne $false){throw '尚未核对到本项目的不训练体验服务。未修改其他服务。'}
@{pid=$process.Id;port=$Port;synthetic_only=$true;training_enabled=$false;preview_url=($baseUrl+'/__synthetic__/research-preview');store_id=$ready.store_id} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $temporaryRoot ('research-preview-'+$Port+'.json')) -Encoding UTF8
Write-Output ($baseUrl+'/__synthetic__/research-preview')
