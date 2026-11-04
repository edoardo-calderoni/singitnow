@echo off
rem Avvia SingITnow in una finestra nativa (senza console). Log in data\singitnow.log
cd /d "%~dp0"
start "" ".venv\Scripts\pythonw.exe" -m singitnow %*
