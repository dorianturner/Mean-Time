# InstantSettle

> Tokenised CCTP receivables which turn every cross-chain USDC transfer into a tradeable on-chain asset.

---

## The Problem

When USDC moves from Ethereum to Arc via CCTP Standard Transfer, the burn-and-mint process takes **15–19 minutes** (65 Ethereum block confirmations). During that window:

- The USDC is gone from Ethereum but hasn't arrived on Arc yet.
- The receiver has no money and no position, they are just waiting.
- The USDC/EURC exchange rate can move against them with no recourse.

This dead time is a structural inefficiency. InstantSettle eliminates it.

---

## The Solution

Every CCTP transfer registered with InstantSettle mints an **NFT representing the incoming USDC receivable**; a tokenised, tradeable claim on the USDC that will arrive when Circle's attestation completes.

The receiver holds this NFT by default and has two options:

| Option | Outcome | Cost |
|---|---|---|
| **Hold to maturity** | Wait ~15 min, redeem for the full USDC amount | Zero |
| **Sell instantly** | List in EURC, a Relayer buys it, receiver gets paid in seconds | Small spread |

When the CCTP attestation arrives and USDC is minted, the contract checks who currently owns the NFT and pays them. The NFT is burned. Settlement is **automatic and atomic**.

---

## How It Works

```
Ethereum: User burns USDC via CCTP
         │
         ▼
Arc: InstantSettle mints NFT (the receivable)
         │
         ├─── Receiver holds NFT ──► waits 15 min ──► redeems full USDC
         │
         └─── Receiver lists NFT at EURC price
                    │
                    ▼
              Relayer fills order — receiver gets EURC instantly (< 500ms)
                    │
                    ▼
              Circle attestation arrives — contract mints USDC to NFT holder (Relayer)
```

The NFT can change hands multiple times during the 15-minute window. A Relayer who buys it can relist it. A natural secondary market in cross-chain settlement claims emerges.

---

## The Economics

The spread a receiver pays reflects two distinct services the Relayer provides:

**FX risk transfer**: absorbing the receiver's involuntary open USDC/EURC position for 15 minutes. This has an irreducible floor set by volatility; it cannot be competed to zero.

**Liquidity**: advancing EURC against an asset that won't arrive for 15 minutes. This component compresses toward the price of the attestation risk with Relayer competition .

In calm markets the spread is very tight. During macro events Relayers stop filling; which is the correct response, requiring no circuit breaker or oracle.

### Why Relayers, Not an LP Pool

A passive LP pool suffers from **adverse selection**; it gets busiest when FX risk is highest, with no ability to decline individual fills. Relayers are professional market participants who make an active fill decision on each order. They can hedge externally, decline in volatile conditions, and compete to drive spreads to the true risk floor. An LP pool exists only as a backstop for transfers Relayers decline.

### The Factoring Parallel

InstantSettle is economically identical to **invoice factoring**. The receiver has a receivable (incoming USDC). They sell it at a small discount to a factor (Relayer) for immediate liquidity. The factor waits for payment and earns the discount. The NFT is the tokenised invoice.

---

## Why Arc Wants This

Arc is the only chain where this protocol makes sense, and the protocol is a direct investment in Arc's own health as an ecosystem.

### 1. More Accurate Token Prices

The 15-minute CCTP settlement gap creates **stale price conditions**. Large USDC inflows are invisible to Arc's markets until they land — then they arrive as a lump, causing spreads to widen and prices to lurch. InstantSettle changes this: the moment a transfer is registered, a tradeable NFT representing that future liquidity enters the market. Relayers immediately price it, effectively pricing the incoming USDC *before it arrives*. Arc's USDC/EURC market gets continuous price discovery rather than lumpy, delayed updates. Tighter, more accurate prices attract more sophisticated traders; which tightens prices further.

### 2. Improved Market Efficiency

Cross-chain capital currently sits idle for 15 minutes per transfer, capital that could be deployed. InstantSettle turns that dead time into active market activity. Relayers compete to fill orders. Secondary buyers trade the NFTs. Each transfer generates a cascade of on-chain interactions rather than a single mint event at the end. More active, liquid markets improve Arc's attractiveness to both retail and institutional participants, increasing total value locked and on-chain velocity.

Additionally, Relayers who operate on Arc must maintain a liquid token float to fill orders. This capital is captive to Arc for the duration of their operation; increasing the depth of Arc's on-chain liquidity even when no transfers are actively being filled.

### 3. Extra Gas Fees

Every transfer through InstantSettle generates significantly more on-chain activity than a raw CCTP transfer:

- NFT mint on registration
- Listing and order creation
- Relayer fill transaction
- Potential secondary NFT transfers if the Relayer relists
- Final settlement and NFT burn

A single USDC transfer that would otherwise produce **one** Arc transaction (the CCTP mint) instead produces **two or more**. For high-volume cross-chain flows; institutional transfers, bridge aggregators, wallets integrating InstantSettle, this multiplier compounds into meaningful sequencer fee revenue for Arc. As the protocol scales, it becomes a persistent, structural source of on-chain activity that benefits validators and the network alike.

### 4. Arc Is the Only Chain Where This Works

- **USDC and EURC are both native Circle-issued assets on Arc**: the protocol requires a credible, liquid market for these tokens, which exists nowhere else.
- **StableFX** provides institutional-grade on-chain USDC/EURC swap infrastructure for Relayers to hedge.
- **CCTP is foundational** on Arc, not bolted on.
- **Sub-second finality** means receiver tokens arrives in under 500ms after a fill.
- **KYC-compatible validators** make the failure path's legal enforceability credible for institutional participants.

---

## What's Novel

The core primitive, a **tokenised CCTP receivable**, does not exist anywhere on Arc or elsewhere. The instant settlement marketplace is one application built on top of it. Any future protocol that wants to do something with pending CCTP flows; lend against them, hedge them, route them through yield strategies, can build on the same NFT infrastructure.

InstantSettle is infrastructure, not just a product.

---

## License

MIT
