// Polls Circle's attestation API for a given CCTP messageHash.
// When attestation is ready, completes the CCTP flow on Arc:
//   1. If ARC_MESSAGE_TRANSMITTER is set: calls receiveMessage(message, attestation)
//      to mint real USDC to MeanTime.
//   2. Fallback: mints MockERC20 USDC to MeanTime directly (deployer is owner).
// Then calls MeanTime.settle(messageHash) to pay the current beneficial owner.

import { type AppCtx, ARC_CCTP } from './ctx.js'
import { type Store } from './store.js'
import { MEANTIME_ABI, ERC20_MINT_ABI } from './abi.js'

const ATTESTATION_API  = 'https://iris-api-sandbox.circle.com/attestations'
const POLL_INTERVAL_MS = 30_000   // 30 seconds
const MAX_ATTEMPTS     = 60       // ~30 min max wait

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

      console.log(`[attestation] ${messageHash}: COMPLETE`)
      await settle(ctx, store, messageHash, messageBytes, body.attestation as `0x${string}`)
      return
    } catch (err) {
      console.warn(`[attestation] Poll error (attempt ${attempt + 1}):`, err)
    }
  }

  console.error(`[attestation] Gave up on ${messageHash} after ${MAX_ATTEMPTS} attempts`)
}

async function settle(
  ctx: AppCtx,
  _store: Store,
  messageHash: `0x${string}`,
  messageBytes: `0x${string}`,
  attestation: `0x${string}`,
): Promise<void> {
  // Look up which tokenId corresponds to this messageHash
  const tokenId = await ctx.publicClient.readContract({
    address:      ctx.addresses.meantime,
    abi:          MEANTIME_ABI,
    functionName: 'tokenByMessageHash',
    args:         [messageHash],
  }).catch(() => 0n) as bigint

  if (tokenId === 0n) {
    console.warn(`[settle] No NFT found for ${messageHash}`)
    return
  }

  // Read inboundToken + inboundAmount from the NFT
  const nftData = await ctx.publicClient.readContract({
    address:      ctx.addresses.meantime,
    abi:          MEANTIME_ABI,
    functionName: 'nftData',
    args:         [tokenId],
  }) as readonly [`0x${string}`, `0x${string}`, bigint, bigint]
  // nftData = [cctpMessageHash, inboundToken, inboundAmount, mintedAt]
  const inboundToken  = nftData[1]
  const inboundAmount = nftData[2]

  console.log(`[settle] tokenId=${tokenId} inboundToken=${inboundToken} amount=${inboundAmount}`)

  // Step 1: get USDC into the MeanTime contract
  const arcMT = ARC_CCTP.messageTransmitter
  if (arcMT) {
    try {
      console.log('[settle] Trying Arc MessageTransmitter.receiveMessage…')
      const tx = await ctx.walletClient.writeContract({
        address:      arcMT,
        abi:          MESSAGE_TRANSMITTER_ABI,
        functionName: 'receiveMessage',
        args:         [messageBytes, attestation],
        account:      ctx.account,
        chain:        null,
      })
      await ctx.publicClient.waitForTransactionReceipt({ hash: tx })
      console.log(`[settle] receiveMessage OK (${tx})`)
    } catch (err) {
      console.warn('[settle] receiveMessage failed, falling back to mock mint:', (err as Error).message)
      await mockMint(ctx, inboundToken, inboundAmount)
    }
  } else {
    console.log('[settle] No Arc MessageTransmitter — minting mock USDC to MeanTime')
    await mockMint(ctx, inboundToken, inboundAmount)
  }

  // Step 2: settle — pays current beneficial owner and burns NFT
  try {
    console.log(`[settle] Calling MeanTime.settle(${messageHash})…`)
    const tx = await ctx.walletClient.writeContract({
      address:      ctx.addresses.meantime,
      abi:          MEANTIME_ABI,
      functionName: 'settle',
      args:         [messageHash],
      account:      ctx.account,
      chain:        null,
    })
    await ctx.publicClient.waitForTransactionReceipt({ hash: tx })
    console.log(`[settle] Done (${tx})`)
  } catch (err) {
    console.error('[settle] settle() failed:', err)
  }
}

async function mockMint(
  ctx: AppCtx,
  inboundToken: `0x${string}`,
  amount: bigint,
): Promise<void> {
  try {
    const tx = await ctx.walletClient.writeContract({
      address:      inboundToken,
      abi:          ERC20_MINT_ABI,
      functionName: 'mint',
      args:         [ctx.addresses.meantime, amount],
      account:      ctx.account,
      chain:        null,
    })
    await ctx.publicClient.waitForTransactionReceipt({ hash: tx })
    console.log(`[settle] Mock mint OK (${tx})`)
  } catch (err) {
    console.error('[settle] Mock mint failed:', err)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
