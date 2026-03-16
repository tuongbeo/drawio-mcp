#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# setup-cloudflare-secret.sh
# Run this ONCE locally to add CLOUDFLARE_API_TOKEN to GitHub Actions secrets.
# Requires: curl, gh CLI (https://cli.github.com) OR just curl + Python
#
# Usage:
#   bash setup-cloudflare-secret.sh <YOUR_CF_TOKEN> <GITHUB_TOKEN>
#
# Example:
#   bash setup-cloudflare-secret.sh VAQdSDwLC-... ghp_2pb9VQ...
# ─────────────────────────────────────────────────────────────────

set -e

CF_TOKEN="${1:?Usage: $0 <CF_TOKEN> <GITHUB_TOKEN>}"
GITHUB_TOKEN="${2:?Usage: $0 <CF_TOKEN> <GITHUB_TOKEN>}"
REPO="tuongbeo/drawio-mcp"
SECRET_NAME="CLOUDFLARE_API_TOKEN"

echo "→ Fetching GitHub repo public key..."
PUB_KEY_RESPONSE=$(curl -sS \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/repos/$REPO/actions/secrets/public-key")

KEY_ID=$(echo "$PUB_KEY_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['key_id'])")
PUB_KEY=$(echo "$PUB_KEY_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['key'])")

echo "→ Public key ID: $KEY_ID"
echo "→ Encrypting secret with libsodium (PyNaCl)..."

ENCRYPTED=$(python3 << PYEOF
import base64
from nacl import encoding, public

pub_key_bytes = base64.b64decode("$PUB_KEY")
sealed_box = public.SealedBox(public.PublicKey(pub_key_bytes))
encrypted = sealed_box.encrypt("$CF_TOKEN".encode())
print(base64.b64encode(encrypted).decode())
PYEOF
)

echo "→ Uploading encrypted secret to GitHub..."
RESULT=$(curl -sS -X PUT \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  -H "Content-Type: application/json" \
  "https://api.github.com/repos/$REPO/actions/secrets/$SECRET_NAME" \
  -d "{\"encrypted_value\":\"$ENCRYPTED\",\"key_id\":\"$KEY_ID\"}")

echo "Result: $RESULT"
echo ""
echo "✓ Done! CLOUDFLARE_API_TOKEN secret added to $REPO"
echo "  GitHub Actions will use it on the next push to main."
