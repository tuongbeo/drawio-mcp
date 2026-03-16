#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# setup-and-deploy.sh — Run once from your local machine
# Sets CLOUDFLARE_API_TOKEN secret + triggers first GitHub Actions deployment
#
# Usage:
#   export GITHUB_TOKEN=ghp_xxx   # your GitHub PAT (needs repo + workflow scope)
#   export CF_TOKEN=VAQdxxx       # your Cloudflare API token
#   bash setup-and-deploy.sh
# ═══════════════════════════════════════════════════════════════
set -e

GITHUB_TOKEN="${GITHUB_TOKEN:?Set GITHUB_TOKEN env var}"
CF_TOKEN="${CF_TOKEN:?Set CF_TOKEN env var}"
REPO="tuongbeo/drawio-mcp"
SECRET_NAME="CLOUDFLARE_API_TOKEN"

echo "▶ Step 1: Fetch GitHub repo public key..."
PUB_KEY_RESPONSE=$(curl -sS \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/repos/$REPO/actions/secrets/public-key")

KEY_ID=$(echo "$PUB_KEY_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['key_id'])")
PUB_KEY=$(echo "$PUB_KEY_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['key'])")
echo "  Key ID: $KEY_ID"

echo "▶ Step 2: Encrypt CF token with repo public key (requires PyNaCl)..."
ENCRYPTED=$(python3 - "$PUB_KEY" "$CF_TOKEN" <<'PYEOF'
import sys, base64
from nacl import public
pub_key = sys.argv[1]
secret  = sys.argv[2]
box = public.SealedBox(public.PublicKey(base64.b64decode(pub_key)))
print(base64.b64encode(box.encrypt(secret.encode())).decode())
PYEOF
)

echo "▶ Step 3: Upload secret to GitHub Actions..."
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" -X PUT \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  -H "Content-Type: application/json" \
  "https://api.github.com/repos/$REPO/actions/secrets/$SECRET_NAME" \
  -d "{\"encrypted_value\":\"$ENCRYPTED\",\"key_id\":\"$KEY_ID\"}")

[ "$STATUS" = "201" ] || [ "$STATUS" = "204" ] \
  && echo "  ✓ Secret added (HTTP $STATUS)" \
  || { echo "  ✗ Failed (HTTP $STATUS)"; exit 1; }

echo "▶ Step 4: Trigger GitHub Actions deployment..."
STATUS2=$(curl -sS -o /dev/null -w "%{http_code}" -X POST \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/repos/$REPO/actions/workflows/deploy-worker.yml/dispatches" \
  -d '{"ref":"main"}')

[ "$STATUS2" = "204" ] && echo "  ✓ Deployment triggered!" || echo "  ✗ Dispatch HTTP $STATUS2"

echo ""
echo "═══════════════════════════════════════════════════"
echo "✓ Done! Watch deployment at:"
echo "  https://github.com/$REPO/actions"
echo ""
echo "  Worker URL (ready in ~60s):"
echo "  https://drawio.tuongbeo.workers.dev/mcp"
echo "═══════════════════════════════════════════════════"
