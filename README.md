# MeanTime

**Tokenised CCTP receivables.** Every cross-chain USDC transfer becomes a tradeable on-chain asset during the attestation window for a CCTP transfer to ARC.

MeanTime is built on [Circle's](https://www.circle.com) CCTP (Cross-Chain Transfer Protocol), USDC, EURC, and Bridge Kit — running on **Arc Testnet** with **Ethereum Sepolia** as the source chain.

> **Submission context:** Functional MVP with a working frontend, backend, smart contracts, architecture diagrams, and full documentation covering core functions and use of Circle's tools.

---

## Table of Contents

- [Quickstart](#quickstart)
- [What It Does](#what-it-does)
- [Core User Flow](#core-user-flow)
- [Circle Tools & Integration](#circle-tools--integration)
- [Architecture Overview](#architecture-overview)
- [The Economics](#the-economics)
- [Why Arc](#why-arc)
- [What Is Novel](#what-is-novel)
- [Project Structure](#project-structure)
- [Deployed Contracts](#deployed-contracts)
- [Scripts Reference](#scripts-reference)
- [Testing](#testing)
- [Deployment](#deployment)
- [Known Limitations](#known-limitations)
- [Further Reading](#further-reading)
- [License](#license)

---

## Quickstart

**Requirements:** Git, Bash (macOS/Linux/WSL), Node.js 18+, a funded Arc testnet wallet.

```bash
# 1. Clone and set up contracts
git clone <repo>
cd MeanTime
bash setup.sh          # installs Foundry, pulls submodules, compiles

# 2. Configure environment
cp .env.example .env   # fill in ARC_RPC_URL and PRIVATE_KEY

# 3. Start the app (backend on :3001, frontend on :5173)
bash app.sh
```

Open `http://localhost:5173`. Connect MetaMask, switch to Sepolia, and send USDC to Arc. The NFT appears in the marketplace within seconds.

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ARC_RPC_URL` | Yes | Arc testnet RPC endpoint (e.g. `https://rpc.testnet.arc.network`) |
| `PRIVATE_KEY` | Yes | Deployer / bridge operator private key (hex, with `0x` prefix) |
| `SEPOLIA_RPC_URL` | No | Sepolia RPC (defaults to `https://rpc.sepolia.org`) |
| `ARC_MESSAGE_TRANSMITTER` | No | Arc CCTP MessageTransmitter address (enables native `receiveMessage`) |
| `VITE_API_BASE` | No | Frontend override for backend URL (defaults to `http://localhost:3001`) |

---

## What It Does

When USDC is bridged from Ethereum to Arc via CCTP Standard Transfer, Circle requires **65 block confirmations** before releasing funds on the destination chain. That takes **15–19 minutes** (for CCTPv1). During that window the receiver has no money and no position.

MeanTime mints an **ERC-721 NFT** the moment the source-chain burn is detected. That NFT represents the incoming USDC, and it can be traded immediately on a built-in marketplace.

```
Ethereum Sepolia                          Arc Testnet
───────────────                           ──────────

User burns USDC via CCTP
  depositForBurn() on TokenMessenger
         │
         │  (backend detects burn within ~30s)
         ▼
                                    MeanTime.mint() → ERC-721 minted
                                         │
                        ┌────────────────┤
                        │                │
                  [Hold Path]      [Trade Path]
                        │                │
                   Wait ~17 min     list() on marketplace
                        │                │
                   settle() →       Relayer calls fill()
                   Full USDC          │
                   to receiver     Seller gets EURC instantly
                                      │
                                   ~17 min later: settle()
                                   Relayer gets full USDC
```

The relayer earns the spread. The receiver gets immediate liquidity. Settlement is automatic and permissionless.

---

## Core User Flow

### 1. Send USDC (Sepolia → Arc)
The user connects MetaMask on Sepolia, enters a recipient address and USDC amount. The frontend calls `depositForBurn()` on Circle's `TokenMessenger` contract, targeting Arc (CCTP domain 26) with the MeanTime contract as the mint recipient.

### 2. NFT Minted (Optimistic)
The backend's Sepolia watcher detects the `MessageSent` event within ~30 seconds. It immediately calls `MeanTime.mint()` on Arc — **before** Circle's attestation completes. The NFT appears in the frontend marketplace via SSE push.

### 3. Trade on Marketplace (Optional)
The beneficial owner can list the NFT at any price in any ERC-20 token (e.g. EURC). A relayer who wants exposure to the incoming USDC calls `fill()`, paying the seller instantly. The relayer becomes the new beneficial owner.

### 4. Settlement (Automatic)
The backend polls Circle's attestation API (`iris-api-sandbox.circle.com`). When `status: complete` is returned, it calls `receiveMessage()` on Arc to release USDC to the MeanTime contract, then calls `settle()` to pay the current beneficial owner and burn the NFT.

---

## Circle Tools & Integration

MeanTime is built on three Circle primitives:

### 1. CCTP v2 (Cross-Chain Transfer Protocol)

CCTP is the **core protocol** MeanTime is built on. It provides trustless burn-and-mint for USDC across chains with Circle-signed attestations.

| What | How MeanTime Uses It |
|---|---|
| **Source burn** | Frontend calls `depositForBurn()` on Sepolia `TokenMessenger` (v2) to burn USDC |
| **Message detection** | Backend polls Sepolia `MessageTransmitter` for `MessageSent` events, parses CCTP v2 message format (148-byte header + BurnMessage body) |
| **Optimistic minting** | Backend calls `MeanTime.mint()` on Arc **before** attestation — the key innovation |
| **Attestation polling** | Backend polls `iris-api-sandbox.circle.com/attestations/{messageHash}` every 30s |
| **Destination receive** | Backend calls `MessageTransmitter.receiveMessage(message, attestation)` on Arc to release USDC |
| **Settlement** | Backend calls `MeanTime.settle()` → pays beneficial owner, burns NFT |

**CCTP v2 Contract Addresses (Sepolia):**

| Contract | Address |
|---|---|
| TokenMessenger (v2) | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` |
| MessageTransmitter (v2) | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` |
| USDC | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |

**Arc CCTP Domain:** `26`

### 2. USDC & EURC on Arc

MeanTime leverages Circle's natively-issued stablecoins on Arc:

- **USDC** (`0x3600000000000000000000000000000000000000`) — The inbound token from CCTP transfers. 6 decimals via ERC-20 interface.
- **EURC** — Used as the default payment token on the marketplace. Relayers pay EURC to buy USDC receivables, earning the FX spread.

The protocol requires **both** stablecoins to be liquid on the destination chain. Arc is one of the few chains where Circle natively issues both USDC and EURC.

### 3. Circle Bridge Kit (`@circle-fin/bridge-kit`)

The backend integrates Circle's official **Bridge Kit SDK** via `bridgeService.ts` as an alternative CCTP integration. Bridge Kit provides a higher-level abstraction over raw CCTP that handles:

- Multi-chain routing (Sepolia, Arbitrum Sepolia, Base Sepolia → Arc)
- Approval flow management
- Fee estimation
- Source and destination adapter setup via `@circle-fin/adapter-viem-v2`

**No Circle API key or entity secret required** — Bridge Kit uses standard private keys via the viem adapter, not developer-controlled wallets.

Exposed as:
- **REST endpoint:** `POST /api/bridge/bridge-kit`
- **CLI:** `npx tsx src/bridgeService.ts --source ethereum-sepolia --amount 10 --recipient 0x...`

### 4. Circle Attestation Service

Circle's attestation API (`iris-api-sandbox.circle.com`) signs CCTP messages after the required number of source-chain confirmations (65 blocks on Sepolia). The backend's `attestationPoller.ts` polls this API for each pending transfer:

```
GET https://iris-api-sandbox.circle.com/attestations/{messageHash}

Response: { "status": "complete", "attestation": "0x..." }
```

The attestation signature is the cryptographic proof required to call `receiveMessage()` on the destination chain and release USDC.

---

## Architecture Overview

MeanTime is a three-tier system: **Solidity smart contract** on Arc, **Node.js backend**, and **React frontend**.

```
┌─────────────────────────────────────────────────────┐
│                   Frontend (React)                   │
│  ConnectButton · SendPanel · Marketplace             │
│  useWallet · useReceivables (SSE) · useContractActions│
└──────────────────┬──────────────────────────────────┘
                   │ HTTP + Server-Sent Events
┌──────────────────▼──────────────────────────────────┐
│                  Backend (Node.js)                    │
│  sepoliaWatcher → attestationPoller → txQueue         │
│  watcher.ts (Arc events) · store.ts (in-memory)     │
│  bridgeService.ts (Circle Bridge Kit)                │
└──────────────────┬──────────────────────────────────┘
                   │ JSON-RPC (viem)
┌──────────────────▼──────────────────────────────────┐
│             MeanTime.sol (Arc Testnet)               │
│  mint() · list() · delist() · fill() · settle()     │
│  ERC-721 with on-chain SVG metadata                  │
└─────────────────────────────────────────────────────┘
```

For the complete architecture with data flow diagrams, component maps, and state machines, see [architecture.md](architecture.md).

---

## The Economics

The spread a seller pays reflects two things:

**FX risk.** Holding a USDC receivable means holding an open position for up to 17 minutes. If USDC/EURC moves, the relayer absorbs the loss. This component has a natural floor set by volatility and cannot be competed to zero.

**Liquidity premium.** Advancing EURC against an asset that won't arrive for 17 minutes has a cost. With competition among relayers this component compresses toward the true risk floor.

In calm markets the spread is very tight. In volatile conditions relayers stop filling, which is the correct response. No circuit breakers or oracles are needed.

---

## Why Arc

- **Native USDC & EURC** — Circle issues both stablecoins natively on Arc. The spread market requires a credible, liquid pairing of both.
- **Sub-second finality** — Fills settle in under a second. On a 12-second block chain the UX would be unusable.
- **CCTP is foundational** — Arc has CCTP v2 support as a first-class feature, not an afterthought.
- **StableFX** — Institutional-grade USDC/EURC swap infrastructure for relayer hedging.

---

## What Is Novel

A tokenised CCTP receivable does not exist elsewhere. The marketplace is one application built on top of it. Any future protocol that wants to lend against, hedge, or route pending CCTP flows can use the same NFT infrastructure.

Key innovations:
1. **Optimistic NFT minting** — The NFT is minted *before* Circle's attestation, creating a tradeable asset from the attestation delay itself.
2. **Custodial NFT design** — The ERC-721 never leaves the contract. Beneficial ownership is tracked separately, making settlement atomic and eliminating transfer hook complexity.
3. **Permissionless settlement** — Anyone can call `settle()`. The backend automates it, but keepers, relayers, or receivers can trigger it independently.
4. **Fully on-chain metadata** — The NFT SVG (with progress bar, face value, listing status) is generated entirely on-chain.

---

## Project Structure

```
MeanTime/
├── README.md                 ← You are here
├── architecture.md           ← Detailed architecture & data flow diagrams
├── deployments.json          ← Deployed contract addresses (auto-generated)
├── foundry.toml              ← Foundry configuration
├── app.sh                    ← Start backend + frontend dev servers
├── setup.sh                  ← One-time setup (Foundry, submodules, compile)
├── deploy.sh                 ← Build, test, deploy contracts to Arc
├── railway.json              ← Railway deployment config (backend)
│
├── contracts/                ← Solidity smart contracts
│   ├── src/
│   │   ├── MeanTime.sol      ← Core ERC-721 registry & marketplace (550 lines)
│   │   └── MockERC20.sol     ← Mintable ERC-20 for testnet
│   ├── test/
│   │   └── MeanTime.t.sol    ← Foundry tests (full lifecycle coverage)
│   ├── scripts/
│   │   └── DeployMeanTime.s.sol
│   ├── Specification.md      ← Full contract design spec & edge cases
│   ├── Quickstart.md         ← Build, test, deploy instructions
│   └── README.md
│
├── backend/                  ← Node.js bridge service
│   ├── src/
│   │   ├── index.ts           ← Entry point: backfill, watchers, HTTP server
│   │   ├── sepoliaWatcher.ts  ← Polls Sepolia for CCTP burns → mint on Arc
│   │   ├── attestationPoller.ts ← Polls Circle API → settle on Arc
│   │   ├── watcher.ts         ← Polls Arc for contract events
│   │   ├── bridgeService.ts   ← Circle Bridge Kit integration
│   │   ├── store.ts           ← In-memory state + SSE event bus
│   │   ├── txQueue.ts         ← Serial nonce-safe transaction queue
│   │   ├── ctx.ts             ← Blockchain clients & config
│   │   ├── app.ts             ← Express routes
│   │   ├── abi.ts             ← Contract ABI definitions
│   │   └── routes/            ← HTTP endpoint handlers
│   └── README.md
│
└── frontend/                 ← React marketplace UI
    ├── src/
    │   ├── App.tsx            ← Root: tabs, header, wallet state
    │   ├── components/
    │   │   ├── SendPanel.tsx   ← Send USDC via CCTP (Sepolia → Arc)
    │   │   ├── Marketplace.tsx ← List, delist, fill receivable NFTs
    │   │   ├── ConnectButton.tsx
    │   │   └── BridgePanel.tsx ← Dev debug panel
    │   ├── hooks/
    │   │   ├── useWallet.ts    ← MetaMask integration
    │   │   ├── useReceivables.ts ← SSE real-time state
    │   │   ├── useTokenSymbols.ts
    │   │   └── useContractActions.ts ← list/delist/fill encoding
    │   ├── config.ts
    │   ├── abi.ts
    │   └── types.ts
    └── README.md
```

---

## Deployed Contracts

**Network:** Arc Testnet (Chain ID: `5042002`)

| Contract | Address | Role |
|---|---|---|
| MeanTime | See `deployments.json` | Core ERC-721 registry & marketplace |
| MockUSDC | See `deployments.json` | Testnet USDC (6 decimals) |
| MockEURC | See `deployments.json` | Testnet EURC (6 decimals) |
| Bridge | See `deployments.json` | Deployer / bridge operator |

The backend reads `deployments.json` at startup. This file is auto-generated by `deploy.sh`.

---

## Scripts Reference

| Script | Command | Description |
|---|---|---|
| `setup.sh` | `bash setup.sh` | Install Foundry, init submodules, compile contracts |
| `app.sh` | `bash app.sh` | Start backend (:3001) and frontend (:5173) dev servers |
| `deploy.sh` | `bash deploy.sh` | Build, test, deploy contracts to Arc testnet |
| Mint tokens | `cd backend && npx tsx src/mintTokens.ts 0xAddr` | Mint mock USDC/EURC to any Arc address |
| Retrigger | `cd backend && npx tsx src/retrigger.ts` | Scan Sepolia for burns missed while offline |
| Cleanup | `cd backend && npx tsx src/cleanup.ts` | Settle old test NFTs |

---

## Testing

### Smart Contract Tests (Foundry)

```bash
forge test -vvv
```

Covers: mint, list, delist, fill, settle, claim, edge cases (attestation racing with fill, listed NFT settled before filled).

### Backend Tests (Vitest)

```bash
cd backend && npm test
```

Covers: store operations, CCTP message parsing, HTTP API endpoints, watcher integration.

### Frontend

```bash
cd frontend && npm run lint
```

---

## Deployment

### Contracts

```bash
# Ensure .env has ARC_RPC_URL and PRIVATE_KEY
bash deploy.sh
```

This builds, runs tests, deploys to Arc testnet, and writes `deployments.json`.

### Backend (Railway)

The backend is configured for Railway deployment via `railway.json`. Set `ARC_RPC_URL`, `PRIVATE_KEY`, and optionally `SEPOLIA_RPC_URL` as environment variables.

### Frontend

```bash
cd frontend
VITE_API_BASE=https://your-backend.example.com npm run build
# Serve dist/ with any static host
```

---

## Known Limitations

| Limitation | Impact | Mitigation |
|---|---|---|
| Arc MessageTransmitter address unknown | Cannot call native `receiveMessage()` on Arc | Backend mocks USDC arrival via `MockERC20.mint()` then settles. Set `ARC_MESSAGE_TRANSMITTER` when available. |
| 30-second Sepolia poll lag | Burns detected up to 30s after confirmation | Public Sepolia RPCs don't support event subscriptions |
| No persistent storage | Backend replays ~50k blocks on restart | State is rebuilt from chain events; very old events not replayed |
| Testnet attestation timing | May take longer than 17-minute estimate | Auto-settle fallback after 17 minutes if Circle never attests |

---

## Further Reading

| Document | Description |
|---|---|
| [architecture.md](architecture.md) | Full architecture, data flow diagrams, state machines, Circle tool details |
| [contracts/README.md](contracts/README.md) | Smart contract overview and key design decisions |
| [contracts/Specification.md](contracts/Specification.md) | Complete contract spec: storage, functions, events, edge cases |
| [contracts/Quickstart.md](contracts/Quickstart.md) | Build, test, deploy instructions for contracts |
| [backend/README.md](backend/README.md) | Backend services, HTTP API, SSE events, utility scripts |
| [frontend/README.md](frontend/README.md) | Frontend components, hooks, design choices |

---

## License

MIT

