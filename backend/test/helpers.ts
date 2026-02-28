// Shared test helpers: mock AppCtx and fixture factory

import { vi } from 'vitest'
import type { AppCtx } from '../src/ctx.js'
import type { Receivable } from '../src/store.js'

export function mockCtx(overrides: Partial<AppCtx> = {}): AppCtx {
  return {
    publicClient: {
      watchContractEvent: vi.fn(() => vi.fn()), // returns unwatch fn
    } as unknown as AppCtx['publicClient'],
    walletClient: {
      writeContract: vi.fn().mockResolvedValue('0xdeadbeeftxhash'),
    } as unknown as AppCtx['walletClient'],
    account: { address: '0xBridgeAddress' } as AppCtx['account'],
    addresses: {
      meantime: '0xMeantimeAddress',
      usdc:     '0xUsdcAddress',
      eurc:     '0xEurcAddress',
      bridge:   '0xBridgeAddress',
    },
    ...overrides,
  }
}

// Build a minimal Receivable fixture (all fields required)
export function makeReceivable(n: bigint = 1n, overrides: Partial<Receivable> = {}): Receivable {
  return {
    tokenId:         n,
    cctpMessageHash: `0xcctphash${n}` as `0x${string}`,
    inboundToken:    '0xUsdcAddress' as `0x${string}`,
    inboundAmount:   1_000_000n * n,   // n USDC (6 decimals)
    mintedAt:        100n,
    beneficialOwner: '0xAliceAddress' as `0x${string}`,
    listing:         null,
    ...overrides,
  }
}
