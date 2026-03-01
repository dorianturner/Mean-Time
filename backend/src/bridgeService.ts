/**
 * MeanTime Bridge Service
 *
 * Uses Circle's Bridge Kit (@circle-fin/bridge-kit) to handle the complete CCTP V2
 * cross-chain bridge flow: approve → burn → attestation → receiveMessage.
 *
 * After USDC lands in the MeanTime contract on Arc, calls mint() to create
 * the Transfer-NFT and settle() to deliver funds to the recipient.
 *
 * Architecture:
 *   - Source adapter: sender's private key (approves + burns on source chain)
 *   - Arc adapter: deployer private key (calls receiveMessage on Arc)
 *   - recipientAddress: MeanTime contract (receives the USDC)
 *   - After bridge: deployer calls MeanTime.mint() + MeanTime.settle()
 *
 * No Circle API key / entity secret required — Bridge Kit uses standard
 * private keys via @circle-fin/adapter-viem-v2, NOT developer-controlled wallets.
 *
 * Usage (CLI):
 *   npx tsx src/bridgeService.ts \
 *     --source ethereum-sepolia \
 *     --sender-key 0x… \
 *     --amount 10 \
 *     --recipient 0x…
 *
 * Usage (module):
 *   import { bridgeAndMint } from './bridgeService.js'
 *   const result = await bridgeAndMint({ sourceChain: 'ethereum-sepolia', ... })
 */

import 'dotenv/config'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { BridgeKit } from '@circle-fin/bridge-kit'
import { createViemAdapterFromPrivateKey } from '@circle-fin/adapter-viem-v2'
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  decodeEventLog,
  parseAbiItem,
  type Chain,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

// ── Arc Testnet Configuration ──────────────────────────────────────────────
const ARC_RPC_URL  = process.env.ARC_RPC_URL ?? 'https://rpc.testnet.arc.network'
const ARC_CHAIN_ID = 5042002
const ARC_USDC     = '0x3600000000000000000000000000000000000000' as `0x${string}`
// USDC on Arc is 6 decimals via ERC-20, 18 decimals as native gas — never mix.

const arcChain: Chain = {
  id:   ARC_CHAIN_ID,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [ARC_RPC_URL] } },
}

// ── Supported Source Chains ────────────────────────────────────────────────
// Maps friendly names → Bridge Kit BridgeChain identifiers + chain defs for
// receipt fetching.  All use CCTPv2 via Bridge Kit.

interface SourceChainConfig {
  /** Bridge Kit BridgeChain enum value */
  bridgeKitName: string
  /** CCTP V2 domain number (for Circle attestation API fallback) */
  cctpDomain: number
  /** Viem chain definition for on-chain receipt queries */
  chain: Chain
}

const SOURCE_CHAINS: Record<string, SourceChainConfig> = {
  'ethereum-sepolia': {
    bridgeKitName: 'Ethereum_Sepolia',
    cctpDomain: 0,
    chain: {
      id: 11155111, name: 'Ethereum Sepolia',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: ['https://rpc.sepolia.org'] } },
    },
  },
  'arbitrum-sepolia': {
    bridgeKitName: 'Arbitrum_Sepolia',
    cctpDomain: 3,
    chain: {
      id: 421614, name: 'Arbitrum Sepolia',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: ['https://sepolia-rollup.arbitrum.io/rpc'] } },
    },
  },
  'base-sepolia': {
    bridgeKitName: 'Base_Sepolia',
    cctpDomain: 6,
    chain: {
      id: 84532, name: 'Base Sepolia',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: ['https://sepolia.base.org'] } },
    },
  },
  'optimism-sepolia': {
    bridgeKitName: 'Optimism_Sepolia',
    cctpDomain: 2,
    chain: {
      id: 11155420, name: 'OP Sepolia',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: ['https://sepolia.optimism.io'] } },
    },
  },
  'avalanche-fuji': {
    bridgeKitName: 'Avalanche_Fuji',
    cctpDomain: 1,
    chain: {
      id: 43113, name: 'Avalanche Fuji',
      nativeCurrency: { name: 'AVAX', symbol: 'AVAX', decimals: 18 },
      rpcUrls: { default: { http: ['https://api.avax-test.network/ext/bc/C/rpc'] } },
    },
  },
  'polygon-amoy': {
    bridgeKitName: 'Polygon_Amoy_Testnet',
    cctpDomain: 7,
    chain: {
      id: 80002, name: 'Polygon Amoy',
      nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
      rpcUrls: { default: { http: ['https://rpc-amoy.polygon.technology'] } },
    },
  },
  'unichain-sepolia': {
    bridgeKitName: 'Unichain_Sepolia',
    cctpDomain: 10,
    chain: {
      id: 1301, name: 'Unichain Sepolia',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: ['https://sepolia.unichain.org'] } },
    },
  },
}

// ── MeanTime Contract ABI (minimal) ───────────────────────────────────────
const MEANTIME_MINT_ABI = [
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'cctpMessageHash', type: 'bytes32' },
      { name: 'inboundToken',    type: 'address' },
      { name: 'inboundAmount',   type: 'uint256' },
      { name: 'recipient',       type: 'address' },
    ],
    outputs: [{ name: 'tokenId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'settle',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'cctpMessageHash', type: 'bytes32' }],
    outputs: [],
  },
  {
    type: 'event',
    name: 'Minted',
    inputs: [
      { name: 'tokenId',         type: 'uint256', indexed: true  },
      { name: 'recipient',       type: 'address', indexed: true  },
      { name: 'inboundToken',    type: 'address', indexed: false },
      { name: 'inboundAmount',   type: 'uint256', indexed: false },
      { name: 'cctpMessageHash', type: 'bytes32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Settled',
    inputs: [
      { name: 'tokenId',      type: 'uint256', indexed: true  },
      { name: 'recipient',    type: 'address', indexed: true  },
      { name: 'inboundToken', type: 'address', indexed: false },
      { name: 'amount',       type: 'uint256', indexed: false },
    ],
  },
] as const

const MESSAGE_SENT_EVENT = parseAbiItem('event MessageSent(bytes message)')

// ── Types ──────────────────────────────────────────────────────────────────
export interface BridgeRequest {
  /** Friendly chain name, e.g. 'ethereum-sepolia', 'base-sepolia' */
  sourceChain: string
  /** Hex private key of the sender wallet on the source chain */
  senderPrivateKey: `0x${string}`
  /** Human-readable USDC amount, e.g. '10' or '10.50' */
  amount: string
  /** Arc address that becomes the NFT's beneficial owner */
  recipientAddress: `0x${string}`
}

export interface BridgeServiceResult {
  burnTxHash:      string
  cctpMessageHash: string
  tokenId:         string
  mintTxHash:      string
  settleTxHash:    string
}

// ── Helpers ────────────────────────────────────────────────────────────────

function getMeantimeAddress(): `0x${string}` {
  if (process.env.MEANTIME_ADDRESS) {
    return process.env.MEANTIME_ADDRESS as `0x${string}`
  }
  const here = dirname(fileURLToPath(import.meta.url))
  const path = join(here, '..', '..', 'deployments.json')
  try {
    const json = JSON.parse(readFileSync(path, 'utf8'))
    return json.meantime as `0x${string}`
  } catch {
    throw new Error(
      'MEANTIME_ADDRESS not set and deployments.json not found. ' +
      'Run deploy.sh or set the env var.',
    )
  }
}

/**
 * Extract the CCTP message hash from a burn transaction receipt on the source chain.
 * Finds the MessageSent(bytes message) event and returns keccak256(message).
 */
async function getMessageHashFromReceipt(
  sourceConfig: SourceChainConfig,
  burnTxHash: `0x${string}`,
): Promise<`0x${string}`> {
  const client = createPublicClient({
    chain:     sourceConfig.chain,
    transport: http(sourceConfig.chain.rpcUrls.default.http[0]),
  })

  console.log(`[bridge] Fetching receipt for burn tx ${burnTxHash} on ${sourceConfig.chain.name}…`)
  const receipt = await client.getTransactionReceipt({ hash: burnTxHash })

  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi:       [MESSAGE_SENT_EVENT],
        eventName: 'MessageSent',
        data:      log.data,
        topics:    log.topics as [`0x${string}`, ...`0x${string}`[]],
      })
      const messageBytes = (decoded.args as { message: `0x${string}` }).message
      return keccak256(messageBytes)
    } catch { /* not this log */ }
  }

  throw new Error(`No MessageSent event found in tx ${burnTxHash}`)
}

/**
 * Fallback: query Circle's attestation API V2 for the message hash.
 */
async function getMessageHashFromCircleAPI(
  sourceDomain: number,
  burnTxHash: string,
): Promise<`0x${string}`> {
  const url = `https://iris-api-sandbox.circle.com/v2/messages/${sourceDomain}?transactionHash=${burnTxHash}`
  console.log(`[bridge] Querying Circle attestation API: ${url}`)

  const res = await fetch(url)
  if (!res.ok) throw new Error(`Circle API returned ${res.status}`)

  const body = await res.json() as {
    messages?: Array<{ message?: string; messageHash?: string }>
  }
  const msg = body.messages?.[0]
  if (!msg) throw new Error('No messages found in Circle API response')

  if (msg.messageHash) return msg.messageHash as `0x${string}`
  if (msg.message)     return keccak256(msg.message as `0x${string}`)

  throw new Error('Neither messageHash nor message found in Circle API response')
}

// ── Main Bridge Function ───────────────────────────────────────────────────

/**
 * Execute a full cross-chain USDC bridge to the MeanTime contract on Arc,
 * then mint a Transfer-NFT and settle it to the recipient.
 *
 * Flow:
 *   1. Bridge Kit: approve USDC on source → burn via CCTP V2 → wait for
 *      attestation → receiveMessage on Arc (USDC minted to MeanTime)
 *   2. Extract CCTP message hash from the burn transaction
 *   3. Call MeanTime.mint() on Arc → creates Transfer-NFT for recipient
 *   4. Call MeanTime.settle() on Arc → transfers USDC to beneficial owner
 *
 * Uses SLOW (Standard) transfer speed: 0 bps protocol fee, ~14 min attestation.
 * The full amount burned arrives in MeanTime — no fee deduction.
 *
 * @param request - source chain, sender key, amount, recipient address
 * @returns burn tx hash, message hash, token ID, mint tx, settle tx
 */
export async function bridgeAndMint(request: BridgeRequest): Promise<BridgeServiceResult> {
  // ── Validate ─────────────────────────────────────────────────
  const sourceConfig = SOURCE_CHAINS[request.sourceChain]
  if (!sourceConfig) {
    throw new Error(
      `Unsupported source chain: "${request.sourceChain}". ` +
      `Supported: ${Object.keys(SOURCE_CHAINS).join(', ')}`,
    )
  }

  if (!/^0x[0-9a-fA-F]{40}$/.test(request.recipientAddress)) {
    throw new Error(`Invalid recipient address: ${request.recipientAddress}`)
  }

  const amountNum = parseFloat(request.amount)
  if (isNaN(amountNum) || amountNum <= 0) {
    throw new Error(`Invalid amount: ${request.amount}`)
  }

  const meantimeAddr = getMeantimeAddress()
  const deployerKey  = process.env.PRIVATE_KEY as `0x${string}` | undefined
  if (!deployerKey) {
    throw new Error('PRIVATE_KEY env var not set (needed for MeanTime.mint() on Arc)')
  }

  console.log(`\n${'═'.repeat(60)}`)
  console.log(`  MeanTime Bridge Service`)
  console.log(`${'═'.repeat(60)}`)
  console.log(`  Source:       ${request.sourceChain}`)
  console.log(`  Amount:       ${request.amount} USDC`)
  console.log(`  Recipient:    ${request.recipientAddress}`)
  console.log(`  MeanTime:     ${meantimeAddr}`)
  console.log(`  Transfer:     SLOW (Standard, 0 bps, ~14 min attestation)`)
  console.log(`${'═'.repeat(60)}\n`)

  // ── Step 1: Bridge via Bridge Kit ────────────────────────────
  console.log(`[bridge] Step 1/4: Initiating CCTP V2 bridge via Bridge Kit…`)
  console.log(`[bridge] This will: approve → burn on ${request.sourceChain}, then`)
  console.log(`[bridge] wait ~14 min for attestation, then receiveMessage on Arc.`)

  const kit = new BridgeKit()

  // Register progress listeners
  kit.on('*' as any, (payload: any) => {
    const method = payload?.method ?? payload?.action ?? 'unknown'
    console.log(`[bridge]   → event: ${method}`)
  })

  // Source chain adapter: sender's private key
  const sourceAdapter = createViemAdapterFromPrivateKey({
    privateKey: request.senderPrivateKey,
  })

  // Arc adapter: deployer key signs receiveMessage on Arc
  const arcAdapter = createViemAdapterFromPrivateKey({
    privateKey: deployerKey,
    getPublicClient: ({ chain }) =>
      createPublicClient({ chain, transport: http(ARC_RPC_URL) }),
  })

  const bridgeResult = await kit.bridge({
    from: {
      adapter: sourceAdapter,
      chain:   sourceConfig.bridgeKitName as any,
    },
    to: {
      adapter:          arcAdapter,
      chain:            'Arc_Testnet' as any,
      recipientAddress: meantimeAddr,
    },
    amount: request.amount,
    config: { transferSpeed: 'SLOW' },
  })

  // Log full result for debugging
  console.log(`[bridge] Bridge result state: ${bridgeResult.state}`)
  for (const step of bridgeResult.steps) {
    console.log(`[bridge]   step "${step.name}": ${step.state}${step.txHash ? ` tx=${step.txHash}` : ''}`)
  }

  if (bridgeResult.state !== 'success') {
    const failedSteps = bridgeResult.steps
      .filter(s => s.state === 'error')
      .map(s => `${s.name}: ${s.errorMessage ?? 'unknown error'}`)
    throw new Error(
      `Bridge failed.\n` +
      `  Failed steps: ${failedSteps.join('; ')}\n` +
      `  Check source chain USDC balance and gas.`,
    )
  }

  console.log(`[bridge] Bridge completed successfully!`)

  // ── Step 2: Extract CCTP message hash ────────────────────────
  console.log(`\n[bridge] Step 2/4: Extracting CCTP message hash…`)

  // Get burn tx hash from Bridge Kit result
  const burnStep = bridgeResult.steps.find(
    s => s.name.toLowerCase().includes('burn') || s.name.toLowerCase().includes('deposit'),
  )
  const burnTxHash = burnStep?.txHash

  if (!burnTxHash) {
    throw new Error(
      `Could not find burn transaction hash in bridge result.\n` +
      `Steps: ${bridgeResult.steps.map(s => `${s.name}[tx=${s.txHash}]`).join(', ')}`,
    )
  }

  console.log(`[bridge] Burn tx: ${burnTxHash}`)

  // Extract message hash: try on-chain receipt first, then Circle API fallback
  let cctpMessageHash: `0x${string}`
  try {
    cctpMessageHash = await getMessageHashFromReceipt(sourceConfig, burnTxHash as `0x${string}`)
  } catch (err) {
    console.warn(`[bridge] Receipt parsing failed: ${(err as Error).message}`)
    console.log(`[bridge] Trying Circle attestation API fallback…`)
    cctpMessageHash = await getMessageHashFromCircleAPI(
      sourceConfig.cctpDomain,
      burnTxHash,
    )
  }

  console.log(`[bridge] CCTP message hash: ${cctpMessageHash}`)

  // ── Step 3: Mint Transfer-NFT on Arc ─────────────────────────
  console.log(`\n[bridge] Step 3/4: Minting Transfer-NFT on Arc…`)

  const deployerAccount = privateKeyToAccount(deployerKey)
  const arcPublic = createPublicClient({ chain: arcChain, transport: http(ARC_RPC_URL) })
  const arcWallet = createWalletClient({
    chain:     arcChain,
    transport: http(ARC_RPC_URL),
    account:   deployerAccount,
  })

  // Amount in base units (6 decimals). SLOW transfer has 0 protocol fee
  // so the full amount arrives in MeanTime.
  const inboundAmount = BigInt(Math.round(amountNum * 1e6))

  const mintTxHash = await arcWallet.writeContract({
    address:      meantimeAddr,
    abi:          MEANTIME_MINT_ABI,
    functionName: 'mint',
    args:         [cctpMessageHash, ARC_USDC, inboundAmount, request.recipientAddress],
    chain:        arcChain,
  })

  console.log(`[bridge] Mint tx submitted: ${mintTxHash}`)
  const mintReceipt = await arcPublic.waitForTransactionReceipt({ hash: mintTxHash })

  // Extract tokenId from Minted event
  let tokenId = '0'
  for (const log of mintReceipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi:       MEANTIME_MINT_ABI,
        eventName: 'Minted',
        data:      log.data,
        topics:    log.topics as [`0x${string}`, ...`0x${string}`[]],
      })
      tokenId = ((decoded.args as any).tokenId as bigint).toString()
      break
    } catch { /* not this log */ }
  }

  console.log(`[bridge] Transfer-NFT minted! tokenId=${tokenId}`)

  // ── Step 4: Settle — transfer USDC to recipient ──────────────
  console.log(`\n[bridge] Step 4/4: Settling — transferring USDC to ${request.recipientAddress}…`)

  const settleTxHash = await arcWallet.writeContract({
    address:      meantimeAddr,
    abi:          MEANTIME_MINT_ABI,
    functionName: 'settle',
    args:         [cctpMessageHash],
    chain:        arcChain,
  })

  console.log(`[bridge] Settle tx submitted: ${settleTxHash}`)
  await arcPublic.waitForTransactionReceipt({ hash: settleTxHash })

  console.log(`\n${'═'.repeat(60)}`)
  console.log(`  Bridge complete!`)
  console.log(`  ${request.amount} USDC → ${request.recipientAddress} on Arc`)
  console.log(`  Token ID: ${tokenId}`)
  console.log(`${'═'.repeat(60)}\n`)

  return {
    burnTxHash,
    cctpMessageHash,
    tokenId,
    mintTxHash,
    settleTxHash,
  }
}

// ── CLI Entry Point ────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)

  function getArg(name: string): string {
    const idx = args.indexOf(`--${name}`)
    if (idx === -1 || idx + 1 >= args.length) {
      console.error(`Missing required argument: --${name}`)
      console.error('')
      console.error('Usage:')
      console.error('  npx tsx src/bridgeService.ts \\')
      console.error('    --source ethereum-sepolia \\')
      console.error('    --sender-key 0x… \\')
      console.error('    --amount 10 \\')
      console.error('    --recipient 0x…')
      console.error('')
      console.error(`Supported source chains: ${Object.keys(SOURCE_CHAINS).join(', ')}`)
      process.exit(1)
    }
    return args[idx + 1]
  }

  const TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes

  try {
    const result = await Promise.race([
      bridgeAndMint({
        sourceChain:     getArg('source'),
        senderPrivateKey: getArg('sender-key') as `0x${string}`,
        amount:          getArg('amount'),
        recipientAddress: getArg('recipient') as `0x${string}`,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Bridge timed out after 30 minutes')), TIMEOUT_MS),
      ),
    ])

    console.log('\nResult:', JSON.stringify(result, null, 2))
  } catch (err) {
    console.error(`\nBridge failed: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }
}

// Run if executed directly
if (process.argv[1]?.includes('bridgeService')) {
  main()
}
