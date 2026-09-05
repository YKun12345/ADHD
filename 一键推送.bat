@echo off
chcp 65001 >nul
cd /d "C:\Users\Lenovo\Desktop\ADHD-AB协作版"

echo ========================================
echo   ADHD 项目 Git 状态检查与推送
echo ========================================
echo.

echo [1/4] 当前分支：
git branch --show-current
echo.

echo [2/4] 工作区状态：
git status --short
echo.

echo [3/4] 未推送的提交：
git log origin/main..main --oneline
echo.

echo [4/4] 正在推送到远程仓库...
git push origin main
echo.

if %errorlevel% equ 0 (
    echo ========================================
    echo   推送成功！
    echo ========================================
) else (
    echo ========================================
    echo   推送失败，请检查上方错误信息
    echo ========================================
)

echo.
pause
