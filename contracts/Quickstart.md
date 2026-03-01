# Contracts Quickstart

## Prerequisites

- Git and Bash (macOS/Linux/WSL)
- A funded Arc testnet wallet (for deployment)

Foundry does not need to be installed first -- `setup.sh` handles it.

---

## Setup

Run once from the **repo root**:

```bash
bash setup.sh
```

This installs Foundry, initialises git submodules (`forge-std`, `openzeppelin-contracts`), and compiles the contracts. If `forge` is not on your PATH after setup, open a new terminal or run `source ~/.bashrc`.

---

## Build

```bash
forge build              # compile
forge build --sizes      # compile and print contract sizes (matches CI)
```

All Forge commands run from the repo root. The root `foundry.toml` points Forge at the `contracts/` directory.

---

## Test

```bash
forge test -vvv                                    # all tests, with traces on failure
forge test --match-contract MeanTimeTest -vvv      # one test file
forge test --match-test test_FillAndSettle -vvv    # one test function
```

`-vvv` prints full execution traces on failure. Drop it for a summary.

---

## Format

```bash
forge fmt             # auto-format
forge fmt --check     # check only (fails in CI if any files need changes)
```

---

## Write a Test

Test files live in `contracts/test/` and must end in `.t.sol`. Extend `forge-std/Test.sol`.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {Test} from "forge-std/Test.sol";
import {MeanTime} from "../src/MeanTime.sol";
import {MockERC20} from "../src/MockERC20.sol";

contract ExampleTest is Test {
    MeanTime public meantime;
    MockERC20 public usdc;
    address public bridge = address(0xBEEF);

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        meantime = new MeanTime(bridge);
    }

    function test_MintCreatesReceivable() public {
        bytes32 msgHash = keccak256("test");
        vm.prank(bridge);
        uint256 tokenId = meantime.mint(msgHash, address(usdc), 100e6, address(this));

        assertEq(meantime.beneficialOwner(tokenId), address(this));
    }
}
```

Any function prefixed with `test` is a test case. `setUp()` runs before each one.

---

## Deploy to Arc Testnet

Add credentials to `.env` at the repo root:

```
ARC_RPC_URL=https://rpc.blockdaemon.testnet.arc.network
PRIVATE_KEY=0xyour_key_here
```

Deploy:

```bash
source .env
forge script contracts/scripts/DeployMeanTime.s.sol:DeployMeanTime \
  --rpc-url $ARC_RPC_URL \
  --broadcast
```

After deployment, update `deployments.json` at the repo root with the new contract addresses. The backend reads this file on startup.

---

## Project Layout

```
foundry.toml              # Root Foundry config (run forge from here)
contracts/
  src/
    MeanTime.sol          # Main contract
    MockERC20.sol         # Mintable ERC-20 for testnet
  test/
    MeanTime.t.sol        # Foundry tests
  scripts/
    DeployMeanTime.s.sol  # Deployment script
  lib/
    forge-std/            # Forge standard library (git submodule)
    openzeppelin-contracts/ # OpenZeppelin (git submodule)
  Specification.md        # Full contract design spec
  Quickstart.md           # This file
```

See [Specification.md](Specification.md) for the complete design spec and edge case analysis.
