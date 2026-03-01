# Backend

Node.js service that bridges the gap between on-chain events and the frontend. It watches for CCTP burns on Sepolia, mints NFTs on Arc, polls Circle's attestation API, and serves a real-time SSE stream.

---

## Table of Contents

- [Tech Stack](#tech-stack)
- [Getting Started](#getting-started)
- [Architecture](#architecture)
- [Services](#services)
- [Circle Integration](#circle-integration)
- [HTTP API](#http-api)
- [In-Memory Store](#in-memory-store)
- [Transaction Queue](#transaction-queue)
- [Utility Scripts](#utility-scripts)
- [Testing](#testing)
- [Known Limitations](#known-limitations)

---

## Tech Stack

- **Runtime:** Node.js with `tsx` for TypeScript execution
- **HTTP:** Express
- **Blockchain:** viem (public and wallet clients for both Sepolia and Arc)
- **Circle SDKs:** `@circle-fin/bridge-kit` v1.6+, `@circle-fin/adapter-viem-v2` v1.5+
- **Tests:** Vitest + Supertest

---

## Getting Started

```bash
cd backend
npm install
```

Set up `.env` at the repo root:

```
ARC_RPC_URL=https://rpc.blockdaemon.testnet.arc.network
PRIVATE_KEY=0xyour_key_here
SEPOLIA_RPC_URL=https://ethereum-sepolia.publicnode.com   # optional, has a default
```

Run in development (auto-restarts on file change):

```bash
npm run dev
```

Run in production:

```bash
npm start
```

Run tests:

```bash
npm test
```

The server starts on port 3001. The frontend expects it there.

---

## Architecture

```
index.ts
  backfillStore()          -- replay historical Arc events on startup
  startWatcher()           -- poll Arc for new events every 2s
  startSepoliaWatcher()    -- poll Sepolia for CCTP burns every 30s
  recoverSettlements()     -- catch up with Circle API for in-flight transfers
  express server           -- HTTP + SSE

store.ts                   -- in-memory receivable state, event bus for SSE
txQueue.ts                 -- serial transaction queue (prevents nonce collisions)
ctx.ts                     -- blockchain clients, addresses, chain config
abi.ts                     -- contract ABI definitions
bridgeService.ts           -- Circle Bridge Kit integration (multi-chain CCTP)
```

**Startup sequence:**
1. `buildCtx()` — Create viem clients for Arc and Sepolia, load contract addresses from `deployments.json`
2. `backfillStore()` — Replay last ~50k blocks of Arc events to rebuild in-memory state
3. `startWatcher()` — Begin polling Arc every 2s for new contract events
4. `startSepoliaWatcher()` — Begin polling Sepolia every 30s for CCTP burns
5. `recoverSettlements()` — Check Circle API for attestations that completed while offline
6. Express server starts on `:3001`

---

## Services

### `sepoliaWatcher.ts` — Sepolia burn watcher

Polls Sepolia every 30 seconds for `MessageSent` events from Circle's `MessageTransmitter` (v2) contract. Filters for messages destined for Arc domain (26) with MeanTime as the mint recipient.

**CCTP v2 message parsing:** The watcher decodes the 148-byte v2 header and BurnMessage body to extract `destDomain`, `mintRecipient`, `amount`, and `messageSender`.

When it finds a new burn, it immediately calls `MeanTime.mint()` on Arc (optimistic, before attestation). The `intendedRecipients` map (txHash → recipient) is used to associate a burn with the correct Arc-side beneficiary, populated when the frontend calls `POST /api/bridge/initiate-cctp`.

### `attestationPoller.ts` — Circle attestation poller

Polls `iris-api-sandbox.circle.com/attestations/{messageHash}` every 30 seconds for each active CCTP message hash. When Circle returns `status: complete`, it:

1. Calls `MessageTransmitter.receiveMessage(message, attestation)` on Arc to release USDC
2. Calls `MeanTime.settle()` to pay the beneficial owner and burn the NFT

**Auto-settle fallback:** If Circle never attests within 17 minutes (e.g., Arc testnet not fully supported), the poller auto-settles by mock-minting USDC via `MockERC20.mint()` and calling `settle()` directly. This ensures the full flow works on testnet regardless of CCTP availability.

**Recovery on restart:** `recoverSettlements()` runs at startup — checks every active receivable against Circle API and settles any that completed while the backend was down.

### `watcher.ts` — Arc event watcher

Polls Arc every 2 seconds for new `Minted`, `Listed`, `Delisted`, `Filled`, and `Settled` events emitted by the MeanTime contract. Updates the in-memory store and pushes SSE events to connected frontends.

On startup, `backfillStore()` replays the last ~50k blocks in chunks to rebuild state. Arc public RPCs do not support `eth_newFilter`, so all event fetching uses `getLogs` polling.

### `bridgeService.ts` — Circle Bridge Kit

Alternative CCTP integration using Circle's official Bridge Kit SDK (`@circle-fin/bridge-kit`). Supports multi-chain flows (Sepolia, Arbitrum Sepolia, Base Sepolia → Arc):

- Uses `@circle-fin/adapter-viem-v2` for wallet integration
- No Circle API key or entity secret required (standard private keys only)
- Handles approval, burn, attestation wait, and `receiveMessage` in one flow

Exposed as `POST /api/bridge/bridge-kit` and also runnable as a standalone CLI.

---

## Circle Integration

The backend interacts with three Circle services:

| Circle Service | Backend Module | Purpose |
|---|---|---|
| CCTP v2 (Sepolia contracts) | `sepoliaWatcher.ts` | Detect `MessageSent` events from `TokenMessenger.depositForBurn()` |
| Attestation API | `attestationPoller.ts` | Poll `iris-api-sandbox.circle.com` for signed attestations |
| Bridge Kit SDK | `bridgeService.ts` | Higher-level multi-chain CCTP automation |

**Dependencies:**
```json
{
  "@circle-fin/bridge-kit": "^1.6.0",
  "@circle-fin/adapter-viem-v2": "^1.5.0"
}
```

---

## HTTP API

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Health check |
| GET | `/api/receivables` | All active receivables as JSON |
| GET | `/api/tokens` | Contract addresses (usdc, eurc, meantime) |
| GET | `/api/sse` | Server-sent events stream (real-time receivable updates) |
| POST | `/api/bridge/initiate-cctp` | Register a Sepolia burn (called by frontend after `depositForBurn`) |
| POST | `/api/bridge/settle` | Manually trigger settlement by message hash |
| POST | `/api/bridge/force-settle` | Force-settle with mock mint (testnet only) |
| POST | `/api/bridge/bridge-kit` | Bridge Kit endpoint (multi-chain CCTP) |

### SSE Events

Connect to `/api/sse`. The server sends JSON events in this shape:

```json
{ "type": "minted",  "receivable": { ... } }
{ "type": "listed",  "receivable": { ... } }
{ "type": "delisted","receivable": { ... } }
{ "type": "filled",  "receivable": { ... } }
{ "type": "settled", "tokenId": "5"        }
```

On connect, the server immediately sends a snapshot of all current receivables.

---

## In-Memory Store

`store.ts` holds all receivable state. It is rebuilt from chain events on startup via `backfillStore()`. There is no database. If the backend restarts, state is replayed from the chain.

The store also acts as an event bus: `store.subscribe()` registers a callback that fires on every mutation. The SSE route uses this to push updates to connected clients.

**Store interface:**
- `get(tokenId)` — Get a single receivable
- `snapshot()` — Get all active receivables
- `upsert(r)` — Insert or replace a receivable
- `patch(tokenId, update)` — Partial update
- `remove(tokenId)` — Remove (after settlement)
- `subscribe(fn)` / `emit(event)` — Event bus for SSE
- `markKnown(hash)` / `isKnown(hash)` — Track seen CCTP message hashes (prevent duplicate mints)

---

## Transaction Queue

All Arc write transactions go through `txQueue.ts`, which executes them serially. This prevents nonce collisions when multiple events arrive simultaneously (e.g. several Sepolia burns detected at once).

```typescript
// Usage
const txHash = await enqueueTx(() =>
  ctx.walletClient.writeContract({ ... })
)
```

---

## Utility Scripts

Run from the `backend/` directory:

```bash
# Mint mock USDC and EURC to any Arc address
npx tsx src/mintTokens.ts 0xYourArcAddress

# Scan Sepolia for burns missed while the backend was offline
npx tsx src/retrigger.ts

# Clean up old test NFTs (mock-mints USDC and settles them)
npx tsx src/cleanup.ts
```

---

## Testing

```bash
npm test          # run all tests
npm run test:watch # watch mode
```

Tests use Vitest + Supertest and cover:
- Store operations (upsert, patch, remove, subscribe)
- CCTP message parsing (v2 format validation)
- HTTP API endpoints
- Watcher integration

---

## Known Limitations

- **Arc MessageTransmitter address is unknown.** The native CCTP `receiveMessage()` on Arc is not called. Instead, the poller mocks USDC arrival via `MockERC20.mint()`. When the real address is found, set `ARC_MESSAGE_TRANSMITTER` in `.env`.
- **30-second Sepolia poll lag.** Free public Sepolia RPCs do not support event subscriptions, so burns can take up to 30 seconds to be detected.
- **No persistent storage.** A restart replays ~50k blocks to rebuild state. Very old events are not replayed.
