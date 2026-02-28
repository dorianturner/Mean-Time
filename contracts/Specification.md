# InstantSettle — Smart Contract Specification

> Tokenised CCTP receivables. Every cross-chain token transfer becomes a tradeable on-chain asset.

---

## What This Contract Does

When a user burns a CCTP-supported token on a source chain, there is a 15–19 minute window before it arrives on the destination chain. During that window, InstantSettle mints an NFT representing the incoming receivable. The NFT holder at the time the attestation arrives receives the tokens.

This means:
- The original receiver can hold the NFT and wait, receiving the full token amount at maturity
- Or they can list the NFT at a reserve price in any token they choose, and a Relayer buys it instantly — the Relayer then waits for the inbound tokens and earns the spread

The contract is generic. It works for any token that CCTP supports on both the source and destination chain. It has no opinion on what token the seller wants in return.

---

## Architecture

### Key Principle: The NFT Never Leaves The Contract

The ERC721 NFT is minted to `address(this)` and stays there for its entire lifecycle. Economic ownership is tracked separately via `beneficialOwner`. This avoids ERC721 transfer hook complexity and race conditions during attestation.

```
ownerOf(tokenId) == address(this)   // always, throughout lifecycle
beneficialOwner[tokenId] == X       // the address that will receive inboundToken at settlement
```

### Lifecycle

```
CCTP burn on source chain
        │
        ▼
mint()  → NFT created, beneficialOwner = original recipient
        │
        ├── [optional] list() → listing activated, beneficialOwner unchanged
        │         │
        │         ├── [optional] delist() → listing removed, nothing else changes
        │         │
        │         └── fill() → beneficialOwner = Relayer, paymentToken sent to seller
        │
        ▼
settle() → inboundToken sent to beneficialOwner, NFT burned
```

---

## Storage

```solidity
struct NFTData {
    bytes32 cctpMessageHash;  // links this NFT to a specific CCTP transfer
    address inboundToken;     // the CCTP token that will arrive at attestation (e.g. USDC, EURC)
    uint256 inboundAmount;    // face value, in units of inboundToken
    uint256 mintedAt;         // block.timestamp at mint, used as attestation progress proxy
}

struct Listing {
    uint256 reservePrice;     // minimum amount the seller will accept, in units of paymentToken
    address paymentToken;     // any ERC20 the seller wants to receive in exchange
    bool active;
}

mapping(uint256 tokenId => NFTData) public nftData;
mapping(uint256 tokenId => Listing) public listings;
mapping(uint256 tokenId => address) public beneficialOwner;
mapping(bytes32 messageHash => uint256 tokenId) public tokenByMessageHash;
```

---

## Functions

### `mint(cctpMessageHash, inboundToken, inboundAmount, recipient)`

**Called by:** Bridge contract only (`onlyBridge` modifier). Not user-callable.

**What it does:** Detects a CCTP burn event and mints an NFT representing the incoming receivable.

```solidity
function mint(
    bytes32 cctpMessageHash,
    address inboundToken,
    uint256 inboundAmount,
    address recipient
) external onlyBridge returns (uint256 tokenId) {
    tokenId = _nextTokenId++;
    _mint(address(this), tokenId);

    nftData[tokenId] = NFTData({
        cctpMessageHash: cctpMessageHash,
        inboundToken: inboundToken,
        inboundAmount: inboundAmount,
        mintedAt: block.timestamp
    });

    beneficialOwner[tokenId] = recipient;
    tokenByMessageHash[cctpMessageHash] = tokenId;

    emit Minted(tokenId, recipient, inboundToken, inboundAmount, cctpMessageHash);
}
```

**Notes:**
- `inboundToken` is whichever CCTP-supported token was burned on the source chain. The contract makes no assumption about what this is.
- `mintedAt` is a proxy for attestation progress. Estimated ready at `mintedAt + 17 minutes` but this varies with source chain block times. Expose this to frontends as an estimate only.
- `tokenByMessageHash` is critical — `settle()` uses this to look up which NFT to pay out when the attestation arrives.

---

### `list(tokenId, reservePrice, paymentToken)`

**Called by:** Current beneficial owner.

**What it does:** Activates a listing. The seller specifies a minimum price and which token they want to receive. The NFT stays in the contract — only the listing record is created.

```solidity
function list(
    uint256 tokenId,
    uint256 reservePrice,
    address paymentToken
) external {
    require(beneficialOwner[tokenId] == msg.sender, "not beneficial owner");
    require(!listings[tokenId].active, "already listed");
    require(reservePrice > 0, "invalid price");
    require(paymentToken != address(0), "invalid token");

    listings[tokenId] = Listing({
        reservePrice: reservePrice,
        paymentToken: paymentToken,
        active: true
    });

    emit Listed(tokenId, reservePrice, paymentToken, block.timestamp);
}
```

**Notes:**
- `paymentToken` is entirely up to the seller — it does not have to be related to `inboundToken`. A seller receiving USDC could list asking for EURC, ETH, or anything else liquid on Arc.
- `reservePrice` is denominated in the decimals of `paymentToken`.
- Relayers who don't hold or can't price `paymentToken` will simply ignore the listing. Liquidity naturally concentrates around common payment tokens.
- To update price or payment token: call `delist()` then `list()` with new parameters. On Arc with sub-second finality this is effectively atomic.

---

### `delist(tokenId)`

**Called by:** Current beneficial owner.

**What it does:** Removes the listing. The NFT remains in the contract, beneficial ownership is unchanged.

```solidity
function delist(uint256 tokenId) external {
    require(beneficialOwner[tokenId] == msg.sender, "not beneficial owner");
    require(listings[tokenId].active, "not listed");

    delete listings[tokenId];

    emit Delisted(tokenId);
}
```

---

### `fill(tokenId)`

**Called by:** Relayer (any address).

**What it does:** Atomic swap. Relayer sends `paymentToken` at `reservePrice` to the seller. `beneficialOwner` updates to the Relayer. Relayer will receive `inboundToken` at face value when `settle()` is called.

```solidity
function fill(uint256 tokenId) external {
    Listing memory listing = listings[tokenId];
    require(listing.active, "not listed");

    address seller = beneficialOwner[tokenId];

    // state changes before transfers (reentrancy safety)
    delete listings[tokenId];
    beneficialOwner[tokenId] = msg.sender;

    IERC20(listing.paymentToken).transferFrom(msg.sender, seller, listing.reservePrice);

    emit Filled(tokenId, msg.sender, seller, listing.paymentToken, listing.reservePrice);
}
```

**Notes:**
- Relayer must have approved this contract to spend at least `reservePrice` of `listing.paymentToken` before calling.
- State changes happen before token transfers — important for reentrancy safety.
- After fill, the Relayer is the beneficial owner. If they want to relist into the secondary market, they call `list()` themselves.

---

### `settle(cctpMessageHash)`

**Called by:** Anyone (permissionless). Typically called by a keeper or the Relayer themselves once they detect the Circle attestation has completed.

**What it does:** Pays out `inboundToken` at face value to whoever is currently the beneficial owner, burns the NFT.

```solidity
function settle(bytes32 cctpMessageHash) external {
    uint256 tokenId = tokenByMessageHash[cctpMessageHash];
    require(tokenId != 0, "unknown transfer");

    address recipient = beneficialOwner[tokenId];
    address token = nftData[tokenId].inboundToken;
    uint256 amount = nftData[tokenId].inboundAmount;

    // clean up all state before transfer
    delete beneficialOwner[tokenId];
    delete nftData[tokenId];
    delete listings[tokenId];       // handles edge case: attestation arrives while NFT is listed
    delete tokenByMessageHash[cctpMessageHash];
    _burn(tokenId);

    IERC20(token).transfer(recipient, amount);

    emit Settled(tokenId, recipient, token, amount);
}
```

**Notes:**
- `delete listings[tokenId]` is intentional even if no listing exists — handles the race condition where attestation arrives while the NFT is listed but unfilled. The listing becomes moot; beneficial owner gets `inboundToken` regardless.
- `settle()` is completely indifferent to marketplace history. It only reads `beneficialOwner` — whoever is in that mapping gets paid.
- The contract must hold sufficient `inboundToken` to pay out. The integration with CCTP's `receiveMessage()` flow should route minted tokens to this contract's address.

---

## Events

```solidity
event Minted(uint256 indexed tokenId, address indexed recipient, address inboundToken, uint256 inboundAmount, bytes32 cctpMessageHash);
event Listed(uint256 indexed tokenId, uint256 reservePrice, address paymentToken, uint256 listedAt);
event Delisted(uint256 indexed tokenId);
event Filled(uint256 indexed tokenId, address indexed relayer, address indexed seller, address paymentToken, uint256 amount);
event Settled(uint256 indexed tokenId, address indexed recipient, address inboundToken, uint256 amount);
```

---

## Edge Cases to Handle

**Attestation arrives while NFT is listed, unfilled**
Covered. `settle()` deletes the listing and pays `beneficialOwner` (the original seller). Any Relayer considering filling will find the listing gone.

**Attestation arrives before seller lists**
Covered. `settle()` pays `beneficialOwner` which is still the original recipient. No listing ever existed.

**Relayer calls `fill()` in same block as `settle()`**
If `settle()` lands first: NFT is burned, `fill()` reverts on `listing.active` check (listing was deleted). Seller gets inbound tokens.
If `fill()` lands first: `beneficialOwner` is now the Relayer, `settle()` pays the Relayer. Payment token has already gone to seller. Both parties get what they expected.

**Seller calls `delist()` while a Relayer's fill tx is in flight**
If `delist()` lands first: `fill()` reverts on `listing.active` check. Relayer's tx fails cleanly, no funds moved.
If `fill()` lands first: completes normally. `delist()` tx will revert (listing already gone).

---

## Relayer Integration Notes

Relayer bots should:

1. Watch for `Listed` events
2. For each listing, check if `paymentToken` is a token they hold and can price
3. Fetch `nftData` for the token: read `inboundToken` and `inboundAmount`
4. Compute: `fairValue = inboundAmount * currentRate(inboundToken → paymentToken)`
5. Compute required spread based on `block.timestamp - mintedAt` (time elapsed = less risk remaining)
6. When `fairValue - requiredSpread >= listing.reservePrice`: call `fill(tokenId)`
7. Watch for `Settled` events to confirm payout

The contract deliberately contains no pricing logic. All risk modelling lives in the Relayer.

---

## What Is Not In Scope (V1)

- **Active bidding**: Relayers posting competing bids for the seller to accept. Possible V2 extension — `acceptBid()` can be added without changing existing functions.
- **Secondary market relisting**: Technically possible with existing functions (Relayer calls `list()` after `fill()`), but no frontend support planned for V1.
- **LP pool fallback**: For transfers Relayers decline to fill. The seller's only option in V1 is to hold to maturity.