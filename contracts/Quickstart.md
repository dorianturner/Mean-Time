# Quickstart

## Prerequisites

- Git
- Bash (macOS/Linux/WSL)
- An Arc testnet wallet with a funded private key (for deployment only)

Foundry does **not** need to be installed manually — `setup.sh` handles it.

---

## First-time setup

Run this once from the repo root:

```bash
bash setup.sh
```

This will:
1. Install Foundry (`forge`, `cast`, `anvil`) to `~/.foundry/bin/`
2. Pull all git submodules (`forge-std`, `openzeppelin-contracts`)
3. Create a `.env` template at the repo root if one doesn't exist
4. Build the contracts

---

## Building

```bash
cd contracts
forge build
```

To also print compiled contract sizes (same as CI):

```bash
forge build --sizes
```

---

## Running tests

Run the full test suite:

```bash
cd contracts
forge test -vvv
```

Run a specific test file by contract name:

```bash
forge test --match-contract HelloArcTest -vvv
```

Run a single test function:

```bash
forge test --match-test test_UpdateMessage -vvv
```

The `-vvv` flag prints a full execution trace for failing tests. Use `-vv` for less output or omit entirely for a summary only.

---

## Writing tests

Test files live in `contracts/test/` and must end in `.t.sol`. Each test contract extends `forge-std/Test.sol`. Any function prefixed `test` is run as a test case; `setUp()` runs before each one.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {MyContract} from "../src/MyContract.sol";

contract MyContractTest is Test {
    MyContract public c;

    function setUp() public {
        c = new MyContract();
    }

    function test_Somebehaviour() public {
        assertEq(c.value(), 42);
    }
}
```

---

## Formatting

Check formatting (this is enforced in CI and will fail the build if not clean):

```bash
forge fmt --check
```

Auto-fix formatting:

```bash
forge fmt
```

---

## Deploying to Arc testnet

Fill in your private key in `.env` at the repo root:

```
ARC_RPC_URL=https://rpc.testnet.arc.network
PRIVATE_KEY=0xyour_key_here
```

Then from the repo root:

```bash
source .env
forge script contracts/scripts/DeployHello.s.sol:DeployHello \
  --rpc-url $ARC_RPC_URL \
  --broadcast
```

---

## Project layout

```
contracts/
├── src/          # Contract source files
├── test/         # Forge test files (*.t.sol)
├── scripts/      # Deployment scripts (*.s.sol)
├── lib/          # Dependencies (forge-std, openzeppelin-contracts)
└── foundry.toml  # Foundry config and remappings
```

The design spec for the full contract system is in `contracts/README.md`.
