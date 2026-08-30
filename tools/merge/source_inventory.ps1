param(
    [Parameter(Mandatory = $true)]
    [string]$Source,

    [Parameter(Mandatory = $true)]
    [ValidateSet('A', 'B')]
    [string]$Label,

    [Parameter(Mandatory = $true)]
    [string]$OutputFile
)

$ErrorActionPreference = 'Stop'

function Get-TextSha256 {
    param([Parameter(Mandatory = $true)][string]$Text)

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
        return ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $sha.Dispose()
    }
}

$resolvedSource = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Source).Path)
if (-not (Test-Path -LiteralPath $resolvedSource -PathType Container)) {
    throw "Source directory does not exist: $resolvedSource"
}

$resolvedOutput = [System.IO.Path]::GetFullPath($OutputFile)
$outputParent = Split-Path -Parent $resolvedOutput
if (-not (Test-Path -LiteralPath $outputParent)) {
    New-Item -ItemType Directory -Path $outputParent -Force | Out-Null
}

$excludedFragments = @(
    '/.git/',
    '/.venv/',
    '/venv/',
    '/node_modules/',
    '/__pycache__/',
    '/.pytest_cache/',
    '/logs/',
    '/tmp/',
    '/downloads/',
    '/backend/artifacts/',
    '/backend/uploads/',
    '/.codex-tmp/',
    '/.worktrees/',
    '/.superpowers/',
    '/.claude/'
)
$excludedNames = @(
    '.env',
    'app.db',
    'Thumbs.db',
    '.DS_Store',
    'project.private.config.json'
)
$excludedExtensions = @('.pyc', '.pyo', '.pt', '.pth', '.ckpt')

$files = foreach ($file in Get-ChildItem -LiteralPath $resolvedSource -File -Recurse -Force) {
    $relative = $file.FullName.Substring($resolvedSource.Length).TrimStart('\', '/')
    $normalized = '/' + ($relative -replace '\\', '/')
    $wrapped = $normalized + $(if ($file.PSIsContainer) { '/' } else { '' })

    $isExcludedPath = $false
    foreach ($fragment in $excludedFragments) {
        if ($wrapped.IndexOf($fragment, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            $isExcludedPath = $true
            break
        }
    }

    if ($isExcludedPath -or
        $excludedNames -contains $file.Name -or
        $excludedExtensions -contains $file.Extension.ToLowerInvariant()) {
        continue
    }

    [ordered]@{
        path = $normalized.TrimStart('/')
        size = $file.Length
        sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}

$files = @($files | Sort-Object path)
$contentLines = $files | ForEach-Object { "{0}`t{1}`t{2}" -f $_.path, $_.size, $_.sha256 }
$contentDigest = Get-TextSha256 -Text ($contentLines -join "`n")

$oldOptionalLocks = $env:GIT_OPTIONAL_LOCKS
$env:GIT_OPTIONAL_LOCKS = '0'
try {
    $gitDirectory = Join-Path $resolvedSource '.git'
    $gitHead = (& git -c "safe.directory=$resolvedSource" -c "safe.directory=$gitDirectory" -C $resolvedSource rev-parse HEAD 2>$null)
    if ($LASTEXITCODE -ne 0) {
        $gitHead = $null
    }

    $gitStatus = @(& git -c "safe.directory=$resolvedSource" -c "safe.directory=$gitDirectory" -C $resolvedSource status --porcelain=v1 -uall 2>$null)
    if ($LASTEXITCODE -ne 0) {
        $gitStatus = @()
    }
}
finally {
    $env:GIT_OPTIONAL_LOCKS = $oldOptionalLocks
}

$inventory = [ordered]@{
    schema_version = 1
    label = $Label
    source = $resolvedSource
    generated_at = [DateTimeOffset]::Now.ToString('o')
    git_head = if ($gitHead) { "$gitHead".Trim() } else { $null }
    git_status = @($gitStatus)
    file_count = $files.Count
    content_digest = $contentDigest
    files = $files
}

$json = $inventory | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($resolvedOutput, $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
$manifestHash = (Get-FileHash -LiteralPath $resolvedOutput -Algorithm SHA256).Hash.ToLowerInvariant()

Write-Output "label=$Label"
Write-Output "files=$($files.Count)"
Write-Output "content_digest=$contentDigest"
Write-Output "manifest_sha256=$manifestHash"
