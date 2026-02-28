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

export interface AppCtx {
  publicClient: PublicClient
  walletClient: WalletClient
  account:      Account
  addresses:    Addresses
}

export function buildCtx(): AppCtx {
  const rpcUrl     = process.env.ARC_RPC_URL
  const privateKey = process.env.PRIVATE_KEY

  if (!rpcUrl)     throw new Error('ARC_RPC_URL not set')
  if (!privateKey) throw new Error('PRIVATE_KEY not set')

  const arc: Chain = {
    id:   33111,
    name: 'Arc Testnet',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  }

  const transport = http(rpcUrl)
  const pk = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`
  const account   = privateKeyToAccount(pk as `0x${string}`)

  return {
    publicClient: createPublicClient({ chain: arc, transport }),
    walletClient: createWalletClient({ chain: arc, transport, account }),
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
