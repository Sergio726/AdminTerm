@echo off
rem Lanza AdminTerm. La propia app pide UAC al arrancar (se puede desactivar en Ajustes).
setlocal
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo Faltan las dependencias. Ejecutando npm install...
  call npm install || goto :error
)

start "" "node_modules\electron\dist\electron.exe" "%~dp0." %*
exit /b 0

:error
echo.
echo No se pudo preparar AdminTerm. Revisa que Node.js este instalado.
pause
exit /b 1
