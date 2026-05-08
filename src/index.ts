import 'dotenv/config';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createWebhookRouter } from './webhook.js';
import { registerTools } from './mcp-tools.js';
import { startPoller } from './git-poller.js';

const PORT = parseInt(process.env.PORT ?? '8080', 10);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? '';

if (!WEBHOOK_SECRET) {
  console.warn('[warn] WEBHOOK_SECRET is not set — webhook endpoint is unprotected!');
}

const app = express();
app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// /hook-content — returns the raw post-push hook file.
// Simplest install on Mac: cd into repo, then:
//   curl -s http://<VDI>:3333/hook-content > .git/hooks/post-push && chmod +x .git/hooks/post-push
app.get('/hook-content', (req, res) => {
  const host = req.hostname;
  const port = PORT;
  const secret = WEBHOOK_SECRET || 'change-me';
  const hook = `#!/bin/sh
# Auto-installed by MCP Build Server (pre-push hook)
VDI_URL="http://${host}:${port}/webhook"
SECRET="${secret}"
REPO=$(basename "$(git rev-parse --show-toplevel)")
BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || echo "HEAD")
echo "[pre-push] Notifying VDI: repo=$REPO branch=$BRANCH"
HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$VDI_URL" \\
  -H "Content-Type: application/json" \\
  -H "X-Webhook-Secret: $SECRET" \\
  -d "{\\"repo\\":\\"$REPO\\",\\"branch\\":\\"$BRANCH\\"}" \\
  --max-time 5)
[ "$HTTP" = "200" ] && echo "[pre-push] Build triggered on VDI" || echo "[pre-push] WARNING: HTTP $HTTP"
`;
  res.setHeader('Content-Type', 'text/plain');
  res.send(hook);
});

// /install-hook — shell script installer (for curl | sh usage)
app.get('/install-hook', (req, res) => {
  const host = req.hostname;
  const port = PORT;
  const secret = WEBHOOK_SECRET || 'change-me';
  const script = `#!/bin/sh
REPO_DIR="\$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "\$REPO_DIR" ]; then
  echo "ERROR: Not inside a git repository."
  exit 1
fi
HOOK="\$REPO_DIR/.git/hooks/post-push"
curl -s "http://${host}:${port}/hook-content" > "\$HOOK" && chmod +x "\$HOOK"
echo "Hook installed: \$HOOK"
`;
  res.setHeader('Content-Type', 'text/plain');
  res.send(script);
});

// Post-push webhook
app.use('/webhook', createWebhookRouter(WEBHOOK_SECRET));

// MCP server (Streamable HTTP transport)
const mcpServer = new McpServer({
  name: 'mcp-build-server',
  version: '1.0.0',
});
registerTools(mcpServer);

// Each MCP session gets its own transport instance
app.post('/mcp', async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });
  res.on('close', () => { transport.close().catch(() => {}); });
  await mcpServer.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get('/mcp', async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on('close', () => { transport.close().catch(() => {}); });
  await mcpServer.connect(transport);
  await transport.handleRequest(req, res);
});

app.delete('/mcp', async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on('close', () => { transport.close().catch(() => {}); });
  await mcpServer.connect(transport);
  await transport.handleRequest(req, res);
});

app.listen(PORT, () => {
  console.log(`MCP Build Server running on http://localhost:${PORT}`);
  console.log(`  Webhook:    POST http://localhost:${PORT}/webhook`);
  console.log(`  MCP:        http://localhost:${PORT}/mcp`);
  console.log(`  Health:     http://localhost:${PORT}/health`);
  startPoller().catch((e: unknown) => console.error('[poller] startup error:', e));
});
