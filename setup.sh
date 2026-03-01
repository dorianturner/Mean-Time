#!/bin/bash
set -e

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "Setting up InstantSettle..."

# ── 1. Foundry ────────────────────────────────────────────────────────────────
if [ ! -f "$HOME/.foundry/bin/forge" ]; then
    echo "Installing Foundry..."
    curl -L https://foundry.paradigm.xyz | bash
    "$HOME/.foundry/bin/foundryup"
else
    echo "Foundry already installed."
fi

export PATH="$HOME/.foundry/bin:$PATH"

# ── 2. Dependencies ───────────────────────────────────────────────────────────
echo "Installing dependencies..."
git -C "$REPO_ROOT" submodule update --init --recursive

# Fallback: if submodule pull left dirs empty, use forge install
if [ ! -f "$REPO_ROOT/contracts/lib/forge-std/src/Test.sol" ]; then
    echo "Pulling forge-std via forge install..."
    (cd "$REPO_ROOT/contracts" && forge install foundry-rs/forge-std)
fi

if [ ! -f "$REPO_ROOT/contracts/lib/openzeppelin-contracts/contracts/token/ERC721/ERC721.sol" ]; then
    echo "Pulling openzeppelin-contracts via forge install..."
    (cd "$REPO_ROOT/contracts" && forge install OpenZeppelin/openzeppelin-contracts)
fi

# ── 3. .env ───────────────────────────────────────────────────────────────────
if [ ! -f "$REPO_ROOT/.env" ]; then
    echo "Creating .env template..."
    cat <<EOF > "$REPO_ROOT/.env"
ARC_RPC_URL=https://rpc.testnet.arc.network
PRIVATE_KEY=your_private_key_here
ETHERSCAN_API_KEY=
EOF
    echo ""
    echo "  !! Update PRIVATE_KEY in .env before deploying !!"
fi

# ── 4. Build ──────────────────────────────────────────────────────────────────
echo "Building..."
(cd "$REPO_ROOT" && forge build)

echo ""
echo "Done. To deploy:"
echo ""
echo "  source .env"
echo "  forge script contracts/scripts/DeployHello.s.sol:DeployHello --rpc-url \$ARC_RPC_URL --broadcast"
echo ""
echo "If 'forge' is not found, open a new terminal (or run: source ~/.bashrc)"
