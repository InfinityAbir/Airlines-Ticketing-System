@echo off
setlocal EnableExtensions

rem Stops only the command windows started by this project's start.bat.
echo Stopping the Airline Ticketing demo...

for %%T in ("Airline-Chain*" "Airline-Upload*" "Airline-Frontend*") do (
  taskkill /F /T /FI "WINDOWTITLE eq %%~T" >nul 2>&1
)

echo.
echo Done. The local blockchain, upload service, and frontend have been stopped.
echo Press any key to close this window.
pause >nul
endlocal
exit /b 0
