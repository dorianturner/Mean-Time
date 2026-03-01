# MeanTime – Implementation Plan

## Goal
Fix the app so users can:
1. Connect/disconnect MetaMask
2. Send USDC from Sepolia → Arc via real CCTP v1 (slow transfer, ~14 min attestation)
3. See the resulting receivable NFT appear in the global marketplace
4. List their receivable at a custom price
5. Other connected wallets can buy (fill) listed receivables

---

## Current State

### What works
- Backend: SSE stream, receivables API, `/api/bridge/mint` and `/api/bridge/settle` (manual bridge simulator)
- Frontend: Marketplace (list/delist/fill) via MetaMask raw tx encoding
- Contract: `MeanTime.sol` is correct and deployed on Arc

### What's broken
1. **SendPanel.tsx** calls `deposit(address,uint256,address)` on MeanTime — that function doesn't exist. Always fails.
2. **No disconnect button** — once connected, no way to disconnect
3. **App.tsx** uses `BridgePanel` (manual debug tool), not `SendPanel`
4. **No Sepolia CCTP integration** — backend only watches Arc events, not Sepolia burns

---

## Architecture

### Real CCTP v1 Flow

```
User (Sepolia) --depositForBurn--> Sepolia TokenMessenger
   Burns USDC on Sepolia, emits MessageSent(message bytes)
        |
        v
Backend Sepolia Watcher detects MessageSent
   Extracts: message bytes, amount, recipient, nonce
   Computes: messageHash = keccak256(message)
        |
        v [optimistic mint, immediate]
Backend calls MeanTime.mint(messageHash, arcUsdc, amount, recipient) on Arc
   NFT appears in marketplace immediately
        |
        v [~14 min later]
Backend polls Circle attestation API:
   GET https://iris-api-sandbox.circle.com/attestations/{messageHash}
   When status = "complete", get attestation bytes
        |
        v
Backend calls Arc MessageTransmitter.receiveMessage(message, attestation)
   Real USDC minted to MeanTime contract on Arc
Backend calls MeanTime.settle(messageHash)
   USDC transferred to beneficial owner (or current NFT holder)
```

### CCTP Addresses

**Sepolia (source)**:
- USDC: `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`
- TokenMessenger: `0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5`
- MessageTransmitter: `0x7865fAfC2db2093669d92c0197e5d6428A5B16B9`
- Domain: 0

**Arc testnet (destination)**:
- Domain: 7
- CCTP contracts: stored in `.env` as `ARC_MESSAGE_TRANSMITTER`, `ARC_USDC` (fill after first test)
- Chain ID: 33111

### Fallback (if Arc CCTP infra not available)
Backend mints MockERC20 (USDC from deployments.json) to MeanTime, then calls settle.
NFT `inboundToken` = MockERC20 address. Works for demo.

---

## Changes

### Backend

#### 1. `ctx.ts`
- Add Sepolia public client (`createPublicClient` on Sepolia chain)
- Add Arc CCTP addresses from env: `ARC_MESSAGE_TRANSMITTER`, `ARC_USDC`
- Add Sepolia CCTP addresses as constants

#### 2. `sepoliaWatcher.ts` (new)
- Watch Sepolia `MessageTransmitter` for `MessageSent(bytes message)` events
- Filter for messages where `destinationDomain == 7` (Arc) and `mintRecipient == MeanTime`
- On match: call `ctx.walletClient.writeContract(MeanTime.mint(...))`
- Start attestation polling for each detected message

#### 3. `attestationPoller.ts` (new)
- `pollAttestation(messageHash, messageBytes)`
- Polls `https://iris-api-sandbox.circle.com/attestations/{messageHash}` every 30s
- On `status=complete`: calls Arc `MessageTransmitter.receiveMessage()` (if available) then `MeanTime.settle()`
- Fallback: mint MockERC20 to MeanTime + settle

#### 4. `routes/bridge.ts`
- Add `POST /api/bridge/initiate-cctp` — frontend sends Sepolia tx hash, backend extracts CCTP message and kicks off tracking

#### 5. `index.ts`
- Start Sepolia watcher after backfill

### Frontend

#### 1. `useWallet.ts`
- Add `disconnect()` — clears address state, calls `wallet_revokePermissions` (MetaMask) or just clears local state
- Add `switchNetwork(chainId)` — calls `wallet_switchEthereumChain`
- Return `chainId` so components can check current network

#### 2. `ConnectButton.tsx`
- When connected: show address chip + "Disconnect" button

#### 3. `SendPanel.tsx` (rewrite)
- Step 1: Ensure wallet is on Sepolia (show "Switch to Sepolia" button if wrong network)
- Step 2: Enter recipient (Arc address) + amount
- Step 3: `Approve Sepolia USDC` → `depositForBurn` on Sepolia TokenMessenger
  - `mintRecipient` = MeanTime address padded to bytes32
  - `destinationDomain` = 7
  - `destinationCaller` = 0 (anyone can relay)
- Step 4: After tx: call `POST /api/bridge/initiate-cctp { txHash }` → backend handles the rest
- Show pending status with estimated time

#### 4. `App.tsx`
- Replace "Bridge Simulator" tab with "Send" tab using `SendPanel`
- Pass `disconnect` from `useWallet` to `ConnectButton`

---

## Order of Implementation

1. `useWallet.ts` — add disconnect + network switch (low risk, isolated)
2. `ConnectButton.tsx` — add disconnect button
3. `App.tsx` — integrate SendPanel, pass disconnect
4. `SendPanel.tsx` — real Sepolia CCTP burn
5. Backend `ctx.ts` — add Sepolia client
6. Backend `sepoliaWatcher.ts` — watch Sepolia MessageTransmitter
7. Backend `attestationPoller.ts` — Circle API + settle
8. Backend `bridge.ts` — add initiate-cctp endpoint
9. Backend `index.ts` — wire up Sepolia watcher
10. Test end-to-end

---

## Testing Checklist
- [ ] Connect wallet (MetaMask)
- [ ] Disconnect wallet
- [ ] Switch network to Sepolia in-app
- [ ] Send USDC from Sepolia → Arc (initiates CCTP, burns real Sepolia USDC)
- [ ] NFT appears in marketplace within a few seconds of backend detecting burn
- [ ] List NFT at a price
- [ ] Another wallet fills the listing
- [ ] After ~14 min: settlement happens, USDC reaches beneficial owner
