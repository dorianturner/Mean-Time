# Frontend

React application for the MeanTime marketplace. Users send USDC from Sepolia via CCTP and trade the resulting receivable NFTs on Arc.

---

## Tech Stack

- **Framework:** React 19 + TypeScript
- **Build:** Vite
- **Blockchain:** viem (raw JSON-RPC, no wagmi or RainbowKit)
- **Wallet:** MetaMask via `window.ethereum`

---

## Getting Started

```bash
cd frontend
npm install
npm run dev     # starts Vite dev server on :5173
```

The backend must be running on `:3001`. Set `VITE_API_BASE` if your backend is elsewhere.

```bash
npm run build   # production build to dist/
npm run lint    # ESLint check
```

---

## Project Structure

```
src/
  App.tsx                 Root component: tabs, header, wallet state
  App.css                 Global design system (light theme, Barlow fonts)
  index.css               Reset
  config.ts               API_BASE URL configuration
  abi.ts                  Minimal ABI exports for contract interaction
  types.ts                TypeScript types (Receivable, Listing, etc.)

  components/
    ConnectButton.tsx     MetaMask connect/disconnect
    SendPanel.tsx         Send USDC from Sepolia via CCTP (the main action)
    Marketplace.tsx       List, delist, and fill receivable NFTs
    BridgePanel.tsx       Debug panel for manual mint/settle (dev only)

  hooks/
    useWallet.ts          MetaMask: address, chainId, connect, switchNetwork
    useReceivables.ts     SSE subscriber: maintains live receivable state
    useTokenSymbols.ts    Caches token address to symbol lookups
    useContractActions.ts Encodes and sends list/delist/fill transactions
```

---

## Key Design Choices

**No wagmi or RainbowKit.** All blockchain interaction is raw `eth_sendTransaction` and `eth_call` via `window.ethereum`. This reduces bundle size and eliminates dependency churn. ABI encoding is done via viem's `encodeFunctionData`.

**SSE for real-time updates.** The backend pushes receivable state changes over a Server-Sent Events stream. `useReceivables.ts` subscribes and maintains a local map. No polling from the frontend.

**Two networks.** The Send tab requires Sepolia (to burn USDC). The Marketplace tab requires Arc (to list/fill). `useWallet` handles network detection and offers one-click switching for each action.

---

## Components

### `SendPanel.tsx`

The main user action: send USDC from Sepolia to Arc via Circle CCTP v1.

Flow:
1. Check wallet is on Sepolia. If not, prompt to switch.
2. User enters: Arc recipient address, USDC amount.
3. Approve `TokenMessenger` to spend USDC.
4. Call `depositForBurn()` with `destDomain=26` (Arc), `mintRecipient=MeanTime`.
5. Wait for Sepolia confirmation.
6. POST `/api/bridge/initiate-cctp` with txHash and recipient.
7. The NFT appears in Marketplace within about 30 seconds.

### `Marketplace.tsx`

Shows all active receivables from the SSE stream. For each receivable:
- Shows face value, age, estimated time remaining.
- If you are the beneficial owner: List button (with price/token inputs) and Delist button.
- If it is listed: Fill button (approves payment token first, then fills).

### `ConnectButton.tsx`

Compact component: shows connected address or a Connect button. Integrates with `useWallet`.

### `BridgePanel.tsx`

Developer debug panel. Bypasses real CCTP to test the backend directly. Not shown in the main UI by default.

---

## Hooks

### `useWallet`

Wraps MetaMask and exposes:
- `address`: current account (lowercase hex)
- `chainId`: current chain as a number
- `connect()`: prompts account picker
- `disconnect()`: clears local state (MetaMask does not support programmatic disconnect)
- `switchNetwork(chainId)`: calls `wallet_switchEthereumChain`, adds Arc testnet automatically if needed

Arc testnet parameters used when adding the network:
- Chain ID: `5042002` (hex: `0x4cef52`)
- RPC: `https://rpc.testnet.arc.network`
- Currency: ARC

### `useReceivables`

Connects to `GET /api/sse` and maintains a live map of receivables. Reconnects on disconnect. Exposes `snapshot()`, `get()`, `patch()`, and `remove()`.

### `useContractActions`

Encodes `list()`, `delist()`, and `fill()` calls using viem's `encodeFunctionData` and sends them via `eth_sendTransaction`. Handles the ERC-20 approve step before `fill()`.

---

## Environment

The backend URL is configured in `src/config.ts`:

```ts
export const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001';
```

To point the frontend at a remote backend:

```bash
VITE_API_BASE=https://your-backend.example.com npm run build
```
