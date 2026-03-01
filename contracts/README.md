# Contracts

Foundry project for the MeanTime smart contracts. The main contract is `MeanTime.sol` — an ERC-721 registry and marketplace that turns pending CCTP transfers into tradeable on-chain assets.

---

## Table of Contents

- [Overview](#overview)
- [Getting Started](#getting-started)
- [Files](#files)
- [Contract Summary](#contract-summary)
- [Key Design Decisions](#key-design-decisions)
- [Circle CCTP Integration](#circle-cctp-integration)
- [Running Tests](#running-tests)
- [Contract Addresses](#contract-addresses)
- [Further Reading](#further-reading)

---

## Overview

MeanTime.sol is a 550-line Solidity contract that:
1. **Mints ERC-721 NFTs** for pending CCTP transfers (optimistic, before Circle attestation)
2. **Hosts a built-in marketplace** where receivers can sell their receivables immediately
3. **Settles automatically** when Circle's attestation arrives, paying the current beneficial owner
4. **Generates fully on-chain SVG metadata** with progress bars, face values, and listing status

---

## Getting Started

See [Quickstart.md](Quickstart.md) for setup, build, test, and deployment instructions.
See [Specification.md](Specification.md) for the full design spec with edge case analysis.

---

## Files

```
src/
  MeanTime.sol          Core ERC-721 registry and marketplace (550 lines)
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

## Contract Summary

### Core Functions

| Function | Access | Description |
|---|---|---|
| `mint(cctpMessageHash, inboundToken, inboundAmount, recipient)` | Bridge only | Create NFT for a detected CCTP burn. Called optimistically before attestation. |
| `list(tokenId, reservePrice, paymentToken)` | Beneficial owner | Post a sell order on the marketplace. Seller picks price and token freely. |
| `delist(tokenId)` | Beneficial owner | Remove a sell order. Beneficial ownership unchanged. |
| `fill(tokenId)` | Anyone | Buy a listed receivable. Relayer pays seller, becomes new beneficial owner. |
| `settle(cctpMessageHash)` | Anyone | Pay inboundToken to beneficial owner, burn NFT. Permissionless. |
| `claim(tokenId)` | Anyone | Same as settle but by token ID instead of message hash. |

### View Functions

| Function | Description |
|---|---|
| `getReceivable(tokenId)` | Full state in one call: owner, data, listing, age, estimated time left |
| `estimatedSettleTime(tokenId)` | Unix timestamp when attestation is expected to complete |
| `tokenURI(tokenId)` | On-chain SVG + JSON metadata (data URI) |

### Storage

```solidity
mapping(uint256 tokenId  => NFTData)  public nftData;            // hash, token, amount, mintedAt
mapping(uint256 tokenId  => Listing)  public listings;            // reservePrice, paymentToken, active
mapping(uint256 tokenId  => address)  public beneficialOwner;     // who gets paid at settlement
mapping(bytes32 msgHash  => uint256)  public tokenByMessageHash;  // reverse lookup
```

### Events

`Minted`, `Listed`, `Delisted`, `Filled`, `Settled`, `SettleAttempted` (diagnostic)

---

## Key Design Decisions

**1. Custodial NFTs — the NFT never leaves the contract.**
ERC-721 ownership always points to `address(this)`. Economic ownership is tracked separately in `beneficialOwner`. This eliminates ERC-721 transfer hook complexity from the settlement path and means the marketplace does not need to worry about NFTs being moved out from under it.

```
ownerOf(tokenId)         == address(this)   // always true
beneficialOwner[tokenId] == X               // who receives inboundToken at settlement
```

**2. Permissionless settlement.**
Anyone can call `settle()`. The contract reads `beneficialOwner` and pays that address. The backend calls it automatically, but keepers, relayers, or the receiver can also trigger it. This removes operational dependency on the backend being alive.

**3. Checks-effects-interactions throughout.**
All storage is cleared and the NFT burned before any token transfer leaves the contract. No reentrancy guards are needed because the external call is the last thing that happens.

**4. Fully on-chain metadata.**
`tokenURI()` generates an SVG image and JSON metadata entirely on-chain — no IPFS, no external server. The SVG shows face value, token address, age, estimated time remaining, listing status, and an attestation progress bar.

**5. No oracle dependency.**
The contract contains zero pricing logic. All risk modelling lives in relayer bots. The marketplace is a simple reserve-price order book with no price feeds.

---

## Circle CCTP Integration

The MeanTime contract is designed specifically for Circle's CCTP flow:

1. **Message hash as canonical ID:** Each NFT is uniquely identified by `keccak256(cctpMessageBytes)` — the same hash used by Circle's attestation API. The `tokenByMessageHash` mapping enables settlement by message hash.

2. **Optimistic minting:** The bridge service calls `mint()` as soon as a CCTP burn is detected on Sepolia — before Circle's ~17-minute attestation completes. The NFT is "backed" by the incoming transfer, not by tokens already in the contract.

3. **Attestation timing:** `ESTIMATED_ATTESTATION_TIME = 1020 seconds` (17 minutes). This is used for age display and progress bars. The actual attestation window depends on Sepolia block times and Circle's processing load.

4. **Settlement after USDC arrival:** `settle()` requires the contract to hold at least `inboundAmount` of `inboundToken`. The backend ensures this by calling `receiveMessage()` (or mock-minting on testnet) before calling `settle()`.

---

## Running Tests

```bash
forge test -vvv
```

All tests run from the repo root. The test file covers:
- **Mint:** Bridge can mint, non-bridge cannot, duplicate hash rejected
- **List / Delist:** Only beneficial owner, guards against double-listing
- **Fill:** Relayer becomes new beneficial owner, payment transferred
- **Settle:** Pays beneficial owner, burns NFT, cleans up all state
- **Edge cases:** Attestation racing with fill, listed NFT settled before filled

---

## Contract Addresses (Arc Testnet)

See `deployments.json` at the repo root. This file is auto-generated by `deploy.sh`.

| Contract | Role |
|---|---|
| `MeanTime` | Core registry and marketplace (ERC-721: "MeanTime Receivable", symbol "MTR") |
| `MockUSDC` | Fake USDC for testing (6 decimals, mintable by owner) |
| `MockEURC` | Fake EURC for testing (6 decimals, mintable by owner) |

---

## Further Reading

- [Specification.md](Specification.md) — Complete design spec: storage layout, function signatures, events, edge case analysis, relayer integration guide
- [Quickstart.md](Quickstart.md) — Build, test, format, deploy instructions
- [../architecture.md](../architecture.md) — Full system architecture and Circle tool integration details
