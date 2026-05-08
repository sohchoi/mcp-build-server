#!/bin/sh
# Run this script ON YOUR LOCAL MAC to install the post-push hook into a repo.
#
# Usage:
#   sh install-hook.sh /path/to/your/local/repo
#
# Example:
#   sh install-hook.sh ~/dev/Qoo10DevJP

VDI_URL="http://172.30.12.152:3333/webhook"
SECRET="test-secret-123"

REPO_DIR="${1:-$(pwd)}"

if [ ! -d "$REPO_DIR/.git" ]; then
  echo "ERROR: $REPO_DIR is not a git repository"
  exit 1
fi

HOOK_PATH="$REPO_DIR/.git/hooks/post-push"

cat > "$HOOK_PATH" << HOOKEOF
#!/bin/sh
VDI_URL="$VDI_URL"
SECRET="$SECRET"

REPO=\$(basename "\$(git rev-parse --show-toplevel)")
BRANCH=\$(git symbolic-ref --short HEAD 2>/dev/null || echo "HEAD")

echo "[post-push] Notifying VDI build server: repo=\$REPO branch=\$BRANCH"
RESULT=\$(curl -s -o /dev/null -w "%{http_code}" \\
  -X POST "\$VDI_URL" \\
  -H "Content-Type: application/json" \\
  -H "X-Webhook-Secret: \$SECRET" \\
  -d "{\"repo\":\"\$REPO\",\"branch\":\"\$BRANCH\"}" \\
  --max-time 5)

if [ "\$RESULT" = "200" ]; then
  echo "[post-push] Build triggered on VDI ✅"
else
  echo "[post-push] WARNING: VDI returned HTTP \$RESULT (server may be offline)"
fi
HOOKEOF

chmod +x "$HOOK_PATH"
echo "Hook installed at $HOOK_PATH"
echo "Test with: curl http://172.30.12.152:3333/health"
