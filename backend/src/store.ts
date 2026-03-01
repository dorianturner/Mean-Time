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
  /** Record a CCTP message hash as known (minted or settled). */
  markKnown(hash: string): void
  /** True if the hash was ever minted (even if later settled). */
  isKnown(hash: string): boolean
}

export function createStore(): Store {
  const receivables = new Map<bigint, Receivable>()
  const subscribers = new Set<(event: StoreEvent) => void>()
  const knownHashes = new Set<string>()

  return {
    get(tokenId) {
      return receivables.get(tokenId)
    },
    snapshot() {
      return Array.from(receivables.values())
    },
    upsert(r) {
      receivables.set(r.tokenId, r)
      knownHashes.add(r.cctpMessageHash.toLowerCase())
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
    markKnown(hash: string) {
      knownHashes.add(hash.toLowerCase())
    },
    isKnown(hash: string) {
      return knownHashes.has(hash.toLowerCase())
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
