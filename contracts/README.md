# InstantSettle — Contract Architecture

This document describes the full contract system. Read it before touching any `.sol` file.

---

## Overview

Five contracts. Two are core protocol, two are market infrastructure, one is an oracle.

```
src/
├── InstantSettle.sol       — Registry, NFT minting, CCTP settlement
├── ReceivableNFT.sol       — ERC-721: the tokenised USDC receivable
├── AttestationOracle.sol   — Tracks Ethereum block depth (confirmation counting)
├── Marketplace.sol         — Order book: list NFTs for EURC, fill with depth gating
└── LPPool.sol              — Backstop passive liquidity when Relayers don't fill

interfaces/
├── IInstantSettle.sol
├── IReceivableNFT.sol
├── IAttestationOracle.sol
├── IMarketplace.sol
└── ICCTP.sol               — Circle's ITokenMessenger + IMessageTransmitter

lib/
└── CCTPMessage.sol         — Pure library: parse raw CCTP message bytes
```

---

## The Attestation Depth Problem

This is the most important design consideration in the system.

CCTP Standard Transfer requires **65 Ethereum block confirmations** (~13 seconds each, ~14 minutes total) before Circle issues an attestation that allows USDC to be minted on Arc. The confirmation count at any given moment is the **attestation depth**.

Depth matters for two independent reasons:

| Reason | Description |
|---|---|
| **Time value** | A buyer at depth 5 waits ~13 more minutes for settlement. A buyer at depth 60 waits ~1 minute. The discount they demand differs accordingly. |
| **Reorg risk** | At very low depths, the Ethereum burn transaction could be orphaned by a chain reorganisation. By ~30 confirmations this risk is negligible. Below 5 confirmations it is non-trivial. |

These two risks compound at low depths and both approach zero near 65 confirmations. A market that exposes depth lets buyers with different risk tolerances price accordingly:

- A Relayer with hedging infrastructure might fill at depth 10 for a 0.8% discount.
- A retail buyer might wait until depth 55 and buy for 0.05%.
- The LPPool might only fill at depth 50+ as a safety policy.

**The oracle's job is to continuously update the current Ethereum block number on Arc, so depth can be computed for any transfer at any time.**

---

## Contract Specifications

---

### `AttestationOracle.sol`

The oracle is the foundation everything else reads from. It must be correct and fresh.

**State:**
```solidity
uint64 public latestEthBlock;       // Most recent Ethereum block number posted
uint40 public lastUpdatedAt;        // Arc block.timestamp of last update
mapping(address => bool) public reporters; // Authorised oracle reporters
address public owner;
uint8 public constant REQUIRED_CONFIRMATIONS = 65;
```

**Key functions:**
```solidity
// Called by authorised reporters (off-chain watchers, multiple for redundancy)
function updateEthBlock(uint64 ethBlockNumber) external onlyReporter;

// Core query: how many confirmations does a transfer currently have?
// Returns min(latestEthBlock - sourceBlockNumber, REQUIRED_CONFIRMATIONS)
function getDepth(uint64 sourceBlockNumber) external view returns (uint8 depth);

// Remaining confirmations until attestation is available
function getRemaining(uint64 sourceBlockNumber) external view returns (uint8 remaining);

// Whether a transfer has reached full confirmations (attestation available)
function isAttestable(uint64 sourceBlockNumber) external view returns (bool);

// Admin: add/remove reporters
function setReporter(address reporter, bool authorised) external onlyOwner;
```

**Important:** The oracle does not know about individual transfers. It just tracks the latest Ethereum block. All depth calculations are stateless: `depth = min(latestEthBlock - sourceBlockNumber, 65)`. The `sourceBlockNumber` lives in `InstantSettle`.

**Trust model (v1):** A multisig-controlled set of authorised reporters. The owner can add/remove them. In v2, replace with a ZK Ethereum light client proof so depth is trustless.

**Staleness check:** Consumers should verify `lastUpdatedAt` is recent (e.g., within 60 seconds) before trusting depth. The Marketplace's fill function enforces this.

---

### `ReceivableNFT.sol`

A minimal ERC-721. The NFT represents the claim on incoming USDC.

**State:**
```solidity
mapping(uint256 => TokenData) public tokenData;
uint256 private _nextTokenId;
address public instantSettle; // only minter/burner
```

**TokenData struct:**
```solidity
struct TokenData {
    uint256 usdcAmount;          // USDC amount, 6 decimals
    uint64  sourceBlockNumber;   // Ethereum block when the burn occurred
    uint32  sourceDomain;        // CCTP source domain (Ethereum = 0)
    uint64  nonce;               // CCTP message nonce (unique per transfer)
    address originalReceiver;    // Who received the NFT at mint
    uint40  registeredAt;        // Arc block.timestamp when NFT was minted
}
```

**Key functions:**
```solidity
// Only callable by InstantSettle
function mint(address to, TokenData calldata data) external returns (uint256 tokenId);
function burn(uint256 tokenId) external; // Only callable by InstantSettle

// Standard ERC-721 transfers — freely transferable, no restrictions
// This is intentional: the market depends on unrestricted transfer

// Metadata: returns JSON with usdcAmount, sourceBlockNumber, registeredAt
// Depth is NOT stored here — it is dynamic and computed from the oracle
function tokenURI(uint256 tokenId) external view returns (string memory);
```

**Why depth is not in the NFT:** Depth changes every ~13 seconds. Storing it would require constant updates (expensive). Instead, depth is always computed live: `oracle.getDepth(tokenData[tokenId].sourceBlockNumber)`.

---

### `InstantSettle.sol`

The core of the protocol. Registers transfers, mints NFTs, handles settlement.

**State:**
```solidity
mapping(bytes32 => uint256) public messageHashToTokenId;   // CCTP messageHash → NFT tokenId
mapping(uint256 => bytes32) public tokenIdToMessageHash;   // NFT tokenId → CCTP messageHash
mapping(bytes32 => bool)    public settled;                // Prevent double settlement

IReceivableNFT     public receivableNFT;
IAttestationOracle public oracle;
IMessageTransmitter public messageTransmitter;  // Circle CCTP
IERC20             public usdc;
address            public owner;

mapping(address => bool) public authorisedRegistrars; // Relayers who can call register()
```

**register() — called by Relayer before attestation:**
```solidity
function register(
    bytes calldata cctpMessage,       // Raw CCTP message bytes
    address originalReceiver,         // Who should receive the NFT
    uint64 sourceBlockNumber          // Ethereum block number of the burn tx
) external onlyAuthorisedRegistrar returns (uint256 tokenId);
```

- Decodes `cctpMessage` using `CCTPMessage.sol` to extract: `nonce`, `sourceDomain`, `destinationDomain`, `mintRecipient`, `amount`, `messageHash`
- Validates: `destinationDomain == ARC_DOMAIN`, `mintRecipient == address(this)`, `messageHash` not already registered
- Mints `ReceivableNFT` to `originalReceiver` with the decoded data and `sourceBlockNumber`
- Stores `messageHash → tokenId` mapping
- Emits `Registered`

**settle() — called by anyone once attestation is available:**
```solidity
function settle(
    bytes calldata cctpMessage,
    bytes calldata attestation
) external;
```

- Calls `messageTransmitter.receiveMessage(cctpMessage, attestation)` — this mints USDC to `address(this)`
- Looks up `tokenId = messageHashToTokenId[messageHash]`
- Looks up current NFT owner: `owner = receivableNFT.ownerOf(tokenId)`
- Transfers USDC to owner
- Burns NFT
- Marks `settled[messageHash] = true`
- Emits `Settled(tokenId, owner, amount)`

The settle caller gets a small USDC tip (configurable, e.g. 1 USDC) taken from the settled amount to incentivise prompt settlement. This tip is only economically relevant for large transfers.

**Events:**
```solidity
event Registered(
    uint256 indexed tokenId,
    bytes32 indexed messageHash,
    uint256 usdcAmount,
    address originalReceiver,
    uint64  sourceBlockNumber
);
event Settled(
    uint256 indexed tokenId,
    address indexed recipient,
    uint256 usdcAmount
);
```

**Trust assumption on `register()`:** The `originalReceiver` and `sourceBlockNumber` are provided by the Relayer and not cryptographically verified on-chain (CCTP messages do not carry this data). In v1, only authorised Relayers may call `register()`. In v2, a ZK proof of the Ethereum event replaces this. The risk of a malicious Relayer is reputational — they cannot steal the USDC (settlement pays the NFT holder), but they could issue the NFT to the wrong initial address.

---

### `Marketplace.sol`

The order book. Sellers list NFTs at an EURC price. Buyers fill with an optional minimum depth requirement.

**State:**
```solidity
struct Listing {
    uint256 tokenId;
    address seller;
    uint256 eurcAskPrice;   // EURC, 6 decimals
    uint40  listedAt;
    bool    active;
}

mapping(uint256 => Listing) public listings;
uint256 private _nextListingId;

IERC20             public eurc;
IReceivableNFT     public receivableNFT;
IAttestationOracle public oracle;
uint256 public constant MAX_ORACLE_STALENESS = 60; // seconds
```

**list():**
```solidity
function list(uint256 tokenId, uint256 eurcAskPrice) external returns (uint256 listingId);
```
- Seller must own the NFT and have approved the Marketplace
- Transfers NFT to Marketplace (escrow)
- Creates Listing, emits `Listed`

**fill():**
```solidity
function fill(uint256 listingId, uint8 minDepthRequired) external;
```

- Checks `oracle.lastUpdatedAt` is within `MAX_ORACLE_STALENESS` — reverts if oracle is stale
- Computes `currentDepth = oracle.getDepth(tokenData.sourceBlockNumber)`
- Reverts if `currentDepth < minDepthRequired` with `InsufficientDepth(currentDepth, minDepthRequired)`
- Transfers `eurcAskPrice` EURC from buyer to seller
- Transfers NFT from escrow to buyer
- Records `depthAtFill` in the event
- Emits `Filled`

**cancel():**
```solidity
function cancelListing(uint256 listingId) external;
```
- Only callable by seller
- Returns NFT from escrow to seller

**Events:**
```solidity
event Listed(uint256 indexed listingId, uint256 indexed tokenId, address seller, uint256 eurcAskPrice);
event Filled(uint256 indexed listingId, uint256 indexed tokenId, address buyer, uint256 eurcPaid, uint8 depthAtFill);
event Cancelled(uint256 indexed listingId, uint256 indexed tokenId);
```

**Why `depthAtFill` is in the event:** This creates an on-chain dataset of fills at different depths with different prices. This is the raw data for pricing models, Relayer risk calibration, and protocol analytics.

**`minDepthRequired = 0`** means the buyer accepts any depth (effectively "fill immediately"). Relayers will typically set this to 0 since they actively manage risk. Retail buyers might set 40–55.

---

### `LPPool.sol`

A passive EURC liquidity pool that backstops transfers Relayers decline to fill.

**State:**
```solidity
struct PoolConfig {
    uint8  minDepthToFill;     // Pool won't fill below this depth (safety param)
    uint16 spreadBps;          // Discount vs face value, e.g. 50 = 0.5%
    uint256 maxFillSize;       // Maximum USDC amount the pool will fill in one tx
}

mapping(address => uint256) public shares;
uint256 public totalShares;
uint256 public totalEurc;
PoolConfig public config;

IMarketplace       public marketplace;
IAttestationOracle public oracle;
IERC20             public eurc;
address            public owner;
```

**Depositor functions:**
```solidity
function deposit(uint256 eurcAmount) external returns (uint256 sharesReceived);
function withdraw(uint256 shares) external returns (uint256 eurcReceived);
```

**Keeper function (anyone can call):**
```solidity
function autoFill(uint256 listingId) external;
```

- Reads the listing from Marketplace
- Derives `usdcAmount` from `receivableNFT.tokenData(tokenId).usdcAmount`
- Computes fair EURC price: `eurcAmount = usdcAmount - (usdcAmount * config.spreadBps / 10000)`
- Checks: `listing.eurcAskPrice <= eurcAmount` (pool only fills if ask is at or below the pool's price)
- Checks: `oracle.getDepth(sourceBlockNumber) >= config.minDepthToFill`
- Checks: `usdcAmount <= config.maxFillSize`
- Calls `marketplace.fill(listingId, config.minDepthToFill)`
- The NFT goes to the pool; when settled, USDC arrives to pool and distributes to depositors as yield

The LPPool is intentionally passive and conservative. It should never be the first-resort filler.

---

### `CCTPMessage.sol` (library)

Pure library for decoding raw CCTP message bytes.

```solidity
library CCTPMessage {
    struct DecodedMessage {
        uint32  version;
        uint32  sourceDomain;
        uint32  destinationDomain;
        uint64  nonce;
        bytes32 sender;
        bytes32 recipient;           // mintRecipient
        bytes32 destinationCaller;
        uint256 amount;
        address burnToken;
        bytes32 messageHash;
    }

    function decode(bytes calldata message) internal pure returns (DecodedMessage memory);
    function computeHash(bytes calldata message) internal pure returns (bytes32);
}
```

---

## Data Flow

### Transfer Lifecycle

```
1. INITIATION (Ethereum)
   User calls TokenMessenger.depositForBurnWithCaller(
       amount,
       ARC_DOMAIN,
       mintRecipient = address(InstantSettle_Arc),
       destinationCaller = address(InstantSettle_Arc)
   )
   → Emits MessageSent(message bytes) on Ethereum

2. REGISTRATION (Arc, ~seconds after burn)
   Relayer watches Ethereum for MessageSent events
   Relayer calls InstantSettle.register(cctpMessage, originalReceiver, sourceBlockNumber)
   → ReceivableNFT minted to originalReceiver
   → Transfer stored: messageHash → tokenId

3. MARKET WINDOW (Arc, 0–65 confirmations, ~0–14 minutes)
   Oracle reporters update latestEthBlock every ~15 seconds
   Depth for this transfer: latestEthBlock - sourceBlockNumber

   [Optional] originalReceiver lists NFT on Marketplace at eurcAskPrice
   Relayer fills listing (minDepthRequired = 0)
   → Receiver gets EURC immediately
   → Relayer holds NFT, waits for settlement

   [Optional] Relayer relists NFT to another buyer
   Secondary buyer fills at higher depth (lower remaining risk)

4. SETTLEMENT (Arc, once 65 confirmations reached)
   Circle attestation becomes available
   Anyone calls InstantSettle.settle(cctpMessage, attestation)
   → messageTransmitter.receiveMessage() mints USDC to InstantSettle
   → InstantSettle sends USDC to current NFT holder
   → NFT burned
```

---

## Confirmation Depth Risk Model

This table is informational — it informs how frontends and Relayers should think, not contract logic.

| Depth | Remaining | Reorg Risk | Time Remaining | Expected Discount |
|---|---|---|---|---|
| 0–5 | 60–65 | Non-trivial | ~13–14 min | 0.5–2%+ |
| 5–20 | 45–60 | Low | ~10–13 min | 0.3–0.8% |
| 20–40 | 25–45 | Negligible | ~5–10 min | 0.15–0.4% |
| 40–55 | 10–25 | Negligible | ~2–5 min | 0.05–0.2% |
| 55–64 | 1–10 | None | <2 min | <0.05% |
| 65 | 0 | None | Now | 0% |

The two risk components (reorg risk and time value) compound at low depths. At high depths, only time value remains, and it is tiny. A healthy market should see natural price discovery along this curve.

---

## Security Considerations

**Re-entrancy:** `InstantSettle.settle()` must transfer USDC *after* burning the NFT (or use a re-entrancy guard). The check-effects-interactions pattern: burn first, transfer second.

**Double settlement:** `settled[messageHash]` is checked before calling `receiveMessage`. `receiveMessage` itself also reverts on replay (Circle's own protection), so this is defence in depth.

**Oracle staleness:** `Marketplace.fill()` reverts if `oracle.lastUpdatedAt` is more than `MAX_ORACLE_STALENESS` seconds old. Without this, a stale oracle could let buyers fill at a depth that's actually much higher (letting them demand a spread that no longer reflects real risk). Note: a stale oracle is always safe for sellers — it can only disadvantage buyers. The staleness check protects buyers.

**Fake registrations:** `register()` is restricted to authorised Relayers. Even if a Relayer registers a fake transfer (with a messageHash that doesn't correspond to a real CCTP burn), `settle()` will fail because `messageTransmitter.receiveMessage()` will revert on an invalid attestation. The fake NFT is permanently unsettleable — worthless, but harmless to the protocol.

**NFT escrow:** The Marketplace holds NFTs in escrow during listings. If the Marketplace contract is paused or broken, a `cancelListing` function always lets the seller reclaim their NFT. Settlement can still occur while an NFT is in the Marketplace (the Marketplace is the current holder and receives the USDC, distributing it to the fill buyer).

**Front-running `settle()`:** Anyone can call `settle()`. A searcher who front-runs the original settler just pays more gas for the same outcome — the USDC still goes to the correct NFT holder. No value is extractable by front-running settlement.

---

## Upgrade Path

**v1 (current):** Authorised Relayer set for `register()`. Centralised oracle reporters for depth. Immutable contracts otherwise.

**v2:** Replace oracle reporters with a ZK light client (e.g., Herodotus storage proofs) that trustlessly proves Ethereum block state on Arc. Replace authorised Relayer set with open registration gated by a ZK proof of the Ethereum `MessageSent` event, eliminating the trust assumption on `originalReceiver`.
