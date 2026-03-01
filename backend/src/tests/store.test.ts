import { describe, it, expect } from 'vitest'
import { createStore, serializeReceivable, type Receivable } from '../store.js'

const BASE: Receivable = {
  tokenId:         1n,
  cctpMessageHash: '0xaabbccdd00000000000000000000000000000000000000000000000000000000',
  inboundToken:    '0x1111111111111111111111111111111111111111',
  inboundAmount:   1_000_000n,
  mintedAt:        1000n,
  beneficialOwner: '0xaaaa000000000000000000000000000000000001',
  listing:         null,
}

describe('Store', () => {
  it('upsert and get', () => {
    const store = createStore()
    store.upsert(BASE)
    expect(store.get(1n)).toEqual(BASE)
  })

  it('patch updates fields', () => {
    const store = createStore()
    store.upsert(BASE)
    const listing = { reservePrice: 990_000n, paymentToken: '0x2222222222222222222222222222222222222222' as `0x${string}` }
    store.patch(1n, { listing })
    expect(store.get(1n)?.listing).toEqual(listing)
    expect(store.get(1n)?.inboundAmount).toBe(1_000_000n)  // unchanged
  })

  it('patch on missing tokenId does nothing', () => {
    const store = createStore()
    store.patch(99n, { inboundAmount: 999n })
    expect(store.get(99n)).toBeUndefined()
  })

  it('remove deletes entry', () => {
    const store = createStore()
    store.upsert(BASE)
    store.remove(1n)
    expect(store.get(1n)).toBeUndefined()
    expect(store.snapshot()).toHaveLength(0)
  })

  it('snapshot returns all receivables', () => {
    const store = createStore()
    store.upsert(BASE)
    store.upsert({ ...BASE, tokenId: 2n })
    expect(store.snapshot()).toHaveLength(2)
  })

  it('emit calls all subscribers', () => {
    const store = createStore()
    const events: string[] = []
    store.subscribe(e => events.push(e.type))
    store.emit({ type: 'minted', receivable: BASE })
    store.emit({ type: 'settled', tokenId: 1n })
    expect(events).toEqual(['minted', 'settled'])
  })

  it('unsubscribe stops receiving events', () => {
    const store = createStore()
    const events: string[] = []
    const unsub = store.subscribe(e => events.push(e.type))
    store.emit({ type: 'minted', receivable: BASE })
    unsub()
    store.emit({ type: 'settled', tokenId: 1n })
    expect(events).toEqual(['minted'])
  })
})

describe('serializeReceivable', () => {
  it('converts bigints to strings', () => {
    const r = { ...BASE }
    const s = serializeReceivable(r)
    expect(typeof s.tokenId).toBe('string')
    expect(typeof s.inboundAmount).toBe('string')
    expect(s.tokenId).toBe('1')
    expect(s.inboundAmount).toBe('1000000')
    expect(s.listing).toBeNull()
  })

  it('serializes listing correctly', () => {
    const r = {
      ...BASE,
      listing: { reservePrice: 990_000n, paymentToken: '0x2222222222222222222222222222222222222222' as `0x${string}` },
    }
    const s = serializeReceivable(r)
    expect(s.listing?.reservePrice).toBe('990000')
    expect(s.listing?.paymentToken).toBe('0x2222222222222222222222222222222222222222')
  })
})
