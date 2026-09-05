@echo off
cd /d "%~dp0"

set LOGFILE=%~dp0git_push_log.txt

echo ======================================== > "%LOGFILE%"
echo   ADHD-AB Git Auto Script >> "%LOGFILE%"
echo   Time: %date% %time% >> "%LOGFILE%"
echo ======================================== >> "%LOGFILE%"
echo. >> "%LOGFILE%"

echo [1/6] Current branch: >> "%LOGFILE%"
git branch --show-current >> "%LOGFILE%" 2>&1
echo. >> "%LOGFILE%"

echo [2/6] Working tree status (uncommitted changes): >> "%LOGFILE%"
git status --short >> "%LOGFILE%" 2>&1
echo. >> "%LOGFILE%"

echo [3/6] Untracked files: >> "%LOGFILE%"
git ls-files --others --exclude-standard >> "%LOGFILE%" 2>&1
echo. >> "%LOGFILE%"

echo [4/6] Creating branch feature/ab-collab-2026-09-05 and committing... >> "%LOGFILE%"
git checkout -b feature/ab-collab-2026-09-05 >> "%LOGFILE%" 2>&1
git add -A >> "%LOGFILE%" 2>&1
git commit -m "AB collaboration update: 2026-09-05 batch commit" >> "%LOGFILE%" 2>&1
echo. >> "%LOGFILE%"

echo [5/6] Pushing to remote branch... >> "%LOGFILE%"
git push -u origin feature/ab-collab-2026-09-05 >> "%LOGFILE%" 2>&1
echo. >> "%LOGFILE%"

echo [6/6] Switching to main and merging... >> "%LOGFILE%"
git checkout main >> "%LOGFILE%" 2>&1
git merge feature/ab-collab-2026-09-05 --no-edit >> "%LOGFILE%" 2>&1
if %errorlevel% neq 0 (
    echo. >> "%LOGFILE%"
    echo ======================================== >> "%LOGFILE%"
    echo   MERGE CONFLICT! Please resolve manually >> "%LOGFILE%"
    echo ======================================== >> "%LOGFILE%"
    git status >> "%LOGFILE%" 2>&1
) else (
    echo. >> "%LOGFILE%"
    echo Merge successful, pushing to remote main... >> "%LOGFILE%"
    git push origin main >> "%LOGFILE%" 2>&1
    echo. >> "%LOGFILE%"
    echo ======================================== >> "%LOGFILE%"
    echo   ALL DONE! >> "%LOGFILE%"
    echo   feature/ab-collab-2026-09-05 merged to main >> "%LOGFILE%"
    echo ======================================== >> "%LOGFILE%"
)

echo. >> "%LOGFILE%"
echo Script finished at %date% %time% >> "%LOGFILE%"

echo Done! Log saved to git_push_log.txt
type "%LOGFILE%"
echo.
pause
