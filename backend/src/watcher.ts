// Watches MeanTime contract events and keeps the Store in sync.
// Returns a cleanup function that unsubscribes all watchers.

import { type AppCtx } from './ctx.js'
import { type Store } from './store.js'
import { MEANTIME_ABI } from './abi.js'

export function startWatcher(ctx: AppCtx, store: Store): () => void {
  const address = ctx.addresses.meantime

  const unwatchMinted = ctx.publicClient.watchContractEvent({
    address,
    abi: MEANTIME_ABI,
    eventName: 'Minted',
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
    onLogs(logs) {
      for (const log of logs) {
        const { tokenId } = log.args
        if (tokenId === undefined) continue

        store.patch(tokenId, { listing: null })
        store.emit({ type: 'delisted', tokenId })
      }
    },
  })

  const unwatchFilled = ctx.publicClient.watchContractEvent({
    address,
    abi: MEANTIME_ABI,
    eventName: 'Filled',
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
