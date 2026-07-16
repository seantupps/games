@echo off
REM Build solve_value.pyd (Cython hot path for GOPS Nash).
setlocal
call "D:\Development\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat" || exit /b 1
set DISTUTILS_USE_SDK=1
set MSSdk=1
cd /d "%~dp0"
python setup_cython.py build_ext --inplace
exit /b %ERRORLEVEL%
