#!/bin/bash
set -e

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
FORGE="$HOME/.foundry/bin/forge"

echo "=== MeanTime Deploy ==="
echo ""

# 1. Env check
if [ ! -f "$REPO_ROOT/.env" ]; then
  echo "ERROR: .env not found."
  exit 1
fi
source "$REPO_ROOT/.env"

if [ -z "$PRIVATE_KEY" ] || [ "$PRIVATE_KEY" = "your_private_key_here" ]; then
  echo "ERROR: PRIVATE_KEY not set in .env"
  exit 1
fi
if [ -z "$ARC_RPC_URL" ]; then
  echo "ERROR: ARC_RPC_URL not set in .env"
  exit 1
fi

# 2. Build
echo "Building contracts..."
"$FORGE" build --silent
echo "Build OK"
echo ""

# 3. Local tests
echo "Running tests..."
"$FORGE" test --silent
echo "All tests passed"
echo ""

# 4. Deploy
echo "Deploying to Arc testnet ($ARC_RPC_URL)..."
echo ""

"$FORGE" script contracts/scripts/DeployMeanTime.s.sol:DeployMeanTime \
  --rpc-url "$ARC_RPC_URL" \
  --broadcast \
  --legacy

echo ""

# 5. Verify deployments.json was written
if [ ! -f "$REPO_ROOT/deployments.json" ]; then
  echo "ERROR: deployments.json was not written."
  exit 1
fi

echo "=== Deployment complete ==="
echo ""
python3 -m json.tool "$REPO_ROOT/deployments.json" 2>/dev/null || cat "$REPO_ROOT/deployments.json"
echo ""
echo "Next: cd backend && npm run dev"
