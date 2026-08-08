@echo off
rem Arranca el servidor Whisper local a mano.
rem AdminTerm lo levanta solo al pulsar el microfono; esto es para depurar
rem o para dejarlo corriendo por tu cuenta.
setlocal
cd /d "%~dp0"

set PYTHON=python
if exist "C:\Python311\python.exe" set PYTHON=C:\Python311\python.exe

"%PYTHON%" server.py --model small --port 8756 %*
pause
