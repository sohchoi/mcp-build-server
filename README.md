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
                                  git stash (if dirty) + fetch + checkout
                                  dotnet build (related solutions)
                                            |
                                            v
                               GitHub Copilot CLI (MCP tools)
                               build_status / list_build_history
```

The push itself is **not blocked** by webhook failure.  
If VDI is unreachable, the hook prints a warning and push still continues.

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

### 4.1 Server operation commands (Windows VDI)

```powershell
# start
cd D:\mcp-build-server
node dist/index.js

# stop (same terminal)
Ctrl + C

# stop (background process on 8080)
$pid = (Get-NetTCPConnection -LocalPort 8080 -State Listen | Select-Object -First 1 -ExpandProperty OwningProcess)
Stop-Process -Id $pid

# health check
Invoke-WebRequest -Uri "http://localhost:8080/health" -UseBasicParsing
```

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

## Build selection

The server has no per-repo config or repo-specific restrictions.

For each push:
1. Finds all `.sln` files in the pushed repo
2. Compares changed files in your branch vs `master` (or `main`)
3. Builds solutions related to those changed paths

### Build flow details

For each webhook request, the server runs:
1. `git status --porcelain`
2. If dirty: `git stash push -u -m "mcp-auto-stash:<timestamp>:<branch>"`
3. `git fetch origin <branch>`
4. `git checkout -B <branch> origin/<branch>`
5. Find all `.sln` files and select related solutions by changed path
6. `dotnet build <solution>.sln --nologo` for each related solution
7. If a solution fails with `MSB4051`, auto-repair the missing project GUID in `.sln` and retry that solution once

### Important repo-name rule

The hook sends `repo` as your local folder name (basename of `git rev-parse --show-toplevel`).  
That name must match a VDI folder under `REPOS_BASE_DIR`.

Example:
- Local: `/Users/sohchoi/source/Qoo10DevJP`
- VDI: `D:\Qoo10DevJP`
- Sent repo value: `Qoo10DevJP`

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
- If the VDI repo has uncommitted changes, the server auto-stashes them first (`git stash push -u`) and then switches to the pushed branch

**I need my previous uncommitted files after auto-stash**
- On VDI repo:
  - `git stash list`
  - `git stash show -p stash@{0}`
  - `git stash apply stash@{0}` (or `git stash pop stash@{0}`)

**Admin.sln GUID error (MSB4051)**
- A project is referenced in the solution but missing from the `.sln` file
- The server now tries to auto-fix this by adding the missing project entry and retrying once
- If the GUID does not exist in any `.csproj`, the server removes dangling `ProjectDependencies` entry for that missing GUID and retries once
- If auto-repair still fails, check whether the missing GUID exists in any `.csproj` `<ProjectGuid>` under the repo
- If not found, add/fix the project manually in the solution and push again

**MSB4019 missing `Microsoft.WebApplication.targets`**
- This means the machine is missing a usable Visual Studio WebApplication targets path for the project type
- The server now auto-retries with a detected `VSToolsPath` when this error appears
- If your environment is custom, set `VSTOOLS_PATH` in `.env` explicitly (example: `C:\Program Files (x86)\MSBuild\Microsoft\VisualStudio\v17.0`)

