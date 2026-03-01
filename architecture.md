# Architecture

<<<<<<< HEAD
MeanTime is a three-tier protocol: a **Solidity smart contract** on Arc, a **Node.js backend**, and a **React frontend**. The backend acts as the glue between Circle's off-chain attestation API and the on-chain settlement logic.

---

## Table of Contents

- [High-Level Flow](#high-level-flow)
- [Component Map](#component-map)
- [Circle Tools Used](#circle-tools-used)
- [Smart Contract Design](#smart-contract-design)
- [Data Flow: Listing and Fill](#data-flow-listing-and-fill)
- [Data Flow: Settlement](#data-flow-settlement)
- [Backend State Machine](#backend-state-machine)
- [Network Configuration](#network-configuration)
- [Security Model](#security-model)
- [Why Arc](#why-arc)
- [Testnet Limitations](#testnet-limitations)
=======
MeanTime is a three-tier protocol: a Solidity contract on Arc, a Node.js backend, and a React frontend. The backend acts as the glue between Circle's off-chain attestation API and the on-chain settlement logic.
>>>>>>> 5c24d110da6e71cac5f9439beed830a048198b20

---

## High-Level Flow

Circle's infrastructure (highlighted with `[ ]`) sits at three points in the flow: the source-chain burn, the attestation service, and the destination-chain mint.

```
  USER (Sepolia)               CIRCLE INFRASTRUCTURE          ARC TESTNET
  ──────────────               ─────────────────────          ──────────────────────

  Frontend: SendPanel
       │
       │ 1. approve USDC spend
       ▼
  [CCTP TokenMessenger]        ──────────────────────────────────────────────────────
  depositForBurn()             │  Circle burns USDC on Sepolia
       │                       │  emits MessageSent(rawMessageBytes)
       │                       └──────────────────────────────────────────────────────
       ▼
  Backend: sepoliaWatcher
  polls MessageTransmitter
  every 30s, detects burn
       │
       │ 2. mint() optimistically (before attestation)
       ▼                                                       MeanTime.sol
                                                               NFT minted
                                                               beneficialOwner = recipient
                                                               SSE → frontend
       │
       │ 3. backend starts polling Circle
       ▼
                               [Circle Attestation API]
                               iris-api-sandbox.circle.com
                               /attestations/{messageHash}
                               polling every 30s
                                        │
                               (~17 min later)
                               status: complete + signature
                                        │
       ┌────────────────────────────────┘
       │ 4. receiveMessage(message, attestation)
       ▼
  [CCTP MessageTransmitter]                                    USDC minted
  on Arc                       ──────────────────────────────► to MeanTime contract
                                                                    │
                                                               5. settle()
                                                                    │
                                                               USDC → beneficialOwner
                                                               NFT burned

  ── ── ── ── ── OPTIONAL MARKETPLACE PATH ── ── ── ── ──

  After step 2, before step 4:

  Receiver lists NFT ──► Relayer fills ──► receiver gets ARC tokens instantly
                                           relayer becomes beneficialOwner
                                           (receives USDC at step 5)
```

### Alternative: Circle Bridge Kit

`bridgeService.ts` wraps `@circle-fin/bridge-kit` as a higher-level alternative to the manual CCTP flow above. It handles steps 1-4 in a single SDK call and supports multiple source chains (Sepolia, Arbitrum, Base).

```
  Frontend / CLI
       │
       ▼
  [Circle Bridge Kit]          handles approve + depositForBurn + polling
  @circle-fin/bridge-kit       + receiveMessage automatically
  @circle-fin/adapter-viem-v2
       │
       ▼
  Same outcome: USDC arrives at MeanTime on Arc
```

---

## Component Map

```
┌─────────────────────────────────────────────────────────────┐
│                        Frontend (React)                      │
│                                                              │
│  ConnectButton   SendPanel   Marketplace   BridgePanel       │
│       │              │            │              │           │
│  useWallet   useReceivables  useContractActions  │           │
│       │              │            │              │           │
│  MetaMask    SSE /api/sse  eth_sendTransaction   │           │
└──────────────────┬──────────────────────────────┘           │
                   │ HTTP + SSE                                │
┌──────────────────▼──────────────────────────────────────────┤
│                        Backend (Node.js)                     │
│                                                              │
│  sepoliaWatcher    watcher.ts       attestationPoller        │
│  (Sepolia burns)   (Arc events)     (Circle API)             │
│        │                │                 │                  │
│        └────────────────┴────────────────►│                  │
│                                     store.ts (in-memory)     │
│                                           │                  │
│                                     SSE event bus            │
│                                           │                  │
│  txQueue.ts (serial nonce safety)         │                  │
│        │                                  │                  │
│  viem WalletClient ◄──────────────────────┘                  │
└──────────────────┬──────────────────────────────────────────┘
                   │ JSON-RPC
┌──────────────────▼──────────────────────────────────────────┐
│                MeanTime.sol (Arc Testnet)                    │
│                                                              │
│  mint()    list()    delist()    fill()    settle()/claim()  │
│                                                              │
│  beneficialOwner mapping                                     │
│  nftData mapping                                             │
│  listings mapping                                            │
│  tokenByMessageHash mapping                                  │
└─────────────────────────────────────────────────────────────┘
```

---

## Circle Tools Used

MeanTime is built on three Circle primitives. This section details exactly how each is integrated.

### CCTP (Cross-Chain Transfer Protocol) v2

CCTP is the core primitive the protocol is built on. It provides a trustless burn-and-mint mechanism for USDC across chains, backed by Circle's attestation service.

**How we use it — step by step:**

1. **Source chain burn (Sepolia):** The `SendPanel` in the frontend calls `depositForBurn()` on Circle's `TokenMessenger` (v2) contract. This burns the user's USDC and emits a `MessageSent` event containing the raw CCTP message bytes. The destination domain is set to `26` (Arc) and the mint recipient is the MeanTime contract address.

2. **Message detection:** The backend's `sepoliaWatcher.ts` polls the Sepolia `MessageTransmitter` for `MessageSent` events every 30 seconds using `getLogs` (public Sepolia RPCs don't support persistent filters). It parses the CCTP v2 message format:
   - **Header (148 bytes):** version (4B), sourceDomain (4B), destDomain (4B), nonce (32B), sender (32B), recipient (32B), destinationCaller (32B), minFinality (4B), finalityExecuted (4B)
   - **BurnMessage body:** version (4B), burnToken (32B), mintRecipient (32B), amount (32B), messageSender (32B)

3. **Optimistic minting:** Before waiting for Circle's attestation (the key innovation), the backend immediately mints an NFT on Arc via `MeanTime.mint()`. The message hash (`keccak256(rawMessageBytes)`) becomes the canonical identifier linking the NFT to the CCTP transfer.

4. **Attestation polling:** `attestationPoller.ts` polls `iris-api-sandbox.circle.com/attestations/{messageHash}` every 30 seconds. When Circle returns `status: complete` along with a signature, the transfer is ready to settle.

5. **Destination chain settlement (Arc):** The backend calls `MessageTransmitter.receiveMessage(message, attestation)` on Arc to release the minted USDC to the MeanTime contract. Then it calls `MeanTime.settle()` to pay the current beneficial owner and burn the NFT.

| CCTP Component | Sepolia Address |
|---|---|
| TokenMessenger (v2) | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` |
| MessageTransmitter (v2) | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` |
| USDC | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |

| CCTP Parameter | Value |
|---|---|
| Arc Domain | 26 |
| Required Confirmations | 65 blocks (~17 minutes) |
| Finality Threshold | 2000 (Standard Transfer) |

### USDC & EURC (Circle Stablecoins)

Both stablecoins are natively issued by Circle on Arc:

- **USDC** (`0x3600000000000000000000000000000000000000`) — The inbound token from CCTP transfers. Used as the settlement currency. 6 decimals via ERC-20 interface; note: 18 decimals as native gas token — these are never mixed.
- **EURC** — Default payment token on the marketplace. Relayers pay EURC to buy USDC receivables, monetising the FX spread during the attestation window.

The protocol requires both stablecoins to be credibly liquid on the destination chain for the marketplace to function.

### Circle Bridge Kit (`@circle-fin/bridge-kit`)

The backend also integrates Circle's official Bridge Kit SDK via `bridgeService.ts`. This provides a higher-level abstraction over raw CCTP that handles multi-chain routing, fee estimation, and approval flow automatically.

**Key implementation details:**
- Uses `@circle-fin/adapter-viem-v2` for wallet integration (standard private keys, no developer-controlled wallets, no API key required)
- Source adapter: sender's private key (approves + burns on source chain)
- Arc adapter: deployer private key (calls `receiveMessage` on Arc)
- Recipient address: MeanTime contract (receives the USDC)
- After bridge completes: deployer calls `MeanTime.mint()` + `MeanTime.settle()`

**Supported source chains:**
| Chain | Bridge Kit Name | CCTP Domain |
|---|---|---|
| Ethereum Sepolia | `Ethereum_Sepolia` | 0 |
| Arbitrum Sepolia | `Arbitrum_Sepolia` | 3 |
| Base Sepolia | `Base_Sepolia` | 6 |

Exposed as:
- **REST endpoint:** `POST /api/bridge/bridge-kit`
- **CLI:** `npx tsx src/bridgeService.ts --source ethereum-sepolia --amount 10 --recipient 0x...`

### Circle Attestation Service (`iris-api-sandbox.circle.com`)

Circle's attestation service signs CCTP messages after the required number of source-chain confirmations. The backend polls this API for each pending transfer:

```
GET https://iris-api-sandbox.circle.com/attestations/{messageHash}

// Pending:
{ "status": "pending_confirmations", "attestation": null }

// Complete:
{ "status": "complete", "attestation": "0x<signature>" }
```

The attestation signature is the cryptographic proof required to call `receiveMessage()` on the destination chain. As a testnet fallback, if attestation doesn't arrive within 17 minutes, the backend auto-settles by mock-minting USDC and calling `settle()` directly.

---

## Smart Contract Design

The MeanTime contract makes three deliberate choices:

**1. Custodial NFTs.** The ERC-721 is minted to `address(this)` and never leaves. Economic ownership (who gets paid at settlement) is tracked separately in `beneficialOwner`. This eliminates ERC-721 transfer hook complexity from the settlement path and means the marketplace does not need to worry about NFTs being moved out from under it.

**2. Permissionless settlement.** Anyone can call `settle()`. The contract reads `beneficialOwner` and pays that address. The backend calls it automatically, but keepers, relayers, or the receiver can also trigger it. This removes operational dependency on the backend being alive.

**3. Checks-effects-interactions.** All storage is cleared and the NFT burned before any token transfer leaves the contract. No reentrancy guards are needed because the external call is the last thing that happens.

---

## Data Flow: Listing and Fill

```
                  Beneficial Owner            Relayer
                        │                       │
                   list(tokenId,                │
                     reservePrice,              │
                     paymentToken)              │
                        │                       │
                        ▼                       │
              listings[tokenId] = {             │
                reservePrice, paymentToken,      │
                active: true                     │
              }                                  │
                        │                       │
              Listed event emitted              │
                                                 │
                               approve(paymentToken, reservePrice)
                                                 │
                                           fill(tokenId)
                                                 │
                                                 ▼
                               listings[tokenId] deleted
                               beneficialOwner = relayer
                               paymentToken -> seller
                                                 │
                                         Filled event emitted
```

---

## Data Flow: Settlement

```
   Circle API         Backend            Arc Chain
       │                 │                   │
       │  status:complete│                   │
       │────────────────►│                   │
       │                 │ receiveMessage()  │
       │                 │──────────────────►│
       │                 │                   │ USDC minted
       │                 │                   │ to MeanTime
       │                 │ settle(msgHash)    │
       │                 │──────────────────►│
       │                 │                   │ read beneficialOwner
       │                 │                   │ delete all state
       │                 │                   │ burn NFT
       │                 │                   │ transfer USDC
       │                 │                   │
       │                 │           Settled event
       │                 │◄──────────────────│
       │                 │                   │
       │          SSE push to frontend
```

---

## Backend State Machine

Each receivable in `store.ts` transitions through these states, driven by on-chain events:

```
  minted
    │
    ├── listed ──── delisted ──► [unlisted]
    │       │
    │    filled ──────────────► [relayer is beneficialOwner]
    │
    └── settled ──────────────► [removed from store]
```

The store is rebuilt from the last ~50k Arc blocks on every backend restart via `backfillStore()`. There is no database. State is replayed from the chain, making the backend stateless and restartable.

**Key backend services:**

| Service | File | Role | Interval |
|---|---|---|---|
| Sepolia Watcher | `sepoliaWatcher.ts` | Detect CCTP burns on Sepolia, mint NFTs on Arc | 30s poll |
| Arc Watcher | `watcher.ts` | Track contract events (Minted, Listed, Filled, Settled) | 2s poll |
| Attestation Poller | `attestationPoller.ts` | Poll Circle API, settle when attestation arrives | 30s poll |
| Transaction Queue | `txQueue.ts` | Serialize on-chain writes to prevent nonce collisions | On-demand |
| SSE Event Bus | `store.ts` | Push real-time updates to connected frontends | On event |
| Bridge Kit | `bridgeService.ts` | Alternative CCTP integration via Circle SDK | On request |

---

## Network Configuration

| Network | Chain ID | CCTP Domain | Role |
|---|---|---|---|
| Ethereum Sepolia | 11155111 | 0 | Source chain for USDC burns |
| Arc Testnet | 5042002 | 26 | Destination chain, marketplace |

| Deployed Contract | Address |
|---|---|
| MeanTime | See `deployments.json` |
| MockUSDC | See `deployments.json` |
| MockEURC | See `deployments.json` |
| Bridge (deployer) | See `deployments.json` |

---

## Security Model

MeanTime's security relies on several layers:

**On-chain (MeanTime.sol):**
- **Access control:** Only the designated bridge address can mint NFTs. Marketplace operations are restricted to beneficial owners.
- **Checks-effects-interactions:** All storage is cleared and the NFT burned before any token transfer leaves the contract. No reentrancy surface exists.
- **No oracle dependency:** The contract has no pricing logic and no oracle. All risk modelling is external (in relayer bots).
- **Atomic settlement:** `_settle()` reads state, clears all mappings, burns the NFT, then transfers tokens — in a single transaction.
- **Race condition safety:** Concurrent `fill()` and `settle()` in the same block resolve cleanly regardless of ordering. See [Specification.md](contracts/Specification.md) for detailed analysis.

**Off-chain (Backend):**
- **Serial transaction queue** (`txQueue.ts`): Prevents nonce collisions when multiple events arrive simultaneously.
- **Stateless restart:** The backend rebuilds state from chain events on startup. No database means no state corruption risk.
- **Intended recipient tracking:** The `intendedRecipients` map prevents minting to the wrong beneficiary.

**Trust assumptions:**
- The bridge service (backend) is trusted to supply correct mint parameters. There is no on-chain verification of the source-chain burn — this is a deliberate trade-off for speed (optimistic minting).
- Circle's attestation service is trusted to only sign valid CCTP messages.

---

## Why Arc

Arc is the only chain where this protocol makes sense:

- Circle natively issues both USDC and EURC on Arc. The spread market requires a credible, liquid pairing of both.
- Sub-second finality means fills settle in under a second. On a chain with 12-second blocks, the UX would be unusable.
- CCTP is foundational on Arc, not bolted on.
- KYC-compatible validators make the settlement path legally credible for institutional participants.

---

## Testnet Limitations

The current deployment runs against Arc's test environment. Two constraints apply:

1. **Arc MessageTransmitter address.** Circle has not published the Arc testnet `MessageTransmitter` address. The backend falls back to calling `MockERC20.mint()` to simulate USDC arrival, then calls `settle()`. Real CCTP `receiveMessage()` will be used once the address is available. Set `ARC_MESSAGE_TRANSMITTER` in `.env`.

2. **Attestation timing.** The Circle sandbox attestation API (`iris-api-sandbox.circle.com`) is used. On testnet, attestation can take longer than the 17-minute estimate depending on Sepolia block times.
