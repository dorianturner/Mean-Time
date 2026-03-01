# Contracts

Foundry project for the MeanTime smart contracts. The main contract is `MeanTime.sol`.

---

## Getting Started

See [Quickstart.md](Quickstart.md) for setup, build, test, and deployment instructions.
See [Specification.md](Specification.md) for the full design spec.

---

## Files

```
src/
  MeanTime.sol          Core ERC-721 registry and marketplace
  MockERC20.sol         Mintable ERC-20 used in place of real USDC/EURC on testnet
test/
  MeanTime.t.sol        Foundry tests covering the full lifecycle
scripts/
  DeployMeanTime.s.sol  Deployment script for Arc testnet
lib/
  forge-std/            Foundry standard library (git submodule)
  openzeppelin-contracts/ OpenZeppelin ERC contracts (git submodule)
```

---

## Key Concepts

**Why is the NFT always held by the contract?**
ERC-721 transfer hooks are a footgun. If the NFT could move to arbitrary addresses, settlement would need to track down the current holder via `ownerOf()`, which introduces reentrancy risk and complexity. Instead, beneficial ownership is tracked in a plain mapping and settlement pays whoever is in that mapping. No hooks, no race conditions.

**Why is settlement permissionless?**
The backend calls `settle()` automatically, but anyone can call it. Keepers, relayers, or the receiver themselves can trigger settlement once USDC has arrived. This removes operational risk: even if the backend goes offline, settlements complete.

**What happens if the Circle attestation arrives while the NFT is listed?**
The listing is deleted as part of settlement and the beneficial owner (the seller) receives inboundToken. Any relayer whose `fill()` transaction was in flight will revert cleanly. No funds are lost.

---

## Running Tests

```bash
forge test -vvv
```

All tests run from the repo root. The test file covers:
- Mint: bridge can mint, non-bridge cannot, duplicate hash rejected
- List / Delist: only beneficial owner, guards against double-listing
- Fill: relayer becomes new beneficial owner, payment transferred
- Settle: pays beneficial owner, burns NFT, cleans up all state
- Edge cases: attestation racing with fill, listed NFT settled before filled

---

## Contract Addresses (Arc Testnet)

See `deployments.json` at the repo root.

| Contract | Role |
|---|---|
| `MeanTime` | Core registry and marketplace |
| `MockUSDC` | Fake USDC for testing (6 decimals) |
| `MockEURC` | Fake EURC for testing (6 decimals) |
