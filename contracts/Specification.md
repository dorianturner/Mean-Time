# MeanTime Contract Specification

The MeanTime contract turns a pending CCTP transfer into an ERC-721 NFT that can be traded on a built-in marketplace while Circle's attestation completes.

---

## Core Design Decisions

**The NFT never leaves the contract.**
ERC-721 ownership always points to `address(this)`. Economic ownership is tracked separately in a `beneficialOwner` mapping. This makes settlement atomic and removes all ERC-721 transfer hook complexity from the settlement path.

```
ownerOf(tokenId)        == address(this)   // always true, throughout the lifecycle
beneficialOwner[tokenId] == X              // who receives inboundToken at settlement
```

**Settlement is permissionless.**
Anyone can call `settle()`. The contract reads `beneficialOwner` and pays that address. Callers do not need any special access. In practice the backend calls it, but a relayer or the original receiver can too.

**Checks-effects-interactions throughout.**
All storage is cleared and the NFT is burned before any token transfer leaves the contract. There is no reentrancy surface.

---

## Lifecycle

```
CCTP burn on source chain
        |
        v
mint()       NFT created, beneficialOwner = original recipient
        |
        +--[optional]--> list()    listing posted, beneficialOwner unchanged
        |                    |
        |                    +--[optional]--> delist()   listing removed
        |                    |
        |                    +--> fill()    beneficialOwner = relayer,
        |                                  paymentToken sent to seller
        |
        v
settle() / claim()    inboundToken sent to beneficialOwner, NFT burned
```

---

## Storage

```solidity
struct NFTData {
    bytes32 cctpMessageHash;  // canonical ID linking this NFT to a specific CCTP message
    address inboundToken;     // ERC-20 that will arrive at attestation (USDC, EURC, ...)
    uint256 inboundAmount;    // face value in token's native decimals (USDC: 6)
    uint256 mintedAt;         // block.timestamp at mint, used as attestation age proxy
}

struct Listing {
    uint256 reservePrice;     // minimum the seller accepts, in paymentToken's decimals
    address paymentToken;     // any ERC-20 the seller wants in return
    bool active;
}

mapping(uint256 tokenId  => NFTData) public nftData;
mapping(uint256 tokenId  => Listing) public listings;
mapping(uint256 tokenId  => address) public beneficialOwner;
mapping(bytes32 msgHash  => uint256) public tokenByMessageHash;
```

Token IDs start at 1. A `tokenByMessageHash` value of 0 means "no token found" -- the default mapping value doubles as the not-found sentinel.

---

## Functions

### `mint(cctpMessageHash, inboundToken, inboundAmount, recipient)` -- bridge only

Creates the NFT for a newly detected CCTP burn. The bridge service calls this optimistically before Circle has finished attestation. The contract trusts the bridge to supply correct values -- there is no oracle or on-chain verification of the source-chain burn.

Guards:
- `AlreadyMinted` if the message hash is already registered
- `InvalidToken` / `InvalidAmount` / `InvalidRecipient` for zero-value inputs

### `list(tokenId, reservePrice, paymentToken)` -- beneficial owner only

Creates a sell order. The seller picks their own price and payment token freely. There is no restriction on which token they ask for.

To update a listing: call `delist()` then `list()` with new parameters.

### `delist(tokenId)` -- beneficial owner only

Removes the sell order. Nothing else changes. The beneficial owner is unchanged.

### `fill(tokenId)` -- anyone

Atomic swap. The relayer sends `paymentToken` at `reservePrice` to the seller; the contract updates `beneficialOwner` to the relayer. The relayer receives `inboundToken` at face value when settlement arrives.

The relayer must have pre-approved this contract to spend `listing.reservePrice` of `listing.paymentToken`.

State is updated before the token transfer (checks-effects-interactions).

### `settle(cctpMessageHash)` -- anyone

Pays out `inboundToken` to `beneficialOwner` and burns the NFT. Called by the backend when it detects the Circle attestation is complete and USDC has been minted to this contract.

The contract must hold at least `inboundAmount` of `inboundToken` when this is called.

### `claim(tokenId)` -- anyone

Same as `settle()` but takes a token ID instead of the message hash. Useful when you have the ID but not the original message bytes.

---

## Events

```solidity
event Minted(
    uint256 indexed tokenId,
    address indexed recipient,
    address inboundToken,
    uint256 inboundAmount,
    bytes32 cctpMessageHash
);

event Listed(
    uint256 indexed tokenId,
    uint256 reservePrice,
    address paymentToken,
    uint256 listedAt
);

event Delisted(uint256 indexed tokenId);

event Filled(
    uint256 indexed tokenId,
    address indexed relayer,
    address indexed seller,
    address paymentToken,
    uint256 amount,
    uint256 filledAt        // seconds since mint, useful for pricing data
);

event Settled(
    uint256 indexed tokenId,
    address indexed recipient,
    address inboundToken,
    uint256 amount
);

event SettleAttempted(     // diagnostic, emitted before state changes
    uint256 indexed tokenId,
    address indexed beneficiary,
    address inboundToken,
    uint256 inboundAmount,
    uint256 blockTimestamp,
    uint256 maturityTimestamp,
    uint256 contractBalance
);
```

---

## Edge Cases

**Attestation arrives while the NFT is still listed.**
`_settle()` deletes the listing before paying out. The beneficial owner receives inboundToken as if they had held to maturity. Any relayer who tries to fill will find the listing gone.

**`fill()` and `settle()` racing in the same block.**
If `settle()` lands first: the NFT is burned and all state is cleared. `fill()` reverts on the `listing.active` check (the listing was deleted). The original beneficial owner receives inboundToken.
If `fill()` lands first: `beneficialOwner` is updated to the relayer, then `settle()` pays the relayer. Both parties receive what they expected.

**`delist()` racing with a `fill()` in flight.**
If `delist()` lands first: `fill()` reverts. No funds move. Clean failure.
If `fill()` lands first: completes normally. The `delist()` transaction reverts.

---

## Relayer Integration

A relayer bot should:

1. Subscribe to `Listed` events (or poll `getReceivable()` on known IDs).
2. For each listing, check if it holds enough `paymentToken` to fill.
3. Fetch `nftData` to get `inboundToken` and `inboundAmount`.
4. Compute: `fairValue = inboundAmount * rate(inboundToken -> paymentToken)`.
5. Compute required spread based on `block.timestamp - mintedAt`: more time elapsed means less attestation risk remains, tighter spread needed.
6. If `fairValue - spread >= listing.reservePrice`: approve and call `fill(tokenId)`.
7. Listen for `Settled` to confirm payout.

The contract contains no pricing logic. All risk modelling is in the relayer.

---

## What Is Not in Scope (V1)

- **Active bidding.** Relayers posting competing bids for a seller to accept. Can be added as `acceptBid()` without touching existing functions.
- **LP pool fallback.** Passive liquidity backstop for listings relayers decline. The seller's only option in V1 is to hold to maturity.
- **Secondary market UI.** Relayers can technically call `list()` after `fill()` to relist, but there is no frontend support for it.
