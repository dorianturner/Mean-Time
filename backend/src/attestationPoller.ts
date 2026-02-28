// Polls Circle's attestation API for a given CCTP messageHash.
// When attestation is ready, completes the CCTP flow on Arc:
//   1. If Arc has a real MessageTransmitter: calls receiveMessage(message, attestation)
//      to mint real USDC to MeanTime.
//   2. Fallback (mock): mints MockERC20 USDC to MeanTime using the deployer key.
// Then calls MeanTime.settle(messageHash) to pay the beneficial owner.

import { type AppCtx, ARC_CCTP } from './ctx.js'
import { type Store } from './store.js'
import { MEANTIME_ABI } from './abi.js'

const ATTESTATION_API = 'https://iris-api-sandbox.circle.com/attestations'
const POLL_INTERVAL_MS = 30_000   // 30 seconds
const MAX_ATTEMPTS     = 60       // ~30 min max wait

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

// Minimal ABI for MockERC20.mint(address to, uint256 amount)
const MOCK_ERC20_ABI = [
  {
    type: 'function',
    name: 'mint',
    inputs: [
      { name: 'to',     type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

interface AttestationResponse {
  status:      string        // 'pending_confirmations' | 'complete'
  attestation: string | null // hex string when complete
}

export async function pollAttestation(
  ctx: AppCtx,
  store: Store,
  messageHash: `0x${string}`,
  messageBytes: `0x${string}`,
): Promise<void> {
  console.log(`[attestation] Polling for ${messageHash}`)

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await sleep(POLL_INTERVAL_MS)

    try {
      const res = await fetch(`${ATTESTATION_API}/${messageHash}`)

      if (res.status === 404) {
        // Normal during early confirmation window
        console.log(`[attestation] ${messageHash}: pending (attempt ${attempt + 1})`)
        continue
      }

      if (!res.ok) {
        console.warn(`[attestation] API returned ${res.status}`)
        continue
      }

      const body = await res.json() as AttestationResponse

      if (body.status !== 'complete' || !body.attestation) {
        console.log(`[attestation] ${messageHash}: ${body.status} (attempt ${attempt + 1})`)
        continue
      }

      console.log(`[attestation] ${messageHash}: COMPLETE — settling…`)
      await settle(ctx, store, messageHash, messageBytes, body.attestation as `0x${string}`)
      return
    } catch (err) {
      console.warn(`[attestation] Poll error (attempt ${attempt + 1}):`, err)
    }
  }

  console.error(`[attestation] Gave up waiting for ${messageHash} after ${MAX_ATTEMPTS} attempts`)
}

async function settle(
  ctx: AppCtx,
  _store: Store,
  messageHash: `0x${string}`,
  messageBytes: `0x${string}`,
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

  // Read the NFT data to get inboundAmount and inboundToken
  const [, data] = await ctx.publicClient.readContract({
    address:      ctx.addresses.meantime,
    abi:          MEANTIME_ABI,
    functionName: 'getReceivable',
    args:         [tokenId],
  }) as [string, { cctpMessageHash: `0x${string}`; inboundToken: `0x${string}`; inboundAmount: bigint; mintedAt: bigint }, unknown, bigint, bigint]

  const { inboundToken, inboundAmount } = data

  // Step 1: Get USDC into MeanTime
  const arcMT = ARC_CCTP.messageTransmitter
  if (arcMT) {
    // Try real CCTP receive on Arc
    try {
      console.log(`[settle] Calling Arc MessageTransmitter.receiveMessage…`)
      const txHash = await ctx.walletClient.writeContract({
        address:      arcMT,
        abi:          MESSAGE_TRANSMITTER_ABI,
        functionName: 'receiveMessage',
        args:         [messageBytes, attestation],
        account:      ctx.account,
        chain:        null,
      })
      await ctx.publicClient.waitForTransactionReceipt({ hash: txHash })
      console.log(`[settle] receiveMessage OK (${txHash})`)
    } catch (err) {
      console.warn(`[settle] receiveMessage failed, falling back to mock mint:`, err)
      await mockMintUsdc(ctx, inboundToken, inboundAmount)
    }
  } else {
    // Fallback: mint MockERC20 directly
    console.log(`[settle] No Arc MessageTransmitter configured — using mock USDC mint`)
    await mockMintUsdc(ctx, inboundToken, inboundAmount)
  }

  // Step 2: Call settle() on MeanTime
  try {
    console.log(`[settle] Calling MeanTime.settle(${messageHash})…`)
    const txHash = await ctx.walletClient.writeContract({
      address:      ctx.addresses.meantime,
      abi:          MEANTIME_ABI,
      functionName: 'settle',
      args:         [messageHash],
      account:      ctx.account,
      chain:        null,
    })
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
    const txHash = await ctx.walletClient.writeContract({
      address:      inboundToken,
      abi:          MOCK_ERC20_ABI,
      functionName: 'mint',
      args:         [ctx.addresses.meantime, amount],
      account:      ctx.account,
      chain:        null,
    })
    await ctx.publicClient.waitForTransactionReceipt({ hash: txHash })
    console.log(`[settle] Mock USDC minted to MeanTime (${txHash})`)
  } catch (err) {
    console.error(`[settle] Mock mint failed:`, err)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
