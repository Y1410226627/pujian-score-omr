@echo off
setlocal
cd /d "%~dp0"

rem 从网上下载的压缩包会给文件加上「来自网络」标记，双击 .bat 时 Windows 会弹
rem 「打开文件 - 安全警告 / 无法验证发布者」。这里在启动时顺手解除本项目文件的该标记，
rem 只需要成功运行过一次，之后双击就不会再弹（详见 README「第一次运行被 Windows 拦下怎么办」）。
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath '%~dp0' -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue" >nul 2>&1

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
