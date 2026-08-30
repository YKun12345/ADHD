param(
    [string]$Repository = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
)

$ErrorActionPreference = 'Stop'
$resolvedRepository = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Repository).Path)

Push-Location $resolvedRepository
try {
    python -m unittest tests.test_repository_cleanliness -v
    if ($LASTEXITCODE -ne 0) {
        throw "Repository cleanliness tests failed with exit code $LASTEXITCODE."
    }

    git diff --check
    if ($LASTEXITCODE -ne 0) {
        throw "git diff --check failed with exit code $LASTEXITCODE."
    }

    Write-Output 'Git working tree status:'
    git status --short
    if ($LASTEXITCODE -ne 0) {
        throw "git status failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}
