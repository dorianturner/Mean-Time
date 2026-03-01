// Tests for startWatcher: verifies that contract events update the store correctly.
// The new watcher uses getLogs polling (getContractEvents + getBlockNumber) instead
// of watchContractEvent, so we mock those two methods.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { startWatcher } from '../src/watcher.js'
import { createStore } from '../src/store.js'
import { mockCtx, makeReceivable } from './helpers.js'
import type { AppCtx } from '../src/ctx.js'

// Build a ctx whose publicClient returns the given logs for each event type.
// getBlockNumber always returns 1000n (so from=lastBlock+1 → first poll scans 995-1000).
function buildMockCtx(eventLogs: Partial<Record<string, unknown[]>> = {}) {
  const getContractEvents = vi.fn().mockImplementation(({ eventName }: { eventName: string }) =>
    Promise.resolve(eventLogs[eventName] ?? [])
  )
  const getBlockNumber = vi.fn().mockResolvedValue(1000n)

  const ctx = mockCtx({
    publicClient: { getBlockNumber, getContractEvents } as unknown as AppCtx['publicClient'],
  })

  return { ctx, getContractEvents, getBlockNumber }
}

// Build a synthetic log matching what viem's getContractEvents returns.
function makeLog(args: Record<string, unknown>, blockNumber = 200n) {
  return { args, blockNumber }
}

// Wait for the first async poll to complete.
async function waitForPoll() {
  // One tick for the microtask queue + a small buffer for the async poll chain.
  await new Promise(r => setTimeout(r, 20))
}

describe('startWatcher', () => {
  let store: ReturnType<typeof createStore>

  beforeEach(() => { store = createStore() })

  it('stops polling after stop() is called', async () => {
    const { ctx, getContractEvents } = buildMockCtx()
    const stop = startWatcher(ctx, store)
    await waitForPoll()
    const callsAfterFirstPoll = getContractEvents.mock.calls.length
    stop()
    // Give enough time that a second poll *would* have fired (poll interval = 2s,
    // but our fake timer doesn't advance, so no second poll should occur either way).
    await waitForPoll()
    // No new calls after stop
    expect(getContractEvents.mock.calls.length).toBe(callsAfterFirstPoll)
  })

  // ── Minted ──────────────────────────────────────────────────────────────────
  describe('Minted event', () => {
    it('inserts a receivable into the store', async () => {
      const { ctx } = buildMockCtx({
        Minted: [makeLog({ tokenId: 1n, recipient: '0xAlice', inboundToken: '0xUsdc', inboundAmount: 1_000_000n, cctpMessageHash: '0xhash1' })],
      })
      startWatcher(ctx, store)
      await waitForPoll()

      const r = store.get(1n)
      expect(r).toBeDefined()
      expect(r!.tokenId).toBe(1n)
      expect(r!.beneficialOwner).toBe('0xAlice')
      expect(r!.inboundAmount).toBe(1_000_000n)
      expect(r!.listing).toBeNull()
      expect(r!.mintedAt).toBe(200n)
    })

    it('emits a minted store event', async () => {
      const { ctx } = buildMockCtx({
        Minted: [makeLog({ tokenId: 1n, recipient: '0xAlice', inboundToken: '0xUsdc', inboundAmount: 1n, cctpMessageHash: '0xh' })],
      })
      startWatcher(ctx, store)
      const listener = vi.fn()
      store.subscribe(listener)
      await waitForPoll()

      expect(listener).toHaveBeenCalledOnce()
      expect(listener.mock.calls[0][0].type).toBe('minted')
    })

    it('handles multiple minted logs in one poll', async () => {
      const { ctx } = buildMockCtx({
        Minted: [
          makeLog({ tokenId: 1n, recipient: '0xAlice', inboundToken: '0xUsdc', inboundAmount: 1n, cctpMessageHash: '0xh1' }),
          makeLog({ tokenId: 2n, recipient: '0xBob',   inboundToken: '0xUsdc', inboundAmount: 2n, cctpMessageHash: '0xh2' }),
        ],
      })
      startWatcher(ctx, store)
      await waitForPoll()

      expect(store.snapshot()).toHaveLength(2)
    })

    it('skips logs with undefined tokenId', async () => {
      const { ctx } = buildMockCtx({
        Minted: [makeLog({ recipient: '0xAlice', inboundToken: '0xUsdc', inboundAmount: 1n, cctpMessageHash: '0xh' })],
      })
      startWatcher(ctx, store)
      await waitForPoll()

      expect(store.snapshot()).toHaveLength(0)
    })
  })

  // ── Listed ───────────────────────────────────────────────────────────────────
  describe('Listed event', () => {
    it('patches listing onto an existing receivable', async () => {
      store.upsert(makeReceivable(1n))
      const { ctx } = buildMockCtx({
        Listed: [makeLog({ tokenId: 1n, reservePrice: 990_000n, paymentToken: '0xEurc', listedAt: 150n })],
      })
      startWatcher(ctx, store)
      await waitForPoll()

      expect(store.get(1n)!.listing).toEqual({ reservePrice: 990_000n, paymentToken: '0xEurc' })
    })

    it('emits a listed store event', async () => {
      store.upsert(makeReceivable(1n))
      const { ctx } = buildMockCtx({
        Listed: [makeLog({ tokenId: 1n, reservePrice: 990_000n, paymentToken: '0xEurc', listedAt: 0n })],
      })
      startWatcher(ctx, store)
      const listener = vi.fn()
      store.subscribe(listener)
      await waitForPoll()

      expect(listener.mock.calls[0][0].type).toBe('listed')
    })
  })

  // ── Delisted ─────────────────────────────────────────────────────────────────
  describe('Delisted event', () => {
    it('removes listing from a receivable', async () => {
      store.upsert(makeReceivable(1n, {
        listing: { reservePrice: 990_000n, paymentToken: '0xEurc' as `0x${string}` },
      }))
      const { ctx } = buildMockCtx({ Delisted: [makeLog({ tokenId: 1n })] })
      startWatcher(ctx, store)
      await waitForPoll()

      expect(store.get(1n)!.listing).toBeNull()
    })

    it('emits a delisted event', async () => {
      store.upsert(makeReceivable(1n))
      const { ctx } = buildMockCtx({ Delisted: [makeLog({ tokenId: 1n })] })
      startWatcher(ctx, store)
      const listener = vi.fn()
      store.subscribe(listener)
      await waitForPoll()

      expect(listener.mock.calls[0][0].type).toBe('delisted')
    })
  })

  // ── Filled ───────────────────────────────────────────────────────────────────
  describe('Filled event', () => {
    it('updates beneficialOwner and clears listing', async () => {
      store.upsert(makeReceivable(1n, {
        beneficialOwner: '0xAlice' as `0x${string}`,
        listing: { reservePrice: 990_000n, paymentToken: '0xEurc' as `0x${string}` },
      }))
      const { ctx } = buildMockCtx({
        Filled: [makeLog({ tokenId: 1n, relayer: '0xRelayer', seller: '0xAlice', paymentToken: '0xEurc', amount: 990_000n })],
      })
      startWatcher(ctx, store)
      await waitForPoll()

      expect(store.get(1n)!.beneficialOwner).toBe('0xRelayer')
      expect(store.get(1n)!.listing).toBeNull()
    })

    it('emits a filled event with the new owner', async () => {
      store.upsert(makeReceivable(1n))
      const { ctx } = buildMockCtx({
        Filled: [makeLog({ tokenId: 1n, relayer: '0xRelayer', seller: '0xAlice', paymentToken: '0xEurc', amount: 1n })],
      })
      startWatcher(ctx, store)
      const listener = vi.fn()
      store.subscribe(listener)
      await waitForPoll()

      const event = listener.mock.calls[0][0]
      expect(event.type).toBe('filled')
      expect(event.newOwner).toBe('0xRelayer')
    })
  })

  // ── Settled ──────────────────────────────────────────────────────────────────
  describe('Settled event', () => {
    it('removes the receivable from the store', async () => {
      store.upsert(makeReceivable(1n))
      const { ctx } = buildMockCtx({
        Settled: [makeLog({ tokenId: 1n, recipient: '0xAlice', inboundToken: '0xUsdc', amount: 1n })],
      })
      startWatcher(ctx, store)
      await waitForPoll()

      expect(store.get(1n)).toBeUndefined()
      expect(store.snapshot()).toHaveLength(0)
    })

    it('emits a settled event', async () => {
      store.upsert(makeReceivable(1n))
      const { ctx } = buildMockCtx({
        Settled: [makeLog({ tokenId: 1n, recipient: '0xAlice', inboundToken: '0xUsdc', amount: 1n })],
      })
      startWatcher(ctx, store)
      const listener = vi.fn()
      store.subscribe(listener)
      await waitForPoll()

      const event = listener.mock.calls[0][0]
      expect(event.type).toBe('settled')
      expect(event.tokenId).toBe(1n)
    })
  })
})
