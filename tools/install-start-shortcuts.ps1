[CmdletBinding()]
param([string]$ShortcutDirectory = [Environment]::GetFolderPath('Desktop'))
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$shortcutRoot = (Resolve-Path -LiteralPath $ShortcutDirectory).Path
$entry = Join-Path $projectRoot '启动后端.cmd'
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw 'The main backend launcher is missing.' }
$shell = New-Object -ComObject WScript.Shell
$finalPath = Join-Path $shortcutRoot '知行合医-一键启动.lnk'
$arguments = '/d /c ""' + $entry + '""'
$knownEntries = @($entry, (Join-Path $projectRoot '启动竞赛演示.cmd'), (Join-Path $projectRoot 'tools\启动ADHD后端.cmd'))
$legacyNames = @('知行合医-启动后端8000.lnk', '知行合医-示例账号（主系统8000）.lnk', '知行合医-启动竞赛演示8770.lnk')
$remove = @()
function Test-ProjectShortcut([string]$Path) {
    $link = $shell.CreateShortcut($Path)
    if ($link.TargetPath -ne $env:ComSpec) { return $false }
    foreach ($knownEntry in $knownEntries) {
        if ($link.Arguments -eq ('/d /c ""' + $knownEntry + '""')) { return $true }
    }
    return $false
}
# Validate the explicit legacy entries before deleting anything; no recursive deletion.
foreach ($name in $legacyNames) {
    $path = Join-Path $shortcutRoot $name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
    if (-not (Test-ProjectShortcut $path)) { throw ('An unrelated shortcut was preserved: ' + $path) }
    $remove += $path
}
$legacyCmd = Join-Path $shortcutRoot '启动ADHD后端.cmd'
if (Test-Path -LiteralPath $legacyCmd -PathType Leaf) {
    $content = Get-Content -LiteralPath $legacyCmd -Raw -Encoding UTF8
    if ($content -notmatch 'ADHD-AB协作版\\tools\\start-backend\.ps1' -or $content -notmatch 'powershell\.exe') {
        throw 'The old desktop CMD does not match this project; it was preserved.'
    }
    $remove += $legacyCmd
}
if (Test-Path -LiteralPath $finalPath -PathType Leaf) {
    $old = $shell.CreateShortcut($finalPath)
    if ($old.TargetPath -ne $env:ComSpec -or $old.Arguments -ne $arguments) {
        throw 'An unrelated final shortcut already exists; it was preserved.'
    }
}
$hotkey = 'CTRL+ALT+B'
foreach ($item in Get-ChildItem -LiteralPath $shortcutRoot -Filter '*.lnk' -File) {
    if ($item.FullName -eq $finalPath -or $remove -contains $item.FullName) { continue }
    $other = $shell.CreateShortcut($item.FullName)
    $parts = @(([string]$other.Hotkey).ToUpperInvariant().Split('+') | Sort-Object)
    if (($parts -join '+') -eq 'ALT+B+CTRL') {
        $hotkey = ''
        Write-Warning 'Ctrl+Alt+B belongs to another application; use the double-click shortcut.'
    }
}
$backupDirectory = $null
if ($remove.Count -gt 0) {
    $backupDirectory = Join-Path $projectRoot ('.codex-tmp\startup-shortcuts-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
    New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
    foreach ($path in $remove) { Copy-Item -LiteralPath $path -Destination $backupDirectory }
}
$shortcut = $shell.CreateShortcut($finalPath)
$shortcut.TargetPath = $env:ComSpec
$shortcut.Arguments = $arguments
$shortcut.WorkingDirectory = $projectRoot
$shortcut.Description = '知行合医：启动8000主系统、星仔和随访后台；重复启动复用服务。'
$shortcut.WindowStyle = 1
$shortcut.IconLocation = $env:SystemRoot + '\System32\shell32.dll,13'
$shortcut.Hotkey = $hotkey
$shortcut.Save()
foreach ($path in $remove) {
    if ([System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($path)) -ne $shortcutRoot) {
        throw 'Legacy shortcut is outside the selected desktop directory.'
    }
    Remove-Item -LiteralPath $path
}
$shortcut.Save()
$saved = $shell.CreateShortcut($finalPath)
[pscustomobject]@{ path=$finalPath; target=$saved.TargetPath; arguments=$saved.Arguments; hotkey=$saved.Hotkey;
    removed=$remove; backupDirectory=$backupDirectory; stableLauncher=$true } | ConvertTo-Json -Depth 4
