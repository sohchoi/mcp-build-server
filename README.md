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
                                  wait remote branch + fetch + auto-commit + checkout + pull
                                  msbuild (each .sln in-place)
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
- Visual Studio 2022 (any edition — provides MSBuild)
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
REMOTE_BRANCH_WAIT_ATTEMPTS=60
REMOTE_BRANCH_WAIT_DELAY_MS=2000
FETCH_BRANCH_MAX_ATTEMPTS=20
FETCH_BRANCH_RETRY_DELAY_MS=3000
BUILD_SCOPE=related         # related (recommended) | all
MSBUILD_PATH=               # Leave empty for auto-detect via vswhere
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

For each push:
1. Finds all `.sln` files in the pushed repo
2. **Recommended:** Set `BUILD_SCOPE=related` to build only solutions whose directories contain changed files — this avoids failing on unrelated broken `.sln` files
3. `BUILD_SCOPE=all` builds every `.sln` in the repo (may fail if any solution has missing projects)

### Build flow details

For each webhook request, the server runs:
1. Enable long-path handling (`git config core.longpaths true`)
2. Wait for `origin/<branch>` to become visible (`git ls-remote --heads origin <branch>`, retry window)
3. `git fetch origin <branch>` (retry on ref-not-found timing race)
4. If repo has uncommitted changes, auto-commit them on current branch
5. Switch repo to `<branch>` (`git checkout` or `git checkout -B <branch> origin/<branch>`)
6. `git pull origin <branch>` to sync working tree
7. Select solution set by `BUILD_SCOPE` (`all` or `related`)
8. `msbuild <solution>.sln /nologo /m /restore` for each solution (parallel build, NuGet restore)

Builds run in-place in the canonical repo (no temporary worktrees or copies).

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
| `POST /mcp` | MCP protocol endpoint (Streamable HTTP) |
| `GET /mcp` | MCP protocol endpoint (GET) |
| `DELETE /mcp` | MCP protocol endpoint (session cleanup) |

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
- The server builds in-place in the canonical repo after checking out the target branch
- Verify your hook sends the expected branch and the branch exists on origin

**`couldn't find remote ref <branch>` happens intermittently**
- This is usually a push/webhook timing race where origin has not exposed the new branch yet
- Tune `.env` retry window:
  - `REMOTE_BRANCH_WAIT_ATTEMPTS`, `REMOTE_BRANCH_WAIT_DELAY_MS`
  - `FETCH_BRANCH_MAX_ATTEMPTS`, `FETCH_BRANCH_RETRY_DELAY_MS`

**Build left unexpected local changes**
- Builds now run in-place in the canonical repo — the repo stays on the built branch after completion
- Any uncommitted changes are auto-committed before branch switch

