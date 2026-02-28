# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

InstantSettle (working name: MeanTime / FastCCTP) — a protocol on Arc that turns CCTP cross-chain USDC transfers into tradeable ERC-721 receivables, enabling instant settlement during the ~14-minute CCTP attestation window.

## Setup

First-time setup (installs Foundry, dependencies, builds):
```bash
bash setup.sh
```

Dependencies are git submodules declared in `contracts/.gitmodules`: `forge-std` and `openzeppelin-contracts`. The `setup.sh` handles both `git submodule update --init` and a fallback `forge install` for OpenZeppelin if the submodule pull didn't populate it.

## Commands

All Forge commands run from the **repo root** (a root `foundry.toml` configures the project). Foundry is installed at `~/.foundry/bin/forge` — interactive terminals have this on PATH via `.bashrc`/`.zshrc`, but Claude Code's shell does not, so use the full path `~/.foundry/bin/forge` when executing commands programmatically.

```bash
forge build                                        # compile
forge build --sizes                                # compile + contract sizes (matches CI)
forge test -vvv                                    # run all tests
forge test --match-contract <ContractName> -vvv   # run one test file
forge test --match-test <testFunctionName> -vvv   # run one test
forge fmt                                          # format
forge fmt --check                                  # check formatting (matches CI)
```

Deploying to Arc testnet:

```bash
source .env
forge script contracts/scripts/DeployHello.s.sol:DeployHello --rpc-url $ARC_RPC_URL --broadcast
```

`.env` lives at the repo root and provides `ARC_RPC_URL` and `PRIVATE_KEY`.

## Architecture

The Foundry project lives entirely inside `contracts/`. The repo root holds the `.env`, setup script, and top-level README only.

### Planned contract system (defined in `contracts/README.md`, not yet implemented)

Five contracts in `contracts/src/`:

| Contract | Role |
|---|---|
| `InstantSettle.sol` | Core registry. Accepts raw CCTP message bytes, mints `ReceivableNFT` to the original receiver, handles settlement by calling Circle's `MessageTransmitter.receiveMessage()` and paying the current NFT holder. |
| `ReceivableNFT.sol` | ERC-721. Each token represents one pending USDC inbound transfer. Token metadata stores `usdcAmount`, `sourceBlockNumber`, `nonce`, `sourceDomain`. Attestation depth is **not** stored here — it is always computed live from the oracle. Only `InstantSettle` can mint or burn. |
| `AttestationOracle.sol` | Tracks the latest Ethereum block number posted by authorised reporters. Depth for any transfer = `min(latestEthBlock - sourceBlockNumber, 65)`. All depth queries are stateless. |
| `Marketplace.sol` | Order book. `fill(listingId, minDepthRequired)` gates fills by the buyer's risk appetite. Emits `depthAtFill` on every trade to build an on-chain pricing dataset. Reverts if the oracle is stale (>60s). |
| `LPPool.sol` | Passive EURC backstop that auto-fills listings when Relayers don't. Only fills above a configured minimum depth. |

A pure library `CCTPMessage.sol` handles decoding raw CCTP message bytes.

### Key protocol invariants

- `settle()` can be called by anyone; USDC always goes to the current NFT holder at settlement time.
- NFTs are freely transferable — the market depends on this.
- `register()` (Relayer-only in v1) mints the NFT speculatively before Circle's attestation is available. A fake registration cannot steal funds — it just produces an unsettleable NFT.
- Check-effects-interactions in `settle()`: burn NFT before transferring USDC.

### Current state

`contracts/src/FastCCTP.sol` and `contracts/src/Hello.sol` are stubs/hello-world. The real implementation has not been written yet. `contracts/README.md` is the authoritative design spec.

### CI

GitHub Actions (`.github/workflows/test.yml` inside `contracts/`) runs on every push: `forge fmt --check` → `forge build --sizes` → `forge test -vvv`.
