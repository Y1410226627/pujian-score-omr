@echo off
setlocal
cd /d "%~dp0"

echo ============================================================
echo   安装真实音色（采样音源：钢琴 / 弦乐 / 合唱 / 民乐 / 打击乐 / 管乐 / 键盘）
echo ============================================================
echo.
echo 全部安装约 220 MB，下载到项目内 .assets\soundfonts 目录（不进 git）。
echo   . 钢琴：Meta Open Piano（CC0，4 层力度 x 88 键）
echo   . 尼龙弦 / 钢弦吉他：Meta Open Guitar（CC0，各 3 层 x 88 键）
echo   . 合唱：Sonatina Symphonic Orchestra 的女声 / 男声 / 混声合唱（CC Sampling Plus 1.0）
echo   . 弦乐细分 / 管乐 / 键盘：FluidR3_GM（CC BY 3.0）
echo   . 民族打击乐近似采样：VCSL（CC0 1.0）
echo.
echo 注意：中阮 / 柳琴目前用 Meta 尼龙弦 / 钢弦吉他近似，不是真实中阮 / 柳琴录音。
echo 许可与署名详见装好的 LICENSES.md。
echo.
echo 只装某一类可以带参数（在命令行里运行本文件或下面这行）：
echo   py -3 tools\install_soundfonts.py --only voice
echo   py -3 tools\install_soundfonts.py --only strings winds keys
echo   py -3 tools\install_soundfonts.py --only china percussion
echo   py -3 tools\install_soundfonts.py --list
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
