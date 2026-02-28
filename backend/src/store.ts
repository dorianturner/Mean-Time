// In-memory state for active receivables.
// Updated by watcher.ts when contract events arrive.

export interface Listing {
  reservePrice: bigint
  paymentToken: `0x${string}`
}

export interface Receivable {
  tokenId:         bigint
  cctpMessageHash: `0x${string}`
  inboundToken:    `0x${string}`
  inboundAmount:   bigint
  mintedAt:        bigint
  beneficialOwner: `0x${string}`
  listing:         Listing | null
}

export type StoreEvent =
  | { type: 'minted';   receivable: Receivable }
  | { type: 'listed';   tokenId: bigint; listing: Listing }
  | { type: 'delisted'; tokenId: bigint }
  | { type: 'filled';   tokenId: bigint; newOwner: `0x${string}` }
  | { type: 'settled';  tokenId: bigint }

export interface Store {
  get(tokenId: bigint): Receivable | undefined
  snapshot(): Receivable[]
  upsert(r: Receivable): void
  patch(tokenId: bigint, update: Partial<Receivable>): void
  remove(tokenId: bigint): void
  subscribe(fn: (event: StoreEvent) => void): () => void
  emit(event: StoreEvent): void
}

export function createStore(): Store {
  const receivables = new Map<bigint, Receivable>()
  const subscribers = new Set<(event: StoreEvent) => void>()

  return {
    get(tokenId) {
      return receivables.get(tokenId)
    },
    snapshot() {
      return Array.from(receivables.values())
    },
    upsert(r) {
      receivables.set(r.tokenId, r)
    },
    patch(tokenId, update) {
      const existing = receivables.get(tokenId)
      if (existing) {
        receivables.set(tokenId, { ...existing, ...update })
      }
    },
    remove(tokenId) {
      receivables.delete(tokenId)
    },
    subscribe(fn) {
      subscribers.add(fn)
      return () => subscribers.delete(fn)
    },
    emit(event) {
      for (const fn of subscribers) {
        try { fn(event) } catch { /* never crash the watcher */ }
      }
    },
  }
}

// Serialize a Receivable to a plain JSON-safe object (bigints → strings)
export function serializeReceivable(r: Receivable) {
  return {
    tokenId:         r.tokenId.toString(),
    cctpMessageHash: r.cctpMessageHash,
    inboundToken:    r.inboundToken,
    inboundAmount:   r.inboundAmount.toString(),
    mintedAt:        r.mintedAt.toString(),
    beneficialOwner: r.beneficialOwner,
    listing:         r.listing
      ? {
          reservePrice: r.listing.reservePrice.toString(),
          paymentToken: r.listing.paymentToken,
        }
      : null,
  }
}
