@echo off
setlocal
cd /d "%~dp0"

where py >nul 2>&1
if %errorlevel%==0 goto use_py

where python >nul 2>&1
if %errorlevel%==0 goto use_python

echo 没找到 Python 3。请先安装 Python 3.7 或更新版本，然后重新双击本文件。
echo 安装时请勾选将 Python 添加到 PATH。
pause
exit /b 1

:use_py
py -3 serve.py
if errorlevel 1 (
  echo 启动失败。请检查 Python 3 安装，或查看上方错误信息。
  pause
)
exit /b

:use_python
python serve.py
if errorlevel 1 (
  echo 启动失败。请检查 Python 3 安装，或查看上方错误信息。
  pause
)
exit /b
