@echo off
REM post-push git hook (Windows CMD version)
REM Copy to .git\hooks\post-push.bat and call it from .git\hooks\post-push:
REM   #!/bin/sh
REM   exec "$(dirname "$0")/post-push.bat"
REM
REM Variables to configure:
SET VDI_URL=http://<VDI_IP_OR_HOSTNAME>:3333/webhook
SET SECRET=change-me-to-something-random

FOR /F "delims=" %%i IN ('git rev-parse --show-toplevel') DO SET REPO_PATH=%%i
FOR %%i IN ("%REPO_PATH%") DO SET REPO=%%~ni
FOR /F "delims=" %%b IN ('git symbolic-ref --short HEAD 2^>nul') DO SET BRANCH=%%b
IF NOT DEFINED BRANCH SET BRANCH=HEAD

echo [post-push] Notifying VDI build server: repo=%REPO% branch=%BRANCH%

curl -s -o NUL -w "%%{http_code}" ^
  -X POST "%VDI_URL%" ^
  -H "Content-Type: application/json" ^
  -H "X-Webhook-Secret: %SECRET%" ^
  -d "{\"repo\":\"%REPO%\",\"branch\":\"%BRANCH%\"}" ^
  --max-time 5 > %TEMP%\vdi_result.txt

SET /P RESULT=<%TEMP%\vdi_result.txt
IF "%RESULT%"=="200" (
  echo [post-push] Build triggered on VDI
) ELSE (
  echo [post-push] WARNING: VDI notification returned HTTP %RESULT%
)
