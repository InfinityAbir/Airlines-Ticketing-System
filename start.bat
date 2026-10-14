@echo off
setlocal EnableExtensions

rem One-command local demo launcher: chain, deployment/seed, upload API, and frontend.
set "ROOT=%~dp0"
set "CHAIN_TITLE=Airline-Chain"
set "UPLOAD_TITLE=Airline-Upload"
set "FRONTEND_TITLE=Airline-Frontend"

cd /d "%ROOT%"

where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js and npm are required. Install Node.js, then run this file again.
  exit /b 1
)

for %%P in (8545 8787 3000) do (
  powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort %%P -State Listen -ErrorAction SilentlyContinue) { exit 1 }"
  if errorlevel 1 (
    echo ERROR: Port %%P is already in use.
    echo Run stop.bat if this project is already running, then try again.
    exit /b 1
  )
)

echo Starting the local blockchain...
rem This batch already changed into ROOT above, so child terminals inherit the
rem correct folder. Avoid nesting the space-containing path in a command string.
start "%CHAIN_TITLE%" cmd.exe /k npm.cmd run node

echo Waiting for the blockchain to be ready...
powershell -NoProfile -Command "$deadline=(Get-Date).AddSeconds(45); do { try { $client=New-Object Net.Sockets.TcpClient; $pending=$client.BeginConnect('127.0.0.1',8545,$null,$null); if($pending.AsyncWaitHandle.WaitOne(250)){ $client.EndConnect($pending); $client.Close(); exit 0 }; $client.Close() } catch {}; Start-Sleep -Milliseconds 250 } while((Get-Date)-lt $deadline); exit 1"
if errorlevel 1 (
  echo ERROR: The local blockchain did not start. Check the %CHAIN_TITLE% window.
  call stop.bat
  exit /b 1
)

echo Deploying contracts and loading the sample flight...
call npm.cmd run deploy -- --network localhost
if errorlevel 1 goto :failed
call npm.cmd run seed -- --network localhost
if errorlevel 1 goto :failed

echo Starting the protected upload service...
start "%UPLOAD_TITLE%" cmd.exe /k npm.cmd run upload

echo Starting the frontend at http://localhost:3000 ...
start "%FRONTEND_TITLE%" cmd.exe /k npx.cmd --yes serve frontend -l 3000

echo.
echo The Airline Ticketing demo is starting in three windows:
echo   Local blockchain: http://127.0.0.1:8545
echo   Upload service:   http://127.0.0.1:8787
echo   Frontend:         http://localhost:3000
echo.
echo Use stop.bat when you are finished.

start "" "http://localhost:3000"
exit /b 0

:failed
echo.
echo ERROR: Deployment or seeding failed. See the message above for details.
call stop.bat
exit /b 1
