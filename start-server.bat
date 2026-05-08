@echo off
REM Start MCP Build Server — run this to (re)start the server on the VDI
REM To auto-start on login, add a shortcut to this file in:
REM   shell:startup  (Win+R → shell:startup)

cd /d D:\mcp-build-server
echo Starting MCP Build Server on port 3333...
node dist\index.js >> server.log 2>> server-err.log
