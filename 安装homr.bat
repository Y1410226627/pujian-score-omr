@echo off
setlocal
cd /d "%~dp0"

where py >nul 2>&1
if errorlevel 1 goto use_python

if not exist ".venv\Scripts\python.exe" (
  py -3 -m venv --without-pip .venv
  if errorlevel 1 goto failed
)
py -3 -m pip --python ".venv\Scripts\python.exe" install --no-cache-dir -r requirements-homr.txt
if errorlevel 1 goto failed
goto done

:use_python
where python >nul 2>&1
if errorlevel 1 goto no_python
if not exist ".venv\Scripts\python.exe" (
  python -m venv --without-pip .venv
  if errorlevel 1 goto failed
)
python -m pip --python ".venv\Scripts\python.exe" install --no-cache-dir -r requirements-homr.txt
if errorlevel 1 goto failed
goto done

:no_python
echo 没找到 Python 3.11 或更新版本。请先安装 Python，再重新运行本文件。
pause
exit /b 1

:failed
echo homr 安装失败。请检查网络和 Python 版本，并查看上方错误信息。
pause
exit /b 1

:done
echo homr 已安装到项目本地环境。首次识谱时，上游模型可能还需要联网下载。
pause
exit /b 0
