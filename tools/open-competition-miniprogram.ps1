param([string]$DevToolsCommand = '')
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$miniProject = (Resolve-Path -LiteralPath (Join-Path $projectRoot 'miniprogram')).Path
if (-not $DevToolsCommand) {
    $installedCommand = Get-Command wechatide -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($installedCommand) { $DevToolsCommand = $installedCommand.Source }
}
if (-not $DevToolsCommand) {
    $knownLocalCommand = 'D:/微信开发者工具/微信web开发者工具/wechatide.cmd'
    if (Test-Path -LiteralPath $knownLocalCommand -PathType Leaf) { $DevToolsCommand = $knownLocalCommand }
}
if (-not $DevToolsCommand -or -not (Test-Path -LiteralPath $DevToolsCommand -PathType Leaf)) {
    throw 'Specify -DevToolsCommand with the installed wechatide.cmd path. No installation or data was changed.'
}
# Use the current IDE's project-window API and the resolved Windows path. The
# legacy cli open path created a separate failed instance in this installation.
# No account, storage, AppID, SDK or source settings are overwritten here.
& $DevToolsCommand -c codex open_project_window --project $miniProject --window-mode fullMode
if ($LASTEXITCODE -ne 0) { throw 'The IDE did not accept the open-project request. See its returned error.' }
