# Quickstart

## Prerequisites

- Git
- Bash (macOS / Linux / WSL)
- A funded Arc testnet wallet (for deployment only)

Foundry does **not** need to be pre-installed — `setup.sh` handles it.

---

## First-time setup

Run once from the **repo root**:

```bash
bash setup.sh
```

This installs Foundry, pulls all dependencies (`forge-std`, `openzeppelin-contracts`), and builds the contracts. If `forge` is not found after setup, open a new terminal or run `source ~/.bashrc`.

---

## Building

From the repo root:

```bash
forge build
```

To also print compiled contract sizes (same as CI):

```bash
forge build --sizes
```

---

## Running tests

From the repo root:

```bash
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

`-vvv` prints a full execution trace on failure. Omit for a summary only.

---

## Writing tests

Test files live in `contracts/test/` and must end in `.t.sol`. Extend `forge-std/Test.sol`. Any function prefixed `test` is a test case; `setUp()` runs before each one.

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

    function test_SomeBehaviour() public {
        assertEq(c.value(), 42);
    }
}
```

---

## Formatting

Check formatting (enforced in CI):

```bash
forge fmt --check
```

Auto-fix:

```bash
forge fmt
```

---

## Deploying to Arc testnet

Add your private key to `.env` at the repo root:

```
ARC_RPC_URL=https://rpc.testnet.arc.network
PRIVATE_KEY=0xyour_key_here
```

Then:

```bash
source .env
forge script contracts/scripts/DeployHello.s.sol:DeployHello --rpc-url $ARC_RPC_URL --broadcast
```

---

## Project layout

```
foundry.toml              # Root Foundry config (run forge from here)
contracts/
├── src/                  # Contract source files
├── test/                 # Forge test files (*.t.sol)
├── scripts/              # Deployment scripts (*.s.sol)
├── lib/                  # Dependencies (managed via git submodules)
└── foundry.toml          # Inner config (used when running forge from contracts/)
```

The full contract design spec is in `contracts/README.md`.
