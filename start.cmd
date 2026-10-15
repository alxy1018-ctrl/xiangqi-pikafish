@echo off
REM ====================================================================
REM  Chinese Chess (Xiangqi) - Pikafish opponent
REM
REM  ASCII-only + CRLF on purpose: cmd.exe mis-parses UTF-8 text and
REM  bare LF line endings.
REM
REM  What this does:
REM   1. finds the DSH-bundled node (node is NOT on PATH on this machine)
REM   2. locates Microsoft Edge
REM   3. starts server.js, and hands both the URL and the Edge path over
REM      via environment variables - the SERVER opens the browser itself,
REM      once the port is actually accepting connections
REM
REM  Why the server opens it rather than this script: a fixed "sleep then
REM  open" would pop a dead page when the port is busy (second instance).
REM
REM  Usage:  double-click this file. Close the window (or Ctrl+C) to stop.
REM ====================================================================
setlocal
title Chinese Chess - Pikafish

REM Node writes its console output as UTF-8. On a Chinese Windows the console
REM defaults to code page 936 (GBK), which renders those bytes as mojibake.
REM Switching this console to 65001 makes the Chinese output readable.
chcp 65001 >nul 2>&1

set "NODE_DIR=C:\Users\LXY\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin"
set "NODE=%NODE_DIR%\node.exe"
set "HERE=%~dp0"
if not defined XQ_PORT set "XQ_PORT=19390"

if not exist "%NODE%" (
  echo [ERROR] DSH-bundled node not found at:
  echo         %NODE%
  echo         Edit NODE_DIR in this script if DSH moved.
  pause
  exit /b 3
)

if not exist "%HERE%server.js" (
  echo [ERROR] server.js not found next to this script.
  echo         Expected: %HERE%server.js
  pause
  exit /b 3
)

REM ---- locate Microsoft Edge ----
REM  Careful with REM lines here: cmd expands variables inside them too, and
REM  parentheses in the expanded text break the statement. Keep comments free
REM  of percent signs and parentheses so they cannot blow up the parse.
set "PF86="
if defined ProgramFiles set "PF86=%ProgramFiles% (x86)"
set "EDGE="
if exist "%PF86%\Microsoft\Edge\Application\msedge.exe" set "EDGE=%PF86%\Microsoft\Edge\Application\msedge.exe"
if not defined EDGE if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not defined EDGE if exist "%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe" set "EDGE=%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe"
if not defined EDGE for /f "delims=" %%i in ('where msedge 2^>nul') do if not defined EDGE set "EDGE=%%i"

set "PATH=%NODE_DIR%;%PATH%"
cd /d "%HERE%"

echo Starting Chinese Chess server...
echo   Board  : http://127.0.0.1:%XQ_PORT%/
REM  Do NOT echo the Edge path inside a parenthesised IF block: the "(x86)" in
REM  the path closes the block early and the rest of the path is run as a
REM  command ("...msedge.exe was unexpected at this time"). Labels instead.
if not defined EDGE goto no_edge
echo   Browser: %EDGE%
goto edge_done
:no_edge
echo   Browser: Edge not found - open the URL above manually
:edge_done
echo.
echo Press Ctrl+C to stop.
echo.

REM Tell the server to open the board once it is really listening.
set "XQ_OPEN_URL=http://127.0.0.1:%XQ_PORT%/"
if defined EDGE set "XQ_OPEN_EXE=%EDGE%"

"%NODE%" "%HERE%server.js"

echo.
echo Server stopped.
pause
