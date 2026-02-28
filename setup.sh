#!/bin/bash

# MeanTime Dev Setup Script
echo "Starting MeanTime setup..."

# 1. Install Foundry if not present
if ! command -v forge &> /dev/null
then
    echo "Foundry not found. Installing..."
    curl -L https://foundry.paradigm.xyz | bash
    # Export path for current session
    export PATH="$HOME/.foundry/bin:$PATH"
    foundryup
else
    echo "Foundry already installed."
fi

# 2. Initialize Git if not a repo
if [ ! -d ".git" ]; then
    echo "Initializing Git repo..."
    git init
fi

# 3. Install Forge Standard Library
echo "Installing forge-std..."
# Using git clone as a fallback if forge install fails
if [ ! -d "lib/forge-std" ]; then
    mkdir -p lib
    git clone https://github.com/foundry-rs/forge-std lib/forge-std
else
    echo "forge-std already present in lib/"
fi

# 4. Generate Remappings
echo "Generating remappings.txt..."
cat <<EOF > remappings.txt
ds-test/=lib/forge-std/lib/ds-test/src/
forge-std/=lib/forge-std/src/
openzeppelin-contracts/=lib/openzeppelin-contracts/contracts/
EOF

# 5. Create .env template if it doesn't exist
if [ ! -f ".env" ]; then
    echo "Creating .env template..."
    cat <<EOF > .env
ARC_RPC_URL=https://rpc.testnet.arc.network
PRIVATE_KEY=your_private_key_here
ETHERSCAN_API_KEY=
EOF
    echo "Action Required: Update your PRIVATE_KEY in the .env file!"
fi

# 6. Build the project
echo "Building project..."
forge build

echo "Setup complete! You are ready to develop on Arc Testnet."
echo "To use the environment variables, run: source .env"
