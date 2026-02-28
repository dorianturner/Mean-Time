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

export interface Addresses {
  meantime: `0x${string}`
  usdc:     `0x${string}`
  eurc:     `0x${string}`
  bridge:   `0x${string}`
}

// Sepolia CCTP v1 contracts (Circle official)
export const SEPOLIA_CCTP = {
  tokenMessenger:     '0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5' as `0x${string}`,
  messageTransmitter: '0x7865fAfC2db2093669d92c0197e5d6428A5B16B9' as `0x${string}`,
  usdc:               '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' as `0x${string}`,
  domain:             0,
}

// Arc testnet CCTP (domain 7 — Circle's own chain)
export const ARC_CCTP = {
  // Fill these after querying Arc for Circle's deployed contracts.
  // Until confirmed, leave empty and use the mock-settle fallback.
  messageTransmitter: (process.env.ARC_MESSAGE_TRANSMITTER ?? '') as `0x${string}`,
  usdc:               (process.env.ARC_USDC ?? '') as `0x${string}`,
  domain:             7,
}

export interface AppCtx {
  publicClient:        PublicClient   // Arc
  sepoliaClient:       PublicClient   // Sepolia (watches for CCTP burns)
  walletClient:        WalletClient   // Arc (signs mint/settle txs)
  account:             Account
  addresses:           Addresses
}

export function buildCtx(): AppCtx {
  const rpcUrl     = process.env.ARC_RPC_URL
  const privateKey = process.env.PRIVATE_KEY
  const sepoliaRpc = process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com'

  if (!rpcUrl)     throw new Error('ARC_RPC_URL not set')
  if (!privateKey) throw new Error('PRIVATE_KEY not set')

  const arc: Chain = {
    id:   33111,
    name: 'Arc Testnet',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  }

  const sepolia: Chain = {
    id:   11155111,
    name: 'Sepolia',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [sepoliaRpc] } },
  }

  const account = privateKeyToAccount(privateKey as `0x${string}`)

  return {
    publicClient:  createPublicClient({ chain: arc,     transport: http(rpcUrl) }),
    sepoliaClient: createPublicClient({ chain: sepolia, transport: http(sepoliaRpc) }),
    walletClient:  createWalletClient({ chain: arc,     transport: http(rpcUrl), account }),
    account,
    addresses:     loadAddresses(),
  }
}

function loadAddresses(): Addresses {
  if (process.env.DEPLOYMENTS_JSON) {
    return JSON.parse(process.env.DEPLOYMENTS_JSON) as Addresses
  }

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
