@echo off
title Opengrep Studio 码审工作台
setlocal
cd /d "%~dp0"

rem 后台探测进程入口：轮询前端端口，就绪后自动打开浏览器
if /i "%~1"=="waitopen" goto waitopen

echo ================================================
echo   Opengrep Studio 一键启动
echo ================================================
echo.

echo [1/5] 检查 Node.js 环境...
where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 未检测到 Node.js，请安装 22.12 或更高版本：https://nodejs.org
    pause
    exit /b 1
)
set "NODE_VER="
for /f "delims=" %%i in ('node -v') do set "NODE_VER=%%i"
set "NODE_MAJOR="
set "NODE_MINOR="
for /f "tokens=1,2 delims=v." %%a in ("%NODE_VER%") do (
    set "NODE_MAJOR=%%a"
    set "NODE_MINOR=%%b"
)
if "%NODE_MAJOR%"=="" set "NODE_MAJOR=0"
if "%NODE_MINOR%"=="" set "NODE_MINOR=0"
echo     当前版本 %NODE_VER%
if %NODE_MAJOR% LSS 22 goto node_too_old
if %NODE_MAJOR% EQU 22 if %NODE_MINOR% LSS 12 goto node_too_old
where npm >nul 2>nul
if errorlevel 1 (
    echo [错误] 未检测到 npm，请重新安装 Node.js：https://nodejs.org
    pause
    exit /b 1
)

echo [2/5] 检查项目依赖...
set "NEED_INSTALL=0"
if not exist "node_modules" set "NEED_INSTALL=1"
if not exist "server\node_modules" set "NEED_INSTALL=1"
if not exist "code\node_modules" set "NEED_INSTALL=1"
if "%NEED_INSTALL%"=="1" (
    echo     依赖缺失，正在自动安装（首次可能需要几分钟）...
    call npm run install:all
    if errorlevel 1 (
        echo [错误] 依赖安装失败，请检查网络后重试，或手动执行 npm run install:all
        pause
        exit /b 1
    )
) else (
    echo     依赖完整，跳过安装
)

echo [3/5] 检查 opengrep 引擎...
if defined OPENGREP_BIN (
    echo     已设置 OPENGREP_BIN，跳过引擎下载（后端直接用该二进制）
) else if not exist "opengrep-tool\opengrep.exe" (
    echo     引擎缺失，正在从官方 Release 下载并校验（约 50MB，首次需要等待）...
    call npm run setup:engine
    if errorlevel 1 (
        echo [错误] 引擎下载失败。网络受限时可先执行 set OPENGREP_DOWNLOAD_BASE=镜像地址 再重试，
        echo         或手动下载：https://github.com/opengrep/opengrep/releases
        echo         （重命名为 opengrep.exe 放入 opengrep-tool\ 目录，或设置 OPENGREP_BIN 指向它）
        pause
        exit /b 1
    )
) else (
    echo     引擎已就绪
)

echo [4/5] 启动前后端服务...
echo     端口被占用时自动顺延：绝不终止已在运行的实例（可能有人正在使用）
echo     默认前端: http://localhost:1022    默认后端: http://localhost:8787
echo     提示：关闭本窗口即停止本次启动的全部服务
echo [5/5] 前端就绪后将自动打开浏览器（后台探测进行中）
echo.
rem 派出后台探测进程：前端端口就绪后自动打开浏览器（最多等 40 秒）。
rem 打开的是"新出现"的监听端口：若 1022 已被别的实例占用、本次顺延到 1023+，
rem 不能错开成打开旧实例的 1022。
start "" /b cmd /c ""%~f0" waitopen"
call npm run dev

echo.
echo 服务已停止。
pause
exit /b 0

:waitopen
setlocal enabledelayedexpansion
rem 快照启动前 1022-1031 中已监听的端口：之后"新出现"的监听端口才属于本次实例
set "BEFORE= "
for /l %%P in (1022,1,1031) do (
    %SystemRoot%\System32\netstat.exe -ano | %SystemRoot%\System32\findstr.exe /C:":%%P " | %SystemRoot%\System32\findstr.exe /C:"LISTENING" >nul 2>&1
    if not errorlevel 1 set "BEFORE=!BEFORE!%%P "
)
set /a TRIES=0
:waitloop
%SystemRoot%\System32\ping.exe -n 3 127.0.0.1 >nul
for /l %%P in (1022,1,1031) do (
    echo(!BEFORE! | %SystemRoot%\System32\findstr.exe /C:" %%P " >nul 2>&1
    if errorlevel 1 (
        %SystemRoot%\System32\netstat.exe -ano | %SystemRoot%\System32\findstr.exe /C:":%%P " | %SystemRoot%\System32\findstr.exe /C:"LISTENING" >nul 2>&1
        if not errorlevel 1 (
            endlocal
            start "" http://127.0.0.1:%%P/
            exit /b 0
        )
    )
)
set /a TRIES+=1
if !TRIES! LSS 60 goto waitloop
exit /b 0

:node_too_old
echo [错误] Node.js 版本过低（%NODE_VER%），本项目要求 ≥ 22.12（后端内置 node:sqlite 需 22.5+，前端 Vite 8 需 22.12+）
pause
exit /b 1
