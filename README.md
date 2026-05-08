# mcp-build-server

An MCP (Model Context Protocol) server that runs on your Windows VDI and automatically builds your .NET solution whenever you push code from your local machine. Integrates with GitHub Copilot CLI so you can query build results directly in your terminal.

## How it works

```
Local Mac/Windows  -->  git push  -->  TFS/Git server
                                            |
                              pre-push hook
                                            v
                                    VDI (Windows)
                                  mcp-build-server
                                  git fetch + checkout
                                  dotnet build (related solutions)
                                            |
                                            v
                               GitHub Copilot CLI (MCP tools)
                               build_status / list_build_history
```

---

## VDI Setup (Windows — required)

### Prerequisites
- Node.js 18+ ([nodejs.org](https://nodejs.org))
- .NET SDK ([dotnet.microsoft.com](https://dotnet.microsoft.com/download))
- Git

### 1. Clone and install

```powershell
cd D:\
git clone https://github.com/sohchoi/mcp-build-server.git
cd mcp-build-server
npm install
npm run build
```

### 2. Configure environment

Copy `.env.example` to `.env` and edit:

```powershell
copy .env.example .env
notepad .env
```

```env
PORT=8080
REPOS_BASE_DIR=D:\          # Root folder containing your git repos (e.g. D:\Qoo10DevJP lives here)
WEBHOOK_SECRET=your-secret  # Any random string — must match what the hook sends
MAX_BUILDS_PER_REPO=20
```

### 3. Open Windows Firewall for port 8080

Run in PowerShell as Administrator:

```powershell
New-NetFirewallRule -DisplayName "MCP Build Server" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow
```

### 4. Start the server

```powershell
cd D:\mcp-build-server
node dist/index.js
```

To run it persistently (survives logoff), use Task Scheduler or NSSM to run `node dist/index.js` from `D:\mcp-build-server` as a background service.

### 5. Configure Copilot CLI

Add to your Copilot CLI MCP config (`%APPDATA%\GitHub Copilot\mcp.json` or `~/.config/github-copilot/mcp.json`):

```json
{
  "mcpServers": {
    "build": {
      "type": "http",
      "url": "http://localhost:8080/mcp"
    }
  }
}
```

> Use `localhost` since Copilot CLI runs on the same VDI as the server.

---

## Local Machine Setup

### Find your VDI IP

On the VDI, run:

```powershell
ipconfig | Select-String "IPv4"
```

Note the IP (e.g. `172.30.12.152`). Port 8080 must be reachable from your local machine — test with:

```sh
# Mac / Linux
curl -v --max-time 5 http://<VDI_IP>:8080/health

# Windows
Invoke-WebRequest -Uri "http://<VDI_IP>:8080/health" -TimeoutSec 5
```

### Mac local setup

In your git repo directory (e.g. `~/source/Qoo10DevJP`):

```sh
mkdir -p .git/hooks
curl -s "http://<VDI_IP>:8080/hook-content" > .git/hooks/pre-push
chmod +x .git/hooks/pre-push
```

Verify it was installed:

```sh
cat .git/hooks/pre-push
```

Now every `git push` will instantly notify the VDI to build.

### Windows local setup

In your git repo directory:

```powershell
# Create hooks directory if needed
New-Item -ItemType Directory -Force -Path ".git\hooks"

# Download the hook script
Invoke-WebRequest -Uri "http://<VDI_IP>:8080/hook-content" -OutFile ".git\hooks\pre-push"

# Make it executable (Git for Windows respects this)
# No chmod needed on Windows — Git will run it as-is
```

> **Note:** The hook is a shell script. It requires Git for Windows (which includes Git Bash). Make sure `curl` is available in your PATH (Git for Windows includes it).

---

## Per-repo build configuration

By default the server auto-detects which `.sln` files are related to your changed files and builds only those.

To customize, create `.mcp-build.json` in your repo root:

```json
{
  "solutions": [
    "Backend\\MyProject\\MyProject.sln"
  ]
}
```

Or to exclude specific broken solutions:

```json
{
  "excluded": [
    "Backend\\BrokenProject\\BrokenProject.sln"
  ]
}
```

If neither field is set, the server:
1. Finds all `.sln` files in the repo
2. Compares them against files changed in your branch vs `master`
3. Builds only the solutions that contain changed files

---

## MCP Tools (Copilot CLI)

Once the server is running, ask Copilot CLI:

| What to ask | What it does |
|---|---|
| `what repos are available?` | Lists all git repos under `REPOS_BASE_DIR` |
| `what's the build status of Qoo10DevJP?` | Shows last build result for the repo |
| `build history for Qoo10DevJP` | Lists recent builds with status |
| `trigger a build for Qoo10DevJP on my branch` | Manually starts a build |

---

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /health` | Server health check |
| `POST /webhook` | Receives push notifications from the pre-push hook |
| `GET /hook-content` | Returns the pre-push hook script (pipe to a file to install) |
| `GET /mcp` / `POST /mcp` | MCP protocol endpoint |

---

## Troubleshooting

**Hook not firing on push**
- Check the file is named exactly `pre-push` (not `post-push`)
- Check it is executable: `ls -la .git/hooks/pre-push` (Mac) — should show `-rwxr-xr-x`
- On Windows, confirm Git Bash / Git for Windows is installed

**Build not triggered (hook fires but VDI doesn't build)**
- Check `WEBHOOK_SECRET` matches in `.env` and the hook script
- Check the VDI server is running: `curl http://localhost:8080/health`

**Wrong branch built**
- The server always does `git fetch origin <branch>` + `git checkout -B <branch> origin/<branch>` before building

**Admin.sln GUID error (MSB4051)**
- A project is referenced in the solution but missing from the `.sln` file
- Open the `.sln` in a text editor, find the missing GUID in `ProjectReferences`, locate the `.csproj` file, and add a `Project(...)` entry

