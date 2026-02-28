// Bridge endpoints: settle and initiate-cctp.
// In the MVP the deployer acts as bridge, so these endpoints call the contract
// using the PRIVATE_KEY from .env.  In production these would be replaced by
// the CCTP MessageTransmitter integration.

import { Router } from 'express'
import { isHex, keccak256, toBytes } from 'viem'
import { type AppCtx } from '../ctx.js'
import { type Store } from '../store.js'
import { MEANTIME_ABI } from '../abi.js'
import { trackSepoliaTx } from '../sepoliaWatcher.js'

export function buildBridgeRouter(ctx: AppCtx, store: Store): Router {
  const router = Router()

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

  // POST /api/bridge/initiate-cctp
  // Body: { txHash, recipient }
  // Called by the frontend after depositForBurn on Sepolia.
  router.post('/initiate-cctp', async (req, res) => {
    try {
      const { txHash, recipient } = req.body

      if (!txHash || !isHex(txHash)) {
        res.status(400).json({ error: 'txHash must be a 0x hex string' })
        return
      }

      // Start tracking in background; respond immediately so UI doesn't time out
      res.json({ ok: true, message: 'Tracking CCTP transfer — NFT will appear shortly.' })

      // Background: wait for Sepolia receipt, mint on Arc, start attestation
      trackSepoliaTx(ctx, store, txHash as `0x${string}`, recipient).catch(err => {
        console.error('[bridge/initiate-cctp] Error:', err)
      })
    } catch (err) {
      console.error('[bridge/initiate-cctp]', err)
      res.status(500).json({ error: String(err) })
    }
  })

  return router
}
