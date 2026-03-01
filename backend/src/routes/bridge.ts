// Bridge endpoints: settle, force-settle, initiate-cctp, and bridge-kit.

import { Router } from 'express'
import { isHex, keccak256, toBytes } from 'viem'
import { type AppCtx } from '../ctx.js'
import { type Store } from '../store.js'
import { MEANTIME_ABI } from '../abi.js'
import { trackSepoliaTx } from '../sepoliaWatcher.js'
import { enqueueTx } from '../txQueue.js'
import { autoSettle } from '../attestationPoller.js'
import { bridgeAndMint, type BridgeRequest } from '../bridgeService.js'

export function buildBridgeRouter(ctx: AppCtx, store: Store): Router {
  const router = Router()

  router.post('/settle', async (req, res) => {
    try {
      const { cctpMessageHash: rawHash } = req.body
      if (!rawHash) { res.status(400).json({ error: 'cctpMessageHash is required' }); return }
      const hash: `0x${string}` = isHex(rawHash) ? rawHash : keccak256(toBytes(rawHash))
      const txHash = await enqueueTx(() =>
        ctx.walletClient.writeContract({
          address: ctx.addresses.meantime, abi: MEANTIME_ABI, functionName: 'settle',
          args: [hash], account: ctx.account, chain: null,
        }),
      )
      res.json({ txHash })
    } catch (err) {
      console.error('[bridge/settle]', err)
      res.status(500).json({ error: String(err) })
    }
  })

  router.post('/force-settle', async (req, res) => {
    try {
      let { tokenId, cctpMessageHash } = req.body
      let messageHash: `0x${string}` | undefined
      if (cctpMessageHash) {
        messageHash = isHex(cctpMessageHash) ? cctpMessageHash : keccak256(toBytes(cctpMessageHash))
      }
      if (tokenId && !messageHash) {
        const [, data] = await ctx.publicClient.readContract({
          address: ctx.addresses.meantime, abi: MEANTIME_ABI,
          functionName: 'getReceivable', args: [BigInt(tokenId)],
        }) as [string, { cctpMessageHash: `0x${string}`; inboundToken: `0x${string}`; inboundAmount: bigint; mintedAt: bigint }, unknown, bigint, bigint]
        messageHash = data.cctpMessageHash
      }
      if (!messageHash) { res.status(400).json({ error: 'Provide tokenId or cctpMessageHash' }); return }
      const result = await autoSettle(ctx, messageHash)
      if (!result) { res.status(404).json({ error: 'No active NFT for that hash (already settled?)' }); return }
      res.json({ tokenId: result.tokenId.toString(), settleTx: result.settleTx })
    } catch (err) {
      console.error('[bridge/force-settle]', err)
      res.status(500).json({ error: String(err) })
    }
  })

  router.post('/initiate-cctp', async (req, res) => {
    try {
      const { txHash, recipient } = req.body
      if (!txHash || !isHex(txHash)) { res.status(400).json({ error: 'txHash must be a 0x hex string' }); return }
      const result = await trackSepoliaTx(ctx, store, txHash as `0x${string}`, recipient)
      if (!result) {
        res.status(422).json({ error: 'No CCTP MessageSent log found in that tx.' })
        return
      }
      res.json({ ok: true, tokenId: result.tokenId, messageHash: result.messageHash })
    } catch (err) {
      console.error('[bridge/initiate-cctp]', err)
      res.status(500).json({ error: String(err) })
    }
  })

  router.post('/bridge-kit', async (req, res) => {
    try {
      const { sourceChain, senderPrivateKey, amount, recipientAddress } = req.body as Partial<BridgeRequest>
      if (!sourceChain || !senderPrivateKey || !amount || !recipientAddress) {
        res.status(400).json({ error: 'Required: sourceChain, senderPrivateKey, amount, recipientAddress' })
        return
      }
      console.log(`[bridge-kit] Starting bridge: ${amount} USDC from ${sourceChain} to ${recipientAddress}`)
      bridgeAndMint({
        sourceChain,
        senderPrivateKey: senderPrivateKey as `0x${string}`,
        amount,
        recipientAddress: recipientAddress as `0x${string}`,
      }).then(r => console.log('[bridge-kit] Complete:', r)).catch(e => console.error('[bridge-kit] Failed:', e))
      res.json({ ok: true, message: 'Bridge initiated. Settlement in ~14 minutes.' })
    } catch (err) {
      console.error('[bridge/bridge-kit]', err)
      res.status(500).json({ error: String(err) })
    }
  })

  return router
}