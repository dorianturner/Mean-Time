# Frontend

React application for the MeanTime marketplace. Users send USDC from Sepolia via Circle's CCTP and trade the resulting receivable NFTs on Arc.

---

## Table of Contents

- [Tech Stack](#tech-stack)
- [Getting Started](#getting-started)
- [Project Structure](#project-structure)
- [Key Design Choices](#key-design-choices)
- [Components](#components)
- [Hooks](#hooks)
- [Circle Integration (Frontend)](#circle-integration-frontend)
- [Two-Network UX](#two-network-ux)
- [Environment](#environment)

---

## Tech Stack

- **Framework:** React 19 + TypeScript
- **Build:** Vite 7
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

**SSE for real-time updates.** The backend pushes receivable state changes over a Server-Sent Events stream. `useReceivables.ts` subscribes and maintains a local map. No polling from the frontend — updates are instant.

**Two networks.** The Send tab requires Sepolia (to burn USDC via Circle CCTP). The Marketplace tab requires Arc (to list/fill NFTs). `useWallet` handles network detection and offers one-click switching for each action.

**Minimal dependencies.** Only React, ReactDOM, and viem. No state management library, no CSS framework, no wallet kit.

---

## Components

### `SendPanel.tsx`

The main user action: send USDC from Sepolia to Arc via Circle's CCTP v2.

**Flow (Circle CCTP integration):**
1. Check wallet is on Sepolia (chain ID 11155111). If not, prompt to switch.
2. User enters: Arc recipient address, USDC amount.
3. Call `approve()` on Sepolia USDC (`0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`) for Circle's `TokenMessenger` (`0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`).
4. Call `depositForBurn()` on `TokenMessenger` with:
   - `amount` — USDC in 6-decimal format
   - `destinationDomain = 26` (Arc)
   - `mintRecipient` — MeanTime contract address (padded to bytes32)
   - `burnToken` — Sepolia USDC address
5. Wait for Sepolia transaction confirmation.
6. POST `/api/bridge/initiate-cctp` with `{ txHash, recipient }` to register the burn with the backend.
7. The NFT appears in the Marketplace within ~30 seconds (via SSE).

### `Marketplace.tsx`

Shows all active receivables from the SSE stream. For each receivable:
- Shows face value, token, age, estimated time remaining, attestation progress.
- If you are the beneficial owner: **List** button (with price/token inputs) and **Delist** button.
- If it is listed by another user: **Fill** button (approves payment token ERC-20 first, then fills).

All marketplace transactions happen on Arc (chain ID 5042002) and use the MeanTime contract's `list()`, `delist()`, and `fill()` functions.

### `ConnectButton.tsx`

Compact component: shows connected address (truncated) or a Connect button. Integrates with `useWallet` hook.

### `BridgePanel.tsx`

Developer debug panel. Bypasses real CCTP to test the backend directly (manual mint/settle). Not shown in the main UI by default.

---

## Hooks

### `useWallet`

Wraps MetaMask (`window.ethereum`) and exposes:
- `address` — Current account (lowercase hex)
- `chainId` — Current chain as a number
- `connect()` — Prompts MetaMask account picker
- `disconnect()` — Clears local state
- `switchNetwork(chainId)` — Calls `wallet_switchEthereumChain`, auto-adds Arc testnet if needed

Arc testnet parameters (auto-added on first switch):
- Chain ID: `5042002` (hex: `0x4cef52`)
- RPC: `https://rpc.testnet.arc.network`
- Currency: ARC

### `useReceivables`

Connects to `GET /api/sse` and maintains a live map of receivables. Reconnects automatically on disconnect. Exposes `receivables` (array), `connected` (boolean), and `updateReceivable()`.

### `useContractActions`

Encodes `list()`, `delist()`, and `fill()` calls using viem's `encodeFunctionData` and sends them via `eth_sendTransaction`. Handles the ERC-20 `approve()` step before `fill()`.

### `useTokenSymbols`

Caches token address → symbol lookups (e.g., `0x...` → `USDC`). Used to display human-readable token names in the marketplace.

---

## Circle Integration (Frontend)

The frontend directly interacts with Circle's CCTP v2 contracts on Sepolia:

| Action | Contract | Function |
|---|---|---|
| Approve USDC spend | Sepolia USDC (`0x1c7D...7238`) | `approve(tokenMessenger, amount)` |
| Burn USDC for cross-chain transfer | TokenMessenger (`0x8FE6...2DAA`) | `depositForBurn(amount, 26, mintRecipient, burnToken)` |

The frontend does **not** interact with Circle's attestation API or `receiveMessage()` — those are handled entirely by the backend.

---

## Two-Network UX

| Tab | Required Network | Chain ID | What Happens |
|---|---|---|---|
| **Send** | Ethereum Sepolia | 11155111 | User burns USDC via Circle CCTP `depositForBurn()` |
| **Marketplace** | Arc Testnet | 5042002 | User lists/fills NFTs on Arc via MeanTime contract |

The app detects the current network and shows a **Switch Network** button when the user is on the wrong chain for the current tab. Arc testnet is auto-added to MetaMask if not already configured.

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

Additional optional environment variables:
- `VITE_MEANTIME_ADDR` — Override MeanTime contract address
- `VITE_USDC_ADDR` — Override USDC address on Arc
- `VITE_EURC_ADDR` — Override EURC address on Arc
