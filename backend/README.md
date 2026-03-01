# Backend

Node.js service that bridges the gap between on-chain events and the frontend. It watches for CCTP burns on Sepolia, mints NFTs on Arc, polls Circle's attestation API, and serves a real-time SSE stream.

---

## Tech Stack

- **Runtime:** Node.js with `tsx` for TypeScript execution
- **HTTP:** Express
- **Blockchain:** viem (public and wallet clients for both Sepolia and Arc)
- **Circle:** `@circle-fin/bridge-kit`, `@circle-fin/adapter-viem-v2`
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
```

---

## Services

### `watcher.ts` -- Arc event watcher

Polls Arc every 2 seconds for new `Minted`, `Listed`, `Delisted`, `Filled`, and `Settled` events. On startup, `backfillStore()` replays the last ~50k blocks in chunks to rebuild the in-memory state.

Arc public RPCs do not support `eth_newFilter`, so all event fetching uses `getLogs` polling rather than subscriptions.

### `sepoliaWatcher.ts` -- Sepolia burn watcher

Polls Sepolia every 30 seconds for `MessageSent` events from Circle's `MessageTransmitter` contract. Filters for messages destined for Arc domain (26) with MeanTime as the mint recipient. When it finds a new burn, it immediately calls `MeanTime.mint()` on Arc (optimistic, before attestation).

The `intendedRecipients` map (txHash -> recipient) is used to associate a burn with the correct Arc-side beneficiary, populated when the frontend calls `POST /api/bridge/initiate-cctp`.

### `attestationPoller.ts` -- Circle attestation poller

Polls `iris-api-sandbox.circle.com` every 30 seconds for each active CCTP message hash. When Circle returns `status: complete`, it calls `MeanTime.settle()` on Arc (which requires the contract to already hold the inbound USDC from `receiveMessage()`).

As a testnet fallback, if the Arc MessageTransmitter address is not configured, the poller instead mocks the USDC arrival by calling `MockERC20.mint()` directly, then settles. This lets the full flow work even without native CCTP on Arc.

### `bridgeService.ts` -- Circle Bridge Kit

Alternative CCTP integration using Circle's official Bridge Kit SDK. Supports multi-chain flows (Sepolia, Arbitrum, Base to Arc). Exposed as `POST /api/bridge/bridge-kit` and also runnable as a CLI.

---

## HTTP API

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Health check |
| GET | `/api/receivables` | All active receivables as JSON |
| GET | `/api/tokens` | Contract addresses (usdc, eurc, meantime) |
| GET | `/api/sse` | Server-sent events stream (real-time receivable updates) |
| POST | `/api/bridge/initiate-cctp` | Register a Sepolia burn (called by frontend) |
| POST | `/api/bridge/settle` | Manually trigger settlement by message hash |
| POST | `/api/bridge/force-settle` | Force-settle with mock mint (testnet only) |
| POST | `/api/bridge/bridge-kit` | Bridge Kit endpoint |

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

---

## Transaction Queue

All Arc write transactions go through `txQueue.ts`, which executes them serially. This prevents nonce collisions when multiple events arrive simultaneously (e.g. several Sepolia burns detected at once).

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

## Known Limitations

- **Arc MessageTransmitter address is unknown.** The native CCTP `receiveMessage()` on Arc is not called. Instead, the poller mocks USDC arrival via `MockERC20.mint()`. When the real address is found, set `ARC_MESSAGE_TRANSMITTER` in `.env`.
- **30-second Sepolia poll lag.** Free public Sepolia RPCs do not support event subscriptions, so burns can take up to 30 seconds to be detected.
- **No persistent storage.** A restart replays ~50k blocks to rebuild state. Very old events are not replayed.
