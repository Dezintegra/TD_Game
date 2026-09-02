@echo off
rem =====================================================================
rem  Pipeline supervisor launcher for Windows. Double-click to run.
rem
rem  ASCII only, on purpose. cmd.exe reads batch files in the OEM code
rem  page (866 on Russian Windows), and a UTF-8 byte order mark breaks
rem  the very first line. Every Russian message therefore lives in
rem  bin\launch.mjs, which Node always reads as UTF-8.
rem
rem  Usage:
rem    start.cmd                  run and watch
rem    start.cmd --shadow         dry run: decide and print, touch nothing
rem    start.cmd --detached       run in background, log to .pipeline
rem    start.cmd --stop           stop a running supervisor
rem
rem  With no arguments and started by a double-click the window waits for
rem  a key at the end, so the last message stays readable. Any argument
rem  turns that off, which is what keeps a scheduled task from hanging.
rem =====================================================================

rem The console speaks code page 866 by default; the supervisor speaks
rem UTF-8. Without this the whole Russian output arrives as mojibake.
chcp 65001 >nul

setlocal

rem Pre-set, so the "node is missing" path below still exits non-zero:
rem it jumps straight to :finish and never reaches the assignment.
set "SUPERVISOR_EXIT=1"

where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo   Node.js not found in PATH.
    echo   The supervisor is a plain Node program; nothing runs without it.
    echo   Version 20.12 or newer is required.
    echo.
    goto :finish
)

node "%~dp0bin\launch.mjs" %*
set "SUPERVISOR_EXIT=%ERRORLEVEL%"

:finish
rem Keep the window open when started by a double-click, otherwise it
rem vanishes together with the last message. When launched from an open
rem console the message stays on screen anyway, so no key is needed.
rem
rem Two conditions, and the second one matters more than it looks. A double
rem click never passes arguments, so requiring "no arguments" makes it
rem impossible to hang a scheduled task: whatever the scheduler runs, it
rem runs with --detached or --stop, and never waits for a key nobody will
rem press. An opt-out flag would have worked too, right up to the day
rem somebody forgets it.
if not "%~1"=="" goto :done
echo %cmdcmdline% | find /i "%~nx0" >nul
if not errorlevel 1 pause

:done
endlocal & exit /b %SUPERVISOR_EXIT%
