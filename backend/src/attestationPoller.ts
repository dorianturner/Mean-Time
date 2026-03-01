// Polls Circle's attestation API for a given CCTP messageHash.
// When attestation is ready, completes the CCTP flow on Arc:
//   1. If Arc has a real MessageTransmitter: calls receiveMessage(message, attestation)
//      to mint real USDC to MeanTime.
//   2. Fallback (mock): mints MockERC20 USDC to MeanTime using the deployer key.
// Then calls MeanTime.settle(messageHash) to pay the current beneficial owner.
//
// Uses Circle's V2 attestation API when a source tx hash is available:
//   GET /v2/messages/{sourceDomain}?transactionHash={txHash}
// Falls back to V1 API (/attestations/{messageHash}) when no tx hash is known.
//
// recoverSettlements() runs at startup — it checks every active receivable
// against Circle's API and settles any that completed while the backend was down.

import { keccak256 } from 'viem'
import { type AppCtx, ARC_CCTP, SEPOLIA_CCTP } from './ctx.js'
import { type Store } from './store.js'
import { MEANTIME_ABI, ERC20_MINT_ABI } from './abi.js'
import { enqueueTx } from './txQueue.js'

const V2_ATTESTATION_API = 'https://iris-api-sandbox.circle.com/v2/messages'
const V1_ATTESTATION_API = 'https://iris-api-sandbox.circle.com/attestations'

// Backoff schedule: 30s for the first 60 attempts (~30 min),
// then 2 min up to attempt 120, then 5 min forever.
function pollDelay(attempt: number): number {
  if (attempt < 60)  return 30_000     // 30s
  if (attempt < 120) return 120_000    // 2 min
  return 300_000                        // 5 min
}

// Track which messageHashes already have an active poller so we don't double-poll.
const activePollers = new Set<string>()

// Minimal ABI for Circle's MessageTransmitter.receiveMessage
const MESSAGE_TRANSMITTER_ABI = [
  {
    type: 'function',
    name: 'receiveMessage',
    inputs: [
      { name: 'message',     type: 'bytes' },
      { name: 'attestation', type: 'bytes' },
    ],
    outputs: [{ name: 'success', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
] as const

interface V2Message {
  message:     string
  attestation: string  // "PENDING" or hex attestation bytes
  eventNonce?: string
  sourceDomain?: string
  destinationDomain?: string
}

interface V2AttestationResponse {
  messages: V2Message[]
}

interface V1AttestationResponse {
  status:      string
  attestation: string | null
}

/**
 * Try V2 attestation API: GET /v2/messages/{sourceDomain}?transactionHash={txHash}
 * Returns { attestation, messageBytes } if attestation is ready, null if pending.
 */
async function tryV2Api(
  sourceDomain: number,
  sourceTxHash: string,
  messageHash: string,
): Promise<{ attestation: `0x${string}`; messageBytes: `0x${string}` } | null> {
  const url = `${V2_ATTESTATION_API}/${sourceDomain}?transactionHash=${sourceTxHash}`
  const res = await fetch(url)

  if (res.status === 404 || !res.ok) return null

  const body = await res.json() as V2AttestationResponse

  if (!body.messages || body.messages.length === 0) return null

  // Find the message matching our messageHash
  for (const msg of body.messages) {
    if (msg.attestation === 'PENDING') continue

    // Verify this is the right message by hashing and comparing
    const msgBytes = msg.message as `0x${string}`
    const hash = keccak256(msgBytes)
    if (hash.toLowerCase() === messageHash.toLowerCase()) {
      return {
        attestation: msg.attestation as `0x${string}`,
        messageBytes: msgBytes,
      }
    }
  }

  return null
}

/**
 * Try V1 attestation API: GET /attestations/{messageHash}
 * Returns attestation hex if ready, null if pending.
 */
async function tryV1Api(
  messageHash: string,
): Promise<`0x${string}` | null> {
  const url = `${V1_ATTESTATION_API}/${messageHash}`
  const res = await fetch(url)

  if (res.status === 404 || !res.ok) return null

  const body = await res.json() as V1AttestationResponse

  if (body.status === 'complete' && body.attestation) {
    return body.attestation as `0x${string}`
  }

  return null
}

export async function pollAttestation(
  ctx: AppCtx,
  store: Store,
  messageHash: `0x${string}`,
  messageBytes?: `0x${string}`,
  sourceTxHash?: string,
  sourceDomain?: number,
): Promise<void> {
  const key = messageHash.toLowerCase()
  if (activePollers.has(key)) {
    console.log(`[attestation] Poller already active for ${messageHash}, skipping`)
    return
  }
  activePollers.add(key)
  console.log(`[attestation] Polling for ${messageHash}${sourceTxHash ? ` (srcTx=${sourceTxHash})` : ''}`)

  const domain = sourceDomain ?? SEPOLIA_CCTP.domain  // default to Sepolia (0)

  try {
    // Infinite retry with exponential backoff — never give up
    for (let attempt = 0; ; attempt++) {
      await sleep(pollDelay(attempt))

      try {
        // Try V2 API first (when source tx hash is available)
        if (sourceTxHash) {
          const v2Result = await tryV2Api(domain, sourceTxHash, messageHash)
          if (v2Result) {
            console.log(`[attestation] ${messageHash}: COMPLETE (V2 API) — settling…`)
            // V2 may return updated messageBytes — prefer those
            const finalMessageBytes = v2Result.messageBytes || messageBytes
            await settle(ctx, store, messageHash, finalMessageBytes, v2Result.attestation)
            return
          }
        }

        // Fall back to V1 API
        const v1Result = await tryV1Api(messageHash)
        if (v1Result) {
          console.log(`[attestation] ${messageHash}: COMPLETE (V1 API) — settling…`)
          await settle(ctx, store, messageHash, messageBytes, v1Result)
          return
        }

        console.log(`[attestation] ${messageHash}: pending (attempt ${attempt + 1})`)
      } catch (err) {
        console.warn(`[attestation] Poll error (attempt ${attempt + 1}):`, err)
      }
    }
  } finally {
    activePollers.delete(key)
  }
}

async function settle(
  ctx: AppCtx,
  _store: Store,
  messageHash: `0x${string}`,
  messageBytes: `0x${string}` | undefined,
  attestation: `0x${string}`,
): Promise<void> {
  // Look up tokenId from messageHash
  const tokenId = await ctx.publicClient.readContract({
    address:      ctx.addresses.meantime,
    abi:          MEANTIME_ABI,
    functionName: 'tokenByMessageHash',
    args:         [messageHash],
  }).catch(() => 0n) as bigint

  if (tokenId === 0n) {
    console.warn(`[settle] No NFT found for messageHash ${messageHash}`)
    return
  }

  // Read the NFT data to get inboundAmount, inboundToken
  const nftData = await ctx.publicClient.readContract({
    address:      ctx.addresses.meantime,
    abi:          MEANTIME_ABI,
    functionName: 'nftData',
    args:         [tokenId],
  }) as readonly [`0x${string}`, `0x${string}`, bigint, bigint]
  // nftData = [cctpMessageHash, inboundToken, inboundAmount, mintedAt]
  const inboundToken  = nftData[1]
  const inboundAmount = nftData[2]

  // Read beneficial owner (whoever currently holds the NFT)
  const owner = await ctx.publicClient.readContract({
    address:      ctx.addresses.meantime,
    abi:          MEANTIME_ABI,
    functionName: 'beneficialOwner',
    args:         [tokenId],
  }) as `0x${string}`

  console.log(`[settle] tokenId=${tokenId} token=${inboundToken} amount=${inboundAmount} -> beneficialOwner=${owner}`)

  // Step 1: Get USDC into MeanTime via CCTP receiveMessage
  const arcMT = ARC_CCTP.messageTransmitter
  if (arcMT && messageBytes) {
    try {
      console.log(`[settle] Calling Arc MessageTransmitter.receiveMessage…`)
      const txHash = await enqueueTx(() =>
        ctx.walletClient.writeContract({
          address:      arcMT,
          abi:          MESSAGE_TRANSMITTER_ABI,
          functionName: 'receiveMessage',
          args:         [messageBytes, attestation],
          account:      ctx.account,
          chain:        null,
        }),
      )
      await ctx.publicClient.waitForTransactionReceipt({ hash: txHash })
      console.log(`[settle] receiveMessage OK (${txHash})`)
    } catch (err) {
      console.warn(`[settle] receiveMessage failed, falling back to mock mint:`, err)
      await mockMintUsdc(ctx, inboundToken, inboundAmount)
    }
  } else {
    // Fallback: mint MockERC20 directly
    console.log(`[settle] No Arc MessageTransmitter or messageBytes — using mock USDC mint`)
    await mockMintUsdc(ctx, inboundToken, inboundAmount)
  }

  // Step 2: Call settle() on MeanTime
  try {
    console.log(`[settle] Calling MeanTime.settle(${messageHash})…`)
    const txHash = await enqueueTx(() =>
      ctx.walletClient.writeContract({
        address:      ctx.addresses.meantime,
        abi:          MEANTIME_ABI,
        functionName: 'settle',
        args:         [messageHash],
        account:      ctx.account,
        chain:        null,
      }),
    )
    await ctx.publicClient.waitForTransactionReceipt({ hash: txHash })
    console.log(`[settle] Settlement complete (${txHash})`)
  } catch (err) {
    console.error(`[settle] settle() failed:`, err)
  }
}

async function mockMintUsdc(
  ctx: AppCtx,
  inboundToken: `0x${string}`,
  amount: bigint,
): Promise<void> {
  try {
    const txHash = await enqueueTx(() =>
      ctx.walletClient.writeContract({
        address:      inboundToken,
        abi:          ERC20_MINT_ABI,
        functionName: 'mint',
        args:         [ctx.addresses.meantime, amount],
        account:      ctx.account,
        chain:        null,
      }),
    )
    await ctx.publicClient.waitForTransactionReceipt({ hash: txHash })
    console.log(`[settle] Mock USDC minted to MeanTime (${txHash})`)
  } catch (err) {
    console.error(`[settle] Mock mint failed:`, err)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── Startup recovery ───────────────────────────────────────────────────────
// Called once after backfill+watcher. For every active receivable, checks
// Circle's V2 API (and V1 fallback). If already complete → settle immediately.
// If still pending → start a background poller so it settles when ready.

export async function recoverSettlements(ctx: AppCtx, store: Store): Promise<void> {
  const receivables = store.snapshot()
  if (receivables.length === 0) return

  console.log(`[recovery] Checking ${receivables.length} active receivable(s) for attestation status…`)

  for (const r of receivables) {
    const messageHash = r.cctpMessageHash as `0x${string}`

    try {
      // Try V1 API for recovery (we don't have sourceTxHash stored)
      const v1Result = await tryV1Api(messageHash)

      if (v1Result) {
        console.log(`[recovery] ${messageHash}: ALREADY COMPLETE — settling now`)
        await settle(ctx, store, messageHash, undefined, v1Result)
      } else {
        console.log(`[recovery] ${messageHash}: pending — starting poller`)
        // Start poller without sourceTxHash (will use V1 API)
        pollAttestation(ctx, store, messageHash).catch(err =>
          console.error(`[recovery] Poller error for ${messageHash}:`, err),
        )
      }
    } catch (err) {
      console.warn(`[recovery] Error checking ${messageHash}:`, err)
      pollAttestation(ctx, store, messageHash).catch(err2 =>
        console.error(`[recovery] Poller error for ${messageHash}:`, err2),
      )
    }
  }

  console.log(`[recovery] Done`)
}
