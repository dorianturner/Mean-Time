#!/bin/bash
set -e

echo "Starting InstantSettle setup..."

# Resolve the repo root (wherever setup.sh lives)
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
CONTRACTS_DIR="$REPO_ROOT/contracts"
FORGE="$HOME/.foundry/bin/forge"

# 1. Install Foundry if not present
if [ ! -f "$FORGE" ]; then
    echo "Foundry not found. Installing..."
    curl -L https://foundry.paradigm.xyz | bash
    export PATH="$HOME/.foundry/bin:$PATH"
    foundryup
else
    echo "Foundry already installed."
fi

# Ensure forge is on PATH for the rest of this script
export PATH="$HOME/.foundry/bin:$PATH"

# 2. Install git submodules (forge-std + openzeppelin-contracts)
echo "Installing dependencies..."
cd "$CONTRACTS_DIR"
git submodule update --init --recursive

# 3. Install OpenZeppelin if lib/ entry is missing (handles fresh clones
#    where submodule exists in .gitmodules but wasn't pulled above)
if [ ! -f "$CONTRACTS_DIR/lib/openzeppelin-contracts/contracts/token/ERC721/ERC721.sol" ]; then
    echo "Installing OpenZeppelin contracts..."
    "$FORGE" install OpenZeppelin/openzeppelin-contracts
fi

# 4. Create .env from template if it doesn't exist
if [ ! -f "$REPO_ROOT/.env" ]; then
    echo "Creating .env template..."
    cat <<EOF > "$REPO_ROOT/.env"
ARC_RPC_URL=https://rpc.testnet.arc.network
PRIVATE_KEY=your_private_key_here
ETHERSCAN_API_KEY=
EOF
    echo ""
    echo "  Action required: add your PRIVATE_KEY to .env before deploying."
    echo ""
fi

# 5. Build
echo "Building contracts..."
"$FORGE" build

echo ""
echo "Setup complete. Run tests with:"
echo "  cd contracts && forge test -vvv"
