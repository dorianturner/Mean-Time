// Bridge endpoint: mint a receivable NFT and auto-settle after a delay.
// The deployer acts as bridge (calls mint + settle) using PRIVATE_KEY from .env.
// In production this would be replaced by the CCTP MessageTransmitter.

import { Router } from 'express'
import { isAddress, isHex, keccak256, toBytes } from 'viem'
import { type AppCtx } from '../ctx.js'
import { MEANTIME_ABI } from '../abi.js'
import { ERC20_MINT_ABI } from '../abi.js'

const DEFAULT_SETTLE_DELAY = 30 // seconds

export function buildBridgeRouter(ctx: AppCtx): Router {
  const router = Router()

  // POST /api/bridge/mint
  // Body: { cctpMessageHash, inboundToken, inboundAmount, recipient, settleDelaySec? }
  // After minting the receivable NFT, the backend:
  //   1. Mints inbound tokens to the MeanTime contract (simulating CCTP delivery)
  //   2. Waits settleDelaySec seconds (default 30)
  //   3. Calls settle() to pay out the current beneficial owner
  router.post('/mint', async (req, res) => {
    try {
      const { cctpMessageHash: rawHash, inboundToken, inboundAmount, recipient, settleDelaySec } = req.body

      if (!inboundToken || !isAddress(inboundToken)) {
        res.status(400).json({ error: 'inboundToken must be a valid address' })
        return
      }
      if (!recipient || !isAddress(recipient)) {
        res.status(400).json({ error: 'recipient must be a valid address' })
        return
      }
      if (!inboundAmount || isNaN(Number(inboundAmount))) {
        res.status(400).json({ error: 'inboundAmount must be a number' })
        return
      }

      const hash: `0x${string}` = isHex(rawHash)
        ? rawHash
        : keccak256(toBytes(rawHash ?? String(Date.now())))

      const amount = BigInt(inboundAmount)
      const delaySec = Math.max(0, Number(settleDelaySec ?? DEFAULT_SETTLE_DELAY))

      // 1. Mint the receivable NFT
      const txHash = await ctx.walletClient.writeContract({
        address:      ctx.addresses.meantime,
        abi:          MEANTIME_ABI,
        functionName: 'mint',
        args:         [hash, inboundToken as `0x${string}`, amount, recipient as `0x${string}`],
        account:      ctx.account,
        chain:        null,
      })

      console.log(`[bridge/mint] Minted receivable (hash=${hash.slice(0, 10)}…). Auto-settle in ${delaySec}s`)

      // 2. Schedule auto-settle in background (don't block the response)
      scheduleSettle(ctx, hash, inboundToken as `0x${string}`, amount, delaySec)

      res.json({ txHash, settleDelaySec: delaySec })
    } catch (err) {
      console.error('[bridge/mint]', err)
      res.status(500).json({ error: String(err) })
    }
  })

  return router
}

/** Mint inbound tokens to the contract, wait, then settle. Runs in background. */
async function scheduleSettle(
  ctx: AppCtx,
  hash: `0x${string}`,
  inboundToken: `0x${string}`,
  amount: bigint,
  delaySec: number,
) {
  try {
    // Mint the inbound tokens to the MeanTime contract so settle() can pay out
    await ctx.walletClient.writeContract({
      address:      inboundToken,
      abi:          ERC20_MINT_ABI,
      functionName: 'mint',
      args:         [ctx.addresses.meantime, amount],
      account:      ctx.account,
      chain:        null,
    })
    console.log(`[bridge/settle] Funded contract with ${amount} tokens. Waiting ${delaySec}s…`)

    // Wait for the attestation delay
    await new Promise(r => setTimeout(r, delaySec * 1000))

    // Settle
    const settleTx = await ctx.walletClient.writeContract({
      address:      ctx.addresses.meantime,
      abi:          MEANTIME_ABI,
      functionName: 'settle',
      args:         [hash],
      account:      ctx.account,
      chain:        null,
    })
    console.log(`[bridge/settle] Settled! tx=${settleTx}`)
  } catch (err) {
    console.error('[bridge/settle] Auto-settle failed:', err)
  }
}
