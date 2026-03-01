# MeanTime

Tokenised CCTP receivables. Every cross-chain USDC transfer becomes a tradeable on-chain asset during the ~17-minute attestation window.

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

For contract development, deployment, and testing see [contracts/README.md](contracts/README.md).
For backend internals see [backend/README.md](backend/README.md).
For frontend internals see [frontend/README.md](frontend/README.md).

---

## What It Does

When USDC is bridged from Ethereum to Arc via CCTP Standard Transfer, Circle requires 65 block confirmations before releasing funds on the destination chain. That takes 15-19 minutes. During that window the receiver has no money and no position.

MeanTime mints an ERC-721 NFT the moment the source-chain burn is detected. That NFT represents the incoming USDC, and it can be traded immediately.

```
Ethereum: user burns USDC via CCTP
          |
Arc:      MeanTime mints NFT (face value = inbound USDC)
          |
          +--- receiver holds NFT --- waits ~17 min --- redeems full USDC
          |
          +--- receiver lists NFT at a price in ARC (native token)
                    |
                    relayer fills: receiver gets ARC instantly (< 1s on Arc)
                    |
                    Circle attestation arrives: relayer gets the full USDC
```

The relayer earns the spread. The receiver gets immediate liquidity. Settlement is automatic and permissionless.

---

## The Economics

The spread a seller pays reflects two things:

**FX risk.** Holding a USDC receivable means holding an open position for up to 17 minutes. If USDC/EURC moves, the relayer absorbs the loss. This component has a natural floor set by volatility and cannot be competed to zero.

**Liquidity premium.** Advancing EURC against an asset that won't arrive for 17 minutes has a cost. With competition among relayers this component compresses toward the true risk floor.

In calm markets the spread is very tight. In volatile conditions relayers stop filling, which is the correct response. No circuit breakers or oracles are needed.

---

## Why Arc

- USDC and EURC are both natively issued by Circle on Arc. The protocol needs a credible market for both.
- Sub-second finality means fills settle in under a second after a transaction lands.
- CCTP is foundational on Arc, not an afterthought.
- StableFX provides institutional-grade USDC/EURC swap infrastructure for relayer hedging.

---

## What Is Novel

A tokenised CCTP receivable does not exist elsewhere. The marketplace is one application built on top of it. Any future protocol that wants to lend against, hedge, or route pending CCTP flows can use the same NFT infrastructure.

---

## License

MIT
