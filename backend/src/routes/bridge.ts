// Bridge endpoints: settle, force-settle, and initiate-cctp.
// In the MVP the deployer acts as bridge, so these endpoints call the contract
// using the PRIVATE_KEY from .env.  In production these would be replaced by
// the CCTP MessageTransmitter integration.

import { Router } from 'express'
import { isHex, keccak256, toBytes } from 'viem'
import { type AppCtx } from '../ctx.js'
import { type Store } from '../store.js'
import { MEANTIME_ABI, ERC20_MINT_ABI } from '../abi.js'
import { trackSepoliaTx, intendedRecipients } from '../sepoliaWatcher.js'
import { enqueueTx } from '../txQueue.js'

export function buildBridgeRouter(ctx: AppCtx, store: Store): Router {
  const router = Router()

  // POST /api/bridge/settle
  // Body: { cctpMessageHash }
  // Just calls settle() on the contract. Requires the contract to already hold USDC.
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

      const txHash = await enqueueTx(() =>
        ctx.walletClient.writeContract({
          address:      ctx.addresses.meantime,
          abi:          MEANTIME_ABI,
          functionName: 'settle',
          args:         [hash],
          account:      ctx.account,
          chain:        null,
        }),
      )

      res.json({ txHash })
    } catch (err) {
      console.error('[bridge/settle]', err)
      res.status(500).json({ error: String(err) })
    }
  })

  // POST /api/bridge/force-settle
  // Body: { tokenId } or { cctpMessageHash }
  // For testnet/mock environments where CCTP attestation never completes.
  // 1. Looks up the NFT on-chain to get inboundToken + inboundAmount
  // 2. Mock-mints that amount to the MeanTime contract
  // 3. Calls settle(cctpMessageHash) to pay the beneficialOwner
  router.post('/force-settle', async (req, res) => {
    try {
      let tokenId: bigint
      let cctpMessageHash: `0x${string}`

      if (req.body.tokenId) {
        tokenId = BigInt(req.body.tokenId)
        // Read messageHash from NFT data
        const data = await ctx.publicClient.readContract({
          address:      ctx.addresses.meantime,
          abi:          MEANTIME_ABI,
          functionName: 'nftData',
          args:         [tokenId],
        }) as readonly [`0x${string}`, `0x${string}`, bigint, bigint]
        cctpMessageHash = data[0]
        if (cctpMessageHash === '0x0000000000000000000000000000000000000000000000000000000000000000') {
          res.status(404).json({ error: `No NFT data for tokenId ${tokenId}` })
          return
        }
      } else if (req.body.cctpMessageHash) {
        const rawHash = req.body.cctpMessageHash
        cctpMessageHash = isHex(rawHash) ? rawHash : keccak256(toBytes(rawHash))
        tokenId = await ctx.publicClient.readContract({
          address:      ctx.addresses.meantime,
          abi:          MEANTIME_ABI,
          functionName: 'tokenByMessageHash',
          args:         [cctpMessageHash],
        }) as bigint
        if (tokenId === 0n) {
          res.status(404).json({ error: `No NFT for messageHash ${cctpMessageHash}` })
          return
        }
      } else {
        res.status(400).json({ error: 'tokenId or cctpMessageHash is required' })
        return
      }

      // Read NFT data
      const nftData = await ctx.publicClient.readContract({
        address:      ctx.addresses.meantime,
        abi:          MEANTIME_ABI,
        functionName: 'nftData',
        args:         [tokenId],
      }) as readonly [`0x${string}`, `0x${string}`, bigint, bigint]
      const inboundToken  = nftData[1] as `0x${string}`
      const inboundAmount = nftData[2]

      const owner = await ctx.publicClient.readContract({
        address:      ctx.addresses.meantime,
        abi:          MEANTIME_ABI,
        functionName: 'beneficialOwner',
        args:         [tokenId],
      }) as `0x${string}`

      console.log(`[force-settle] tokenId=${tokenId} token=${inboundToken} amount=${inboundAmount} owner=${owner}`)

      // Step 1: Mock-mint USDC to the MeanTime contract
      try {
        const mintTx = await enqueueTx(() =>
          ctx.walletClient.writeContract({
            address:      inboundToken,
            abi:          ERC20_MINT_ABI,
            functionName: 'mint',
            args:         [ctx.addresses.meantime, inboundAmount],
            account:      ctx.account,
            chain:        null,
          }),
        )
        await ctx.publicClient.waitForTransactionReceipt({ hash: mintTx })
        console.log(`[force-settle] Mock USDC minted (${mintTx})`)
      } catch (err) {
        console.error('[force-settle] Mock mint failed:', err)
        res.status(500).json({
          error: `Mock mint failed. Is ${inboundToken} a mintable ERC20? ` + String(err),
        })
        return
      }

      // Step 2: Call settle()
      const settleTx = await enqueueTx(() =>
        ctx.walletClient.writeContract({
          address:      ctx.addresses.meantime,
          abi:          MEANTIME_ABI,
          functionName: 'settle',
          args:         [cctpMessageHash],
          account:      ctx.account,
          chain:        null,
        }),
      )
      await ctx.publicClient.waitForTransactionReceipt({ hash: settleTx })
      console.log(`[force-settle] Settlement complete (${settleTx})`)

      res.json({
        ok: true,
        tokenId: tokenId.toString(),
        beneficialOwner: owner,
        inboundToken,
        inboundAmount: inboundAmount.toString(),
        mintTx: 'mocked',
        settleTx,
      })
    } catch (err) {
      console.error('[bridge/force-settle]', err)
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

      // Register the intended recipient BEFORE anything else so the background
      // Sepolia watcher uses it if it processes this burn first.
      if (recipient && /^0x[0-9a-fA-F]{40}$/.test(recipient)) {
        intendedRecipients.set(txHash.toLowerCase(), recipient as `0x${string}`)
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
