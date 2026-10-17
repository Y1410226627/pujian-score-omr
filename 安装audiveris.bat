@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================================
echo   安装 Audiveris（本地 OMR 引擎，便携免安装版）
echo ============================================================
echo.
echo 将下载 Audiveris 5.11.0 Windows 版（约 81 MB，自带 Java 运行环境），
echo 并解包到项目内的 .tools\audiveris 目录，不写入系统注册表。
echo.

set "TARGET=%~dp0.tools\audiveris"
set "MSI=%~dp0.tools\audiveris-setup.msi"
set "URL=https://github.com/Audiveris/audiveris/releases/download/5.11.0/Audiveris-5.11.0-windowsConsole-x86_64.msi"

if not exist "%~dp0.tools" mkdir "%~dp0.tools"

if exist "%TARGET%\audiveris.bat" (
  echo Audiveris 已安装：%TARGET%
  goto done
)

echo [1/3] 下载 Audiveris...
curl -L --max-time 1800 --retry 3 -o "%MSI%" "%URL%"
if errorlevel 1 goto download_failed
if not exist "%MSI%" goto download_failed

echo [2/3] 解包到 %TARGET% ...
msiexec /a "%MSI%" /qn TARGETDIR="%TARGET%" /L*v "%~dp0.tools\extract.log"
if errorlevel 1 goto extract_failed

echo [3/3] 清理安装包...
del /q "%MSI%" 2>nul

if exist "%TARGET%\audiveris.bat" goto ok
echo.
echo 解包完成，但没有找到 audiveris.bat。请检查目录结构：
dir /b "%TARGET%"
goto done

:ok
echo.
echo Audiveris 已安装到项目本地目录：%TARGET%
echo 现在重新打开「启动谱见.bat」，识别时会优先使用 Audiveris。
goto done

:download_failed
echo.
echo 下载失败。若本机网络无法直连 GitHub，可手动下载后放到：
echo   %MSI%
echo 然后重新运行本文件。
pause
exit /b 1

:extract_failed
echo.
echo 解包失败，请查看 .tools\extract.log。
pause
exit /b 1

:done
pause
exit /b 0
