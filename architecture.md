# Architecture

MeanTime is a three-tier protocol: a Solidity contract on Arc, a Node.js backend, and a React frontend. The backend acts as the glue between Circle's off-chain attestation API and the on-chain settlement logic.

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

### CCTP (Cross-Chain Transfer Protocol) v1 / v2

CCTP is the core primitive the protocol is built on. It provides a trustless burn-and-mint mechanism for USDC across chains, backed by Circle's attestation service.

**How we use it:**

1. **Source chain (Sepolia):** The `SendPanel` calls `depositForBurn()` on Circle's `TokenMessenger` contract. This burns the user's USDC and emits a `MessageSent` event containing the raw CCTP message bytes.

2. **Message detection:** The backend's `sepoliaWatcher.ts` polls the Sepolia `MessageTransmitter` for `MessageSent` events, decodes the CCTP message bytes, and identifies burns destined for Arc (domain 26) with MeanTime as the mint recipient.

3. **Optimistic minting:** Before waiting for Circle's attestation, the backend immediately mints an NFT on Arc via `MeanTime.mint()`. This is the "instant" part of InstantSettle.

4. **Attestation polling:** `attestationPoller.ts` polls `iris-api-sandbox.circle.com/attestations/{messageHash}` every 30 seconds. The message hash is `keccak256(rawMessageBytes)`.

5. **Destination chain (Arc):** When Circle returns `status: complete` along with a signature, the backend calls `MessageTransmitter.receiveMessage(message, attestation)` on Arc to release the minted USDC to the MeanTime contract. Then it calls `MeanTime.settle()` to pay the current beneficial owner and burn the NFT.

| CCTP Component | Sepolia Address |
|---|---|
| TokenMessenger (v2) | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` |
| MessageTransmitter (v2) | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` |
| USDC | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |

| CCTP Component | Arc Domain |
|---|---|
| CCTP Domain | 26 |

### Circle Bridge Kit (`@circle-fin/bridge-kit`)

The backend also integrates Circle's official Bridge Kit SDK via `bridgeService.ts`. This provides a higher-level abstraction over raw CCTP that handles multi-chain routing, fee estimation, and approval flow automatically.

Exposed as:
- REST endpoint: `POST /api/bridge/bridge-kit`
- CLI: `npx tsx src/bridgeService.ts --source ethereum-sepolia --amount 10 --recipient 0x...`

The Bridge Kit integration supports Sepolia, Arbitrum, and Base as source chains.

### Attestation API (iris-api-sandbox.circle.com)

Circle's attestation service signs CCTP messages after the required number of source-chain confirmations. The backend polls this API for each pending transfer. The attestation signature is required to call `receiveMessage()` on the destination chain.

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

The store is rebuilt from the last ~50k Arc blocks on every backend restart via `backfillStore()`. There is no database.

---

## Network Configuration

| Network | Chain ID | Role |
|---|---|---|
| Ethereum Sepolia | 11155111 | Source chain for USDC burns |
| Arc Testnet | 5042002 | Destination chain, marketplace |

| Deployed Contract | Address |
|---|---|
| MeanTime | `0x0769d1d0662894dC29cdADE1102411D2a059cc1c` |
| MockUSDC | `0xBc7f753Da5b2050bdc7F1cc7DB9FEcF0368adA34` |
| MockEURC | `0xa1E57ECab96596b36bf60B0191b2D4fDDc554847` |
| Bridge (deployer) | `0x896C329E894739418Ea7F26D62D83D9BC61f083E` |

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
