# MeanTime – Development Journal

## Session 1 — 2026-02-28

### Context
Starting from a broken SendPanel (calls non-existent `deposit()` on MeanTime contract) and a mostly-working marketplace. Goal: wire up real CCTP v1 for the send flow, add disconnect button, fix the full lifecycle.

### Architecture decisions
- Arc is Circle's own chain (domain 7 for CCTP). Backend acts as optimistic bridge.
- For settlement: try real Arc MessageTransmitter first; fall back to minting MockERC20 to MeanTime.
- `inboundToken` in NFT = Arc's native USDC (or MockERC20 fallback). Determined at runtime.
- Sepolia CCTP contracts: TokenMessenger `0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5`, MessageTransmitter `0x7865fAfC2db2093669d92c0197e5d6428A5B16B9`, USDC `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`

### Changes made

**Frontend**:
- `useWallet.ts` — added `chainId`, `disconnect()`, `switchNetwork(chainId)`. Listens to `chainChanged` event. `wallet_addEthereumChain` for Arc (33111) on first switch.
- `ConnectButton.tsx` — added disconnect button; shows `.wallet-connected` wrapper with address + "Disconnect"
- `SendPanel.tsx` — full rewrite: real Sepolia CCTP v1 flow (`approve` + `depositForBurn`), network gate (switch to Sepolia first), calls `/api/bridge/initiate-cctp` after burn. `mintRecipient` = MeanTime contract, `destinationDomain` = 7.
- `App.tsx` — replaced "Bridge Simulator" tab with "Send" tab using `SendPanel`. Passes `disconnect` to `ConnectButton`. Updated MEANTIME_ADDR default from env.
- `App.css` — added CSS for `.wallet-connected`, `.disconnect-btn`, `.send-panel`, `.network-prompt`, `.status-box.warn/.err/.ok`, `.hint.small`, `.row`

**Backend**:
- `ctx.ts` — added `sepoliaClient` (PublicClient on Sepolia chain), `SEPOLIA_CCTP` and `ARC_CCTP` constants. Uses `SEPOLIA_RPC_URL` env var (defaults to publicNode free RPC). `ARC_CCTP.usdc` and `ARC_CCTP.messageTransmitter` read from optional env vars.
- `sepoliaWatcher.ts` (new) — polls Sepolia `MessageTransmitter` every 30s via `getLogs` (avoids filter-not-found errors on public RPCs). Filters for Arc-bound burns with MeanTime as mintRecipient. Extracts `messageSender` from CCTP message body as beneficial owner. Calls `mintOnArc()` immediately. `trackSepoliaTx()` for frontend-initiated flows.
- `attestationPoller.ts` (new) — polls `iris-api-sandbox.circle.com` every 30s. On `complete`: tries Arc `MessageTransmitter.receiveMessage()` if configured, falls back to `MockERC20.mint()` + `MeanTime.settle()`.
- `routes/bridge.ts` — `POST /api/bridge/initiate-cctp` endpoint added. Also updated signature to accept `store`.
- `abi.ts` — added `tokenByMessageHash` and `getReceivable` to MEANTIME_ABI.
- `app.ts` — pass `store` to `buildBridgeRouter`.
- `index.ts` — start Sepolia watcher alongside Arc watcher. Backfill failure is graceful (continues without history if rate-limited).

### Known issues / to investigate
- **Arc RPC rate-limited**: `https://rpc.testnet.arc.network` proxied via QuickNode, daily request limit hit during dev. Resets in ~4 hours. All contract calls are correctly formed (verified from error detail in response). **Workaround**: wait for reset, or set a different `ARC_RPC_URL` in `.env` if another endpoint is available.
- **Arc CCTP contracts unknown**: `ARC_MESSAGE_TRANSMITTER` and `ARC_USDC` not set in `.env`. Fallback = MockERC20 settle (works for demo).
- Sepolia RPC (`publicnode.com`) doesn't support `eth_newFilter` → switched to `getLogs` polling (works fine).

### What to test next (when Arc RPC recovers)
1. `POST /api/bridge/mint` — should write an NFT to MeanTime, appear via SSE in frontend
2. `GET /api/receivables` — should return the new NFT
3. List/fill flow in the Marketplace (connect two wallets)
4. Real CCTP: send Sepolia USDC → depositForBurn → backend detects → NFT appears
5. Disconnect button in UI

---
