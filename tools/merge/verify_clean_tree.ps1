param(
    [string]$Repository = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
    [string]$Python = 'python'
)

$ErrorActionPreference = 'Stop'
$resolvedRepository = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Repository).Path)

Push-Location $resolvedRepository
try {
    & $Python -m unittest tests.test_repository_cleanliness -v
    if ($LASTEXITCODE -ne 0) {
        throw "Repository cleanliness tests failed with exit code $LASTEXITCODE."
    }

    $safeRepository = $resolvedRepository.Replace('\', '/')
    git -c "safe.directory=$safeRepository" diff --check
    if ($LASTEXITCODE -ne 0) {
        throw "git diff --check failed with exit code $LASTEXITCODE."
    }

    Write-Output 'Git working tree status:'
    git -c "safe.directory=$safeRepository" status --short
    if ($LASTEXITCODE -ne 0) {
        throw "git status failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}
