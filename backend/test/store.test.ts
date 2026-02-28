import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createStore, serializeReceivable, type StoreEvent } from '../src/store.js'
import { makeReceivable } from './helpers.js'

describe('createStore', () => {
  let store: ReturnType<typeof createStore>

  beforeEach(() => { store = createStore() })

  // ── get / upsert ────────────────────────────────────────────────────────────
  it('returns undefined for a missing tokenId', () => {
    expect(store.get(1n)).toBeUndefined()
  })

  it('upsert stores and get retrieves a receivable', () => {
    const r = makeReceivable(1n)
    store.upsert(r)
    expect(store.get(1n)).toEqual(r)
  })

  it('upsert overwrites an existing entry', () => {
    store.upsert(makeReceivable(1n))
    const updated = makeReceivable(1n, { mintedAt: 999n })
    store.upsert(updated)
    expect(store.get(1n)!.mintedAt).toBe(999n)
  })

  // ── snapshot ─────────────────────────────────────────────────────────────────
  it('snapshot returns empty array when store is empty', () => {
    expect(store.snapshot()).toEqual([])
  })

  it('snapshot returns all inserted receivables', () => {
    store.upsert(makeReceivable(1n))
    store.upsert(makeReceivable(2n))
    const snap = store.snapshot()
    expect(snap).toHaveLength(2)
    expect(snap.map(r => r.tokenId).sort()).toEqual([1n, 2n])
  })

  // ── patch ────────────────────────────────────────────────────────────────────
  it('patch updates specific fields on an existing receivable', () => {
    store.upsert(makeReceivable(1n))
    store.patch(1n, {
      listing: { reservePrice: 990_000n, paymentToken: '0xEurcAddress' as `0x${string}` },
    })
    expect(store.get(1n)!.listing).toEqual({
      reservePrice: 990_000n,
      paymentToken: '0xEurcAddress',
    })
  })

  it('patch is a no-op for a missing tokenId', () => {
    store.patch(99n, { mintedAt: 1n })
    expect(store.get(99n)).toBeUndefined()
  })

  it('patch preserves fields that were not patched', () => {
    store.upsert(makeReceivable(1n, { inboundAmount: 5_000_000n }))
    store.patch(1n, { beneficialOwner: '0xBobAddress' as `0x${string}` })
    const r = store.get(1n)!
    expect(r.inboundAmount).toBe(5_000_000n)
    expect(r.beneficialOwner).toBe('0xBobAddress')
  })

  // ── remove ───────────────────────────────────────────────────────────────────
  it('remove deletes a receivable from the store', () => {
    store.upsert(makeReceivable(1n))
    store.remove(1n)
    expect(store.get(1n)).toBeUndefined()
    expect(store.snapshot()).toHaveLength(0)
  })

  it('remove is a no-op for a missing tokenId', () => {
    expect(() => store.remove(99n)).not.toThrow()
  })

  // ── subscribe / emit ─────────────────────────────────────────────────────────
  it('emit calls all subscribers with the event', () => {
    const fn1 = vi.fn()
    const fn2 = vi.fn()
    store.subscribe(fn1)
    store.subscribe(fn2)

    const event: StoreEvent = { type: 'settled', tokenId: 1n }
    store.emit(event)

    expect(fn1).toHaveBeenCalledOnce()
    expect(fn1).toHaveBeenCalledWith(event)
    expect(fn2).toHaveBeenCalledOnce()
  })

  it('unsubscribe prevents further callbacks', () => {
    const fn = vi.fn()
    const unsub = store.subscribe(fn)
    store.emit({ type: 'settled', tokenId: 1n })
    unsub()
    store.emit({ type: 'settled', tokenId: 2n })
    expect(fn).toHaveBeenCalledOnce()
  })

  it('a subscriber that throws does not crash the watcher', () => {
    store.subscribe(() => { throw new Error('boom') })
    const safe = vi.fn()
    store.subscribe(safe)

    expect(() => store.emit({ type: 'settled', tokenId: 1n })).not.toThrow()
    expect(safe).toHaveBeenCalledOnce()
  })

  it('emit with no subscribers is a no-op', () => {
    expect(() => store.emit({ type: 'settled', tokenId: 1n })).not.toThrow()
  })
})

// ── serializeReceivable ────────────────────────────────────────────────────────
describe('serializeReceivable', () => {
  it('converts all bigint fields to strings', () => {
    const r = makeReceivable(3n, {
      inboundAmount: 5_000_000n,
      mintedAt: 12345n,
    })
    const s = serializeReceivable(r)
    expect(s.tokenId).toBe('3')
    expect(s.inboundAmount).toBe('5000000')
    expect(s.mintedAt).toBe('12345')
    expect(s.listing).toBeNull()
  })

  it('serializes an active listing', () => {
    const r = makeReceivable(1n, {
      listing: { reservePrice: 990_000n, paymentToken: '0xEurcAddress' as `0x${string}` },
    })
    const s = serializeReceivable(r)
    expect(s.listing).toEqual({
      reservePrice: '990000',
      paymentToken: '0xEurcAddress',
    })
  })
})
