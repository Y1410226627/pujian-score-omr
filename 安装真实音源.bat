@echo off
setlocal
cd /d "%~dp0"

echo ============================================================
echo   安装真实音色（采样音源：钢琴 / 合唱人声 / 弦乐）
echo ============================================================
echo.
echo 将从网络下载约 16 MB 的免费样本，解包到项目内 .assets\soundfonts 目录。
echo 样本许可：Salamander Grand Piano V3 与 FluidR3_GM，均为 CC BY 3.0（详见装好的 LICENSES.md）。
echo.

where py >nul 2>&1
if %errorlevel%==0 goto use_py
where python >nul 2>&1
if %errorlevel%==0 goto use_python

echo 没找到 Python 3。请先安装 Python 3.7 或更新版本，然后重新双击本文件。
pause
exit /b 1

:use_py
py -3 tools\install_soundfonts.py %*
if errorlevel 1 (
  echo.
  echo 安装失败。请检查网络后重试；也可以直接看上方错误信息。
  pause
  exit /b 1
)
goto done

:use_python
python tools\install_soundfonts.py %*
if errorlevel 1 (
  echo.
  echo 安装失败。请检查网络后重试；也可以直接看上方错误信息。
  pause
  exit /b 1
)

:done
echo.
pause
