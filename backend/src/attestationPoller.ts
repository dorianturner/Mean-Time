// Polls Circle attestation API for a given CCTP messageHash.
// When attestation is ready, completes the CCTP flow on Arc.
// If Circle never attests (e.g. Arc testnet not supported), the poller auto-settles
// after AUTO_SETTLE_TIMEOUT_MS by mock-minting USDC and calling settle().
//
// recoverSettlements() runs at startup -- checks every active receivable
// against Circle API and settles any that completed while the backend was down.

import { type AppCtx, ARC_CCTP } from './ctx.js'
import { type Store } from './store.js'
import { MEANTIME_ABI, ERC20_MINT_ABI } from './abi.js'
import { enqueueTx } from './txQueue.js'

const ATTESTATION_API = 'https://iris-api-sandbox.circle.com/attestations'
const POLL_INTERVAL_MS = 30_000                 // 30 seconds between attempts
const AUTO_SETTLE_TIMEOUT_MS = 17 * 60 * 1000   // 17 min -- auto-settle if Circle never attests

const activePollers = new Set<string>()

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

interface AttestationResponse {
  status:      string
  attestation: string | null
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function isStillActive(ctx: AppCtx, messageHash: `0x${string}`): Promise<boolean> {
  try {
    const tokenId = await ctx.publicClient.readContract({
      address: ctx.addresses.meantime, abi: MEANTIME_ABI,
      functionName: 'tokenByMessageHash', args: [messageHash],
    }) as bigint
    return tokenId !== 0n
  } catch { return false }
}

async function mockMintUsdc(ctx: AppCtx, inboundToken: `0x${string}`, amount: bigint): Promise<void> {
  const txHash = await enqueueTx(() =>
    ctx.walletClient.writeContract({
      address: inboundToken, abi: ERC20_MINT_ABI, functionName: 'mint',
      args: [ctx.addresses.meantime, amount], account: ctx.account, chain: null,
    }),
  )
  await ctx.publicClient.waitForTransactionReceipt({ hash: txHash })
  console.log(`[settle] Mock USDC minted to MeanTime (${txHash})`)
}

export async function autoSettle(
  ctx: AppCtx, messageHash: `0x${string}`,
): Promise<{ tokenId: bigint; settleTx: `0x${string}` } | null> {
  const tokenId = await ctx.publicClient.readContract({
    address: ctx.addresses.meantime, abi: MEANTIME_ABI,
    functionName: 'tokenByMessageHash', args: [messageHash],
  }).catch(() => 0n) as bigint

  if (tokenId === 0n) { console.warn(`[auto-settle] No active NFT for ${messageHash}`); return null }

  const [owner, data] = await ctx.publicClient.readContract({
    address: ctx.addresses.meantime, abi: MEANTIME_ABI,
    functionName: 'getReceivable', args: [tokenId],
  }) as [string, { cctpMessageHash: `0x${string}`; inboundToken: `0x${string}`; inboundAmount: bigint; mintedAt: bigint }, unknown, bigint, bigint]

  const { inboundToken, inboundAmount } = data
  console.log(`[auto-settle] tokenId=${tokenId} token=${inboundToken} amount=${inboundAmount} owner=${owner}`)

  await mockMintUsdc(ctx, inboundToken, inboundAmount)

  const txHash = await enqueueTx(() =>
    ctx.walletClient.writeContract({
      address: ctx.addresses.meantime, abi: MEANTIME_ABI, functionName: 'settle',
      args: [messageHash], account: ctx.account, chain: null,
    }),
  )
  await ctx.publicClient.waitForTransactionReceipt({ hash: txHash })
  console.log(`[auto-settle] Settlement complete (${txHash})`)
  return { tokenId, settleTx: txHash }
}

export async function pollAttestation(
  ctx: AppCtx, store: Store, messageHash: `0x${string}`, messageBytes?: `0x${string}`,
): Promise<void> {
  const key = messageHash.toLowerCase()
  if (activePollers.has(key)) { console.log(`[attestation] Poller already active for ${messageHash}, skipping`); return }
  activePollers.add(key)
  console.log(`[attestation] Polling for ${messageHash}`)

  const startedAt = Date.now()

  try {
    for (let attempt = 0; ; attempt++) {
      await sleep(POLL_INTERVAL_MS)

      if (!(await isStillActive(ctx, messageHash))) {
        console.log(`[attestation] ${messageHash}: already settled on-chain -- stopping poller`)
        return
      }

      if (Date.now() - startedAt >= AUTO_SETTLE_TIMEOUT_MS) {
        console.log(`[attestation] ${messageHash}: ${AUTO_SETTLE_TIMEOUT_MS / 1000}s timeout -- auto-settling`)
        try { await autoSettle(ctx, messageHash) } catch (err) {
          console.error(`[attestation] Auto-settle failed for ${messageHash}:`, err)
        }
        return
      }

      try {
        const res = await fetch(`${ATTESTATION_API}/${messageHash}`)
        if (res.status === 404) { console.log(`[attestation] ${messageHash}: pending (attempt ${attempt + 1})`); continue }
        if (!res.ok) { console.warn(`[attestation] API returned ${res.status}`); continue }

        const body = await res.json() as AttestationResponse
        if (body.status !== 'complete' || !body.attestation) {
          console.log(`[attestation] ${messageHash}: ${body.status} (attempt ${attempt + 1})`)
          continue
        }

        console.log(`[attestation] ${messageHash}: COMPLETE -- settling`)
        await settleWithAttestation(ctx, store, messageHash, messageBytes, body.attestation as `0x${string}`)
        return
      } catch (err) {
        console.warn(`[attestation] Poll error (attempt ${attempt + 1}):`, err)
      }
    }
  } finally {
    activePollers.delete(key)
  }
}

async function settleWithAttestation(
  ctx: AppCtx, _store: Store, messageHash: `0x${string}`,
  messageBytes: `0x${string}` | undefined, attestation: `0x${string}`,
): Promise<void> {
  const tokenId = await ctx.publicClient.readContract({
    address: ctx.addresses.meantime, abi: MEANTIME_ABI,
    functionName: 'tokenByMessageHash', args: [messageHash],
  }).catch(() => 0n) as bigint

  if (tokenId === 0n) { console.warn(`[settle] No NFT found for messageHash ${messageHash}`); return }

  const [owner, data] = await ctx.publicClient.readContract({
    address: ctx.addresses.meantime, abi: MEANTIME_ABI,
    functionName: 'getReceivable', args: [tokenId],
  }) as [string, { cctpMessageHash: `0x${string}`; inboundToken: `0x${string}`; inboundAmount: bigint; mintedAt: bigint }, unknown, bigint, bigint]

  const { inboundToken, inboundAmount } = data
  console.log(`[settle] tokenId=${tokenId} token=${inboundToken} amount=${inboundAmount} beneficialOwner=${owner}`)

  const arcMT = ARC_CCTP.messageTransmitter
  if (arcMT && messageBytes) {
    try {
      console.log('[settle] Calling Arc MessageTransmitter.receiveMessage')
      const txHash = await enqueueTx(() =>
        ctx.walletClient.writeContract({
          address: arcMT, abi: MESSAGE_TRANSMITTER_ABI, functionName: 'receiveMessage',
          args: [messageBytes, attestation], account: ctx.account, chain: null,
        }),
      )
      await ctx.publicClient.waitForTransactionReceipt({ hash: txHash })
      console.log(`[settle] receiveMessage OK (${txHash})`)
    } catch (err) {
      console.warn('[settle] receiveMessage failed, falling back to mock mint:', err)
      await mockMintUsdc(ctx, inboundToken, inboundAmount)
    }
  } else {
    console.log('[settle] No Arc MessageTransmitter configured -- using mock USDC mint')
    await mockMintUsdc(ctx, inboundToken, inboundAmount)
  }

  try {
    console.log(`[settle] Calling MeanTime.settle(${messageHash})`)
    const txHash = await enqueueTx(() =>
      ctx.walletClient.writeContract({
        address: ctx.addresses.meantime, abi: MEANTIME_ABI, functionName: 'settle',
        args: [messageHash], account: ctx.account, chain: null,
      }),
    )
    await ctx.publicClient.waitForTransactionReceipt({ hash: txHash })
    console.log(`[settle] Settlement complete (${txHash})`)
  } catch (err) {
    console.error('[settle] settle() failed:', err)
  }
}

export async function recoverSettlements(ctx: AppCtx, store: Store): Promise<void> {
  const receivables = store.snapshot()
  if (receivables.length === 0) return
  console.log(`[recovery] Checking ${receivables.length} active receivable(s) for attestation status`)

  for (const r of receivables) {
    const messageHash = r.cctpMessageHash as `0x${string}`
    if (!(await isStillActive(ctx, messageHash))) {
      console.log(`[recovery] ${messageHash}: already settled -- skipping`)
      continue
    }
    try {
      const res = await fetch(`${ATTESTATION_API}/${messageHash}`)
      if (res.status === 404) {
        console.log(`[recovery] ${messageHash}: not found on Circle API -- starting poller`)
        pollAttestation(ctx, store, messageHash).catch(e => console.error(`[recovery] Poller error for ${messageHash}:`, e))
        continue
      }
      if (!res.ok) {
        console.warn(`[recovery] ${messageHash}: Circle API returned ${res.status}`)
        pollAttestation(ctx, store, messageHash).catch(e => console.error(`[recovery] Poller error for ${messageHash}:`, e))
        continue
      }
      const body = await res.json() as AttestationResponse
      if (body.status === 'complete' && body.attestation) {
        console.log(`[recovery] ${messageHash}: ALREADY COMPLETE -- settling now`)
        await settleWithAttestation(ctx, store, messageHash, undefined, body.attestation as `0x${string}`)
      } else {
        console.log(`[recovery] ${messageHash}: ${body.status} -- starting poller`)
        pollAttestation(ctx, store, messageHash).catch(e => console.error(`[recovery] Poller error for ${messageHash}:`, e))
      }
    } catch (err) {
      console.warn(`[recovery] Error checking ${messageHash}:`, err)
      pollAttestation(ctx, store, messageHash).catch(e => console.error(`[recovery] Poller error for ${messageHash}:`, e))
    }
  }
  console.log('[recovery] Done')
}