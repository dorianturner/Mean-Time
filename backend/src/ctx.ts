import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
  type Chain,
  type Account,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

<<<<<<< Updated upstream
=======
// ── Sepolia CCTP v1 contract addresses ─────────────────────────────────────
export const SEPOLIA_CCTP = {
  messageTransmitter: '0x7865fAfC2db2093669d92c0F33AeEF291086BeFD' as `0x${string}`,
  tokenMessenger:     '0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5' as `0x${string}`,
  usdc:               '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' as `0x${string}`,
}

// ── Arc CCTP constants ─────────────────────────────────────────────────────
// Arc testnet doesn't have a real CCTP deployment yet.
// messageTransmitter and usdc are empty — the attestation poller falls back
// to mock-minting USDC via the deployer key.
export const ARC_CCTP = {
  domain:             7,
  messageTransmitter: '' as `0x${string}`,
  usdc:               '' as `0x${string}`,
}

>>>>>>> Stashed changes
export interface Addresses {
  meantime: `0x${string}`
  usdc:     `0x${string}`
  eurc:     `0x${string}`
  bridge:   `0x${string}`
}

export interface AppCtx {
<<<<<<< Updated upstream
  publicClient: PublicClient
  walletClient: WalletClient
  account:      Account
  addresses:    Addresses
=======
  publicClient:  PublicClient
  walletClient:  WalletClient
  sepoliaClient: PublicClient
  account:       Account
  addresses:     Addresses
>>>>>>> Stashed changes
}

export function buildCtx(): AppCtx {
  const rpcUrl     = process.env.ARC_RPC_URL
  const privateKey = process.env.PRIVATE_KEY

  if (!rpcUrl)     throw new Error('ARC_RPC_URL not set')
  if (!privateKey) throw new Error('PRIVATE_KEY not set')

  const arc: Chain = {
    id:   5042002,
    name: 'Arc Testnet',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  }

<<<<<<< Updated upstream
  const transport = http(rpcUrl)
  const pk = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`
  const account   = privateKeyToAccount(pk as `0x${string}`)

  return {
    publicClient: createPublicClient({ chain: arc, transport }),
    walletClient: createWalletClient({ chain: arc, transport, account }),
=======
  const sepolia: Chain = {
    id:   11155111,
    name: 'Sepolia',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [process.env.SEPOLIA_RPC_URL ?? 'https://rpc.sepolia.org'] } },
  }

  const transport = http(rpcUrl)
  const account   = privateKeyToAccount(privateKey as `0x${string}`)

  return {
    publicClient:  createPublicClient({ chain: arc, transport }),
    walletClient:  createWalletClient({ chain: arc, transport, account }),
    sepoliaClient: createPublicClient({ chain: sepolia, transport: http(sepolia.rpcUrls.default.http[0]) }),
>>>>>>> Stashed changes
    account,
    addresses:    loadAddresses(),
  }
}

function loadAddresses(): Addresses {
  // Allow overriding via env (useful in tests)
  if (process.env.DEPLOYMENTS_JSON) {
    return JSON.parse(process.env.DEPLOYMENTS_JSON) as Addresses
  }

  // Walk up from src/ → backend/ → repo root to find deployments.json
  const here = dirname(fileURLToPath(import.meta.url))
  const path = join(here, '..', '..', 'deployments.json')

  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Addresses
  } catch {
    throw new Error(
      'Contract addresses not found. Set DEPLOYMENTS_JSON env var or run deploy.sh first.'
    )
  }
}
