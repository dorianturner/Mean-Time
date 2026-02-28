// Tests for startWatcher: verifies that contract events update the store correctly.
// Approach: mock publicClient.watchContractEvent to capture the onLogs callback
// for each event type, then invoke it with synthetic log data and assert store state.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { startWatcher } from '../src/watcher.js'
import { createStore } from '../src/store.js'
import { mockCtx, makeReceivable } from './helpers.js'
import type { AppCtx } from '../src/ctx.js'

// Build a mock ctx that captures event handlers indexed by eventName
function buildMockCtx() {
  const handlers: Record<string, (logs: unknown[]) => void> = {}
  const unwatchFns: ReturnType<typeof vi.fn>[] = []

  const ctx = mockCtx({
    publicClient: {
      watchContractEvent: vi.fn(({ eventName, onLogs }: { eventName: string; onLogs: (logs: unknown[]) => void }) => {
        handlers[eventName] = onLogs
        const unwatch = vi.fn()
        unwatchFns.push(unwatch)
        return unwatch
      }),
    } as unknown as AppCtx['publicClient'],
  })

  return { ctx, handlers, unwatchFns }
}

// Build a synthetic log object matching what viem emits
function makeLog(eventName: string, args: Record<string, unknown>, blockNumber = 200n) {
  return { args, blockNumber, event: eventName }
}

describe('startWatcher', () => {
  let store: ReturnType<typeof createStore>

  beforeEach(() => { store = createStore() })

  it('subscribes to all 5 contract events', () => {
    const { ctx } = buildMockCtx()
    startWatcher(ctx, store)
    expect(ctx.publicClient.watchContractEvent).toHaveBeenCalledTimes(5)
    const names = (ctx.publicClient.watchContractEvent as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: [{ eventName: string }]) => c[0].eventName
    )
    expect(names.sort()).toEqual(['Delisted', 'Filled', 'Listed', 'Minted', 'Settled'])
  })

  it('cleanup fn calls all five unwatch functions', () => {
    const { ctx, unwatchFns } = buildMockCtx()
    const stop = startWatcher(ctx, store)
    stop()
    expect(unwatchFns).toHaveLength(5)
    for (const fn of unwatchFns) expect(fn).toHaveBeenCalledOnce()
  })

  // ── Minted ──────────────────────────────────────────────────────────────────
  describe('Minted event', () => {
    it('inserts a receivable into the store', () => {
      const { ctx, handlers } = buildMockCtx()
      startWatcher(ctx, store)

      handlers['Minted']([makeLog('Minted', {
        tokenId:         1n,
        recipient:       '0xAlice',
        inboundToken:    '0xUsdc',
        inboundAmount:   1_000_000n,
        cctpMessageHash: '0xhash1',
      })])

      const r = store.get(1n)
      expect(r).toBeDefined()
      expect(r!.tokenId).toBe(1n)
      expect(r!.beneficialOwner).toBe('0xAlice')
      expect(r!.inboundAmount).toBe(1_000_000n)
      expect(r!.listing).toBeNull()
      expect(r!.mintedAt).toBe(200n)
    })

    it('emits a minted store event', () => {
      const { ctx, handlers } = buildMockCtx()
      startWatcher(ctx, store)
      const listener = vi.fn()
      store.subscribe(listener)

      handlers['Minted']([makeLog('Minted', {
        tokenId: 1n, recipient: '0xAlice',
        inboundToken: '0xUsdc', inboundAmount: 1_000_000n, cctpMessageHash: '0xh',
      })])

      expect(listener).toHaveBeenCalledOnce()
      expect(listener.mock.calls[0][0].type).toBe('minted')
    })

    it('handles batch of multiple minted logs', () => {
      const { ctx, handlers } = buildMockCtx()
      startWatcher(ctx, store)

      handlers['Minted']([
        makeLog('Minted', { tokenId: 1n, recipient: '0xAlice', inboundToken: '0xUsdc', inboundAmount: 1n, cctpMessageHash: '0xh1' }),
        makeLog('Minted', { tokenId: 2n, recipient: '0xBob',   inboundToken: '0xUsdc', inboundAmount: 2n, cctpMessageHash: '0xh2' }),
      ])

      expect(store.snapshot()).toHaveLength(2)
    })

    it('skips logs with undefined tokenId', () => {
      const { ctx, handlers } = buildMockCtx()
      startWatcher(ctx, store)

      handlers['Minted']([makeLog('Minted', { recipient: '0xAlice', inboundToken: '0xUsdc', inboundAmount: 1n, cctpMessageHash: '0xh' })])

      expect(store.snapshot()).toHaveLength(0)
    })
  })

  // ── Listed ───────────────────────────────────────────────────────────────────
  describe('Listed event', () => {
    it('patches listing onto an existing receivable', () => {
      const { ctx, handlers } = buildMockCtx()
      startWatcher(ctx, store)
      store.upsert(makeReceivable(1n))

      handlers['Listed']([makeLog('Listed', {
        tokenId:      1n,
        reservePrice: 990_000n,
        paymentToken: '0xEurc',
        listedAt:     150n,
      })])

      const r = store.get(1n)!
      expect(r.listing).toEqual({ reservePrice: 990_000n, paymentToken: '0xEurc' })
    })

    it('emits a listed store event', () => {
      const { ctx, handlers } = buildMockCtx()
      startWatcher(ctx, store)
      store.upsert(makeReceivable(1n))
      const listener = vi.fn()
      store.subscribe(listener)

      handlers['Listed']([makeLog('Listed', { tokenId: 1n, reservePrice: 990_000n, paymentToken: '0xEurc', listedAt: 0n })])

      expect(listener.mock.calls[0][0].type).toBe('listed')
    })
  })

  // ── Delisted ─────────────────────────────────────────────────────────────────
  describe('Delisted event', () => {
    it('removes listing from a receivable', () => {
      const { ctx, handlers } = buildMockCtx()
      startWatcher(ctx, store)
      store.upsert(makeReceivable(1n, {
        listing: { reservePrice: 990_000n, paymentToken: '0xEurc' as `0x${string}` },
      }))

      handlers['Delisted']([makeLog('Delisted', { tokenId: 1n })])

      expect(store.get(1n)!.listing).toBeNull()
    })

    it('emits a delisted event', () => {
      const { ctx, handlers } = buildMockCtx()
      startWatcher(ctx, store)
      store.upsert(makeReceivable(1n))
      const listener = vi.fn()
      store.subscribe(listener)

      handlers['Delisted']([makeLog('Delisted', { tokenId: 1n })])

      expect(listener.mock.calls[0][0].type).toBe('delisted')
    })
  })

  // ── Filled ───────────────────────────────────────────────────────────────────
  describe('Filled event', () => {
    it('updates beneficialOwner and clears listing', () => {
      const { ctx, handlers } = buildMockCtx()
      startWatcher(ctx, store)
      store.upsert(makeReceivable(1n, {
        beneficialOwner: '0xAlice' as `0x${string}`,
        listing: { reservePrice: 990_000n, paymentToken: '0xEurc' as `0x${string}` },
      }))

      handlers['Filled']([makeLog('Filled', {
        tokenId: 1n,
        relayer: '0xRelayer',
        seller:  '0xAlice',
        paymentToken: '0xEurc',
        amount: 990_000n,
      })])

      const r = store.get(1n)!
      expect(r.beneficialOwner).toBe('0xRelayer')
      expect(r.listing).toBeNull()
    })

    it('emits a filled event with the new owner', () => {
      const { ctx, handlers } = buildMockCtx()
      startWatcher(ctx, store)
      store.upsert(makeReceivable(1n))
      const listener = vi.fn()
      store.subscribe(listener)

      handlers['Filled']([makeLog('Filled', {
        tokenId: 1n, relayer: '0xRelayer', seller: '0xAlice', paymentToken: '0xEurc', amount: 1n,
      })])

      const event = listener.mock.calls[0][0]
      expect(event.type).toBe('filled')
      expect(event.newOwner).toBe('0xRelayer')
    })
  })

  // ── Settled ──────────────────────────────────────────────────────────────────
  describe('Settled event', () => {
    it('removes the receivable from the store', () => {
      const { ctx, handlers } = buildMockCtx()
      startWatcher(ctx, store)
      store.upsert(makeReceivable(1n))

      handlers['Settled']([makeLog('Settled', { tokenId: 1n, recipient: '0xAlice', inboundToken: '0xUsdc', amount: 1n })])

      expect(store.get(1n)).toBeUndefined()
      expect(store.snapshot()).toHaveLength(0)
    })

    it('emits a settled event', () => {
      const { ctx, handlers } = buildMockCtx()
      startWatcher(ctx, store)
      store.upsert(makeReceivable(1n))
      const listener = vi.fn()
      store.subscribe(listener)

      handlers['Settled']([makeLog('Settled', { tokenId: 1n, recipient: '0xAlice', inboundToken: '0xUsdc', amount: 1n })])

      const event = listener.mock.calls[0][0]
      expect(event.type).toBe('settled')
      expect(event.tokenId).toBe(1n)
    })
  })
})
