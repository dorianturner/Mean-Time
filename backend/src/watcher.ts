// Watches MeanTime contract events and keeps the Store in sync.
// backfillStore() replays all historical events so nothing is lost across restarts.
// startWatcher() subscribes to live events going forward.
// Returns a cleanup function that unsubscribes all watchers.

import { type AppCtx } from './ctx.js'
import { type Store } from './store.js'
import { MEANTIME_ABI } from './abi.js'

/**
 * Replay all past Minted/Listed/Delisted/Filled/Settled events from the chain
 * and rebuild the in-memory store. Call this BEFORE startWatcher().
 *
 * The RPC limits eth_getLogs to 10,000 blocks, so we scan from (latest - 9999)
 * which covers ~2.8 hours at 1-second blocks — more than enough for a testnet.
 */
export async function backfillStore(ctx: AppCtx, store: Store): Promise<void> {
  const address = ctx.addresses.meantime

  console.log('[backfill] Replaying historical events…')

  const latestBlock = await ctx.publicClient.getBlockNumber()

  // Scan in chunks of 9000 blocks, going back up to ~50k blocks
  const CHUNK = 9000n
  const MAX_LOOKBACK = 50000n
  const earliest = latestBlock > MAX_LOOKBACK ? latestBlock - MAX_LOOKBACK : 0n

  // Helper: fetch events across all chunks
  async function fetchAllEvents(eventName: string) {
    const allLogs: any[] = []
    let from = earliest
    while (from <= latestBlock) {
      const to = from + CHUNK - 1n > latestBlock ? latestBlock : from + CHUNK - 1n
      try {
        const logs = await ctx.publicClient.getContractEvents({
          address,
          abi: MEANTIME_ABI,
          eventName: eventName as any,
          fromBlock: from,
          toBlock: to,
        })
        allLogs.push(...logs)
      } catch (err: any) {
        console.warn(`[backfill] chunk ${from}-${to} for ${eventName} failed: ${err.message?.slice(0, 80)}`)
      }
      from = to + 1n
    }
    return allLogs
  }

  // Get all Minted events
  const mintedLogs = await fetchAllEvents('Minted')

  for (const log of mintedLogs) {
    const { tokenId, recipient, inboundToken, inboundAmount, cctpMessageHash } = log.args
    if (tokenId === undefined) continue
    store.upsert({
      tokenId,
      cctpMessageHash: cctpMessageHash as `0x${string}`,
      inboundToken:    inboundToken    as `0x${string}`,
      inboundAmount:   inboundAmount   as bigint,
      mintedAt:        BigInt(log.blockNumber ?? 0n),
      beneficialOwner: recipient       as `0x${string}`,
      listing:         null,
    })
  }

  // Apply listing events
  const listedLogs = await fetchAllEvents('Listed')
  for (const log of listedLogs) {
    const { tokenId, reservePrice, paymentToken } = log.args
    if (tokenId === undefined) continue
    store.patch(tokenId, {
      listing: { reservePrice: reservePrice as bigint, paymentToken: paymentToken as `0x${string}` },
    })
  }

  // Apply delist events
  const delistedLogs = await fetchAllEvents('Delisted')
  for (const log of delistedLogs) {
    const { tokenId } = log.args
    if (tokenId === undefined) continue
    store.patch(tokenId, { listing: null })
  }

  // Apply fill events
  const filledLogs = await fetchAllEvents('Filled')
  for (const log of filledLogs) {
    const { tokenId, relayer } = log.args
    if (tokenId === undefined) continue
    store.patch(tokenId, {
      listing:         null,
      beneficialOwner: relayer as `0x${string}`,
    })
  }

  // Apply settle events (remove settled receivables)
  const settledLogs = await fetchAllEvents('Settled')
  for (const log of settledLogs) {
    const { tokenId } = log.args
    if (tokenId === undefined) continue
    store.remove(tokenId)
  }

  console.log(`[backfill] Done — ${store.snapshot().length} active receivable(s)`)
}

export function startWatcher(ctx: AppCtx, store: Store): () => void {
  const address = ctx.addresses.meantime

  const unwatchMinted = ctx.publicClient.watchContractEvent({
    address,
    abi: MEANTIME_ABI,
    eventName: 'Minted',
    pollingInterval: 2_000,
    onError(err) { console.error('[watcher] Minted poll error:', err.message ?? err) },
    onLogs(logs) {
      for (const log of logs) {
        const { tokenId, recipient, inboundToken, inboundAmount, cctpMessageHash } = log.args
        if (tokenId === undefined) continue

        const receivable = {
          tokenId,
          cctpMessageHash: cctpMessageHash as `0x${string}`,
          inboundToken:    inboundToken    as `0x${string}`,
          inboundAmount:   inboundAmount   as bigint,
          mintedAt:        BigInt(log.blockNumber ?? 0n),
          beneficialOwner: recipient       as `0x${string}`,
          listing:         null,
        }

        store.upsert(receivable)
        store.emit({ type: 'minted', receivable })
      }
    },
  })

  const unwatchListed = ctx.publicClient.watchContractEvent({
    address,
    abi: MEANTIME_ABI,
    eventName: 'Listed',
    pollingInterval: 2_000,
    onError(err) { console.error('[watcher] Listed poll error:', err.message ?? err) },
    onLogs(logs) {
      for (const log of logs) {
        const { tokenId, reservePrice, paymentToken } = log.args
        if (tokenId === undefined) continue

        const listing = {
          reservePrice: reservePrice as bigint,
          paymentToken: paymentToken as `0x${string}`,
        }

        store.patch(tokenId, { listing })
        store.emit({ type: 'listed', tokenId, listing })
      }
    },
  })

  const unwatchDelisted = ctx.publicClient.watchContractEvent({
    address,
    abi: MEANTIME_ABI,
    eventName: 'Delisted',
    pollingInterval: 2_000,
    onError(err) { console.error('[watcher] Delisted poll error:', err.message ?? err) },
    onLogs(logs) {
      for (const log of logs) {
        const { tokenId } = log.args
        if (tokenId === undefined) continue

        console.log(`[watcher] Delisted tokenId=${tokenId}`)
        store.patch(tokenId, { listing: null })
        store.emit({ type: 'delisted', tokenId })
      }
    },
  })

  const unwatchFilled = ctx.publicClient.watchContractEvent({
    address,
    abi: MEANTIME_ABI,
    eventName: 'Filled',
    pollingInterval: 2_000,
    onError(err) { console.error('[watcher] Filled poll error:', err.message ?? err) },
    onLogs(logs) {
      for (const log of logs) {
        const { tokenId, relayer } = log.args
        if (tokenId === undefined) continue

        store.patch(tokenId, {
          listing:         null,
          beneficialOwner: relayer as `0x${string}`,
        })
        store.emit({ type: 'filled', tokenId, newOwner: relayer as `0x${string}` })
      }
    },
  })

  const unwatchSettled = ctx.publicClient.watchContractEvent({
    address,
    abi: MEANTIME_ABI,
    eventName: 'Settled',
    pollingInterval: 2_000,
    onError(err) { console.error('[watcher] Settled poll error:', err.message ?? err) },
    onLogs(logs) {
      for (const log of logs) {
        const { tokenId } = log.args
        if (tokenId === undefined) continue

        store.remove(tokenId)
        store.emit({ type: 'settled', tokenId })
      }
    },
  })

  return () => {
    unwatchMinted()
    unwatchListed()
    unwatchDelisted()
    unwatchFilled()
    unwatchSettled()
  }
}
