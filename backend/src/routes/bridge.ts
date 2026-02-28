// Bridge-only endpoints: mint and settle.
// In the MVP the deployer acts as bridge, so these endpoints call the contract
// using the PRIVATE_KEY from .env.  In production these would be replaced by
// the CCTP MessageTransmitter integration.

import { Router } from 'express'
import { isAddress, isHex, parseUnits, keccak256, toBytes } from 'viem'
import { type AppCtx } from '../ctx.js'
import { MEANTIME_ABI } from '../abi.js'

export function buildBridgeRouter(ctx: AppCtx): Router {
  const router = Router()

  // POST /api/bridge/mint
  // Body: { cctpMessageHash, inboundToken, inboundAmount, recipient }
  // cctpMessageHash: hex string (0x…) OR arbitrary string (will be keccak256'd)
  router.post('/mint', async (req, res) => {
    try {
      const { cctpMessageHash: rawHash, inboundToken, inboundAmount, recipient } = req.body

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

      const txHash = await ctx.walletClient.writeContract({
        address:      ctx.addresses.meantime,
        abi:          MEANTIME_ABI,
        functionName: 'mint',
        args:         [hash, inboundToken as `0x${string}`, amount, recipient as `0x${string}`],
        account:      ctx.account,
        chain:        null,
      })

      res.json({ txHash })
    } catch (err) {
      console.error('[bridge/mint]', err)
      res.status(500).json({ error: String(err) })
    }
  })

  // POST /api/bridge/settle
  // Body: { cctpMessageHash }
  router.post('/settle', async (req, res) => {
    try {
      const { cctpMessageHash: rawHash } = req.body

      if (!rawHash) {
        res.status(400).json({ error: 'cctpMessageHash is required' })
        return
      }

      const hash: `0x${string}` = isHex(rawHash)
        ? rawHash
        : keccak256(toBytes(rawHash))

      const txHash = await ctx.walletClient.writeContract({
        address:      ctx.addresses.meantime,
        abi:          MEANTIME_ABI,
        functionName: 'settle',
        args:         [hash],
        account:      ctx.account,
        chain:        null,
      })

      res.json({ txHash })
    } catch (err) {
      console.error('[bridge/settle]', err)
      res.status(500).json({ error: String(err) })
    }
  })

  return router
}
