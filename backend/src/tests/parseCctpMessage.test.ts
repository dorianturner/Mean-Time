import { describe, it, expect } from 'vitest'
import { parseCctpMessage } from '../sepoliaWatcher.js'

// Build a minimal CCTP v1 message manually.
// Header (116 bytes):
//   0-3:   version        = 0
//   4-7:   sourceDomain   = 0  (Sepolia)
//   8-11:  destDomain     = 7  (Arc)
//   12-19: nonce          = 1
//   20-51: sender         = 32 bytes
//   52-83: recipient      = 32 bytes
//   84-115: destinationCaller = 32 bytes (zeros)
//
// BurnMessage body (starting at 116):
//   0-3:   version        = 0
//   4-35:  burnToken      = 32 bytes (USDC address, left-padded)
//   36-67: mintRecipient  = 32 bytes (MeanTime address, left-padded)
//   68-99: amount         = 32 bytes (1 USDC = 1_000_000)
//  100-131: messageSender = 32 bytes (user wallet address, left-padded)

function buildTestMessage(opts: {
  destDomain: number
  mintRecipient: string   // 20-byte hex, no 0x
  amount: bigint
  messageSender: string   // 20-byte hex, no 0x
}): `0x${string}` {
  const buf = Buffer.alloc(116 + 132, 0)  // header + burn message

  // Header
  buf.writeUInt32BE(0, 0)           // version
  buf.writeUInt32BE(0, 4)           // sourceDomain (Sepolia)
  buf.writeUInt32BE(opts.destDomain, 8)
  buf.writeBigUInt64BE(1n, 12)      // nonce

  // BurnMessage at offset 116
  buf.writeUInt32BE(0, 116)         // version

  // mintRecipient at body+36 (bytes 152-183, right-justified in 32 bytes)
  const recip = Buffer.from(opts.mintRecipient.replace('0x', '').padStart(64, '0'), 'hex')
  recip.copy(buf, 116 + 36)

  // amount at body+68 (bytes 184-215)
  const amtHex = opts.amount.toString(16).padStart(64, '0')
  Buffer.from(amtHex, 'hex').copy(buf, 116 + 68)

  // messageSender at body+100 (bytes 216-247)
  const sender = Buffer.from(opts.messageSender.replace('0x', '').padStart(64, '0'), 'hex')
  sender.copy(buf, 116 + 100)

  return `0x${buf.toString('hex')}` as `0x${string}`
}

const MEANTIME = '0x0769d1d0662894dC29cdADE1102411D2a059cc1c'
const WALLET_A = '0xAbCd000000000000000000000000000000001234'

describe('parseCctpMessage', () => {
  it('extracts destDomain=7', () => {
    const msg = buildTestMessage({
      destDomain:    7,
      mintRecipient: MEANTIME,
      amount:        1_000_000n,
      messageSender: WALLET_A,
    })
    const result = parseCctpMessage(msg)
    expect(result.destDomain).toBe(7)
  })

  it('extracts mintRecipient correctly (left-padded address)', () => {
    const msg = buildTestMessage({
      destDomain:    7,
      mintRecipient: MEANTIME,
      amount:        1_000_000n,
      messageSender: WALLET_A,
    })
    const result = parseCctpMessage(msg)
    expect(result.mintRecipient.toLowerCase()).toBe(MEANTIME.toLowerCase())
  })

  it('extracts amount in base units', () => {
    const msg = buildTestMessage({
      destDomain:    7,
      mintRecipient: MEANTIME,
      amount:        500_000_000n,  // 500 USDC
      messageSender: WALLET_A,
    })
    const result = parseCctpMessage(msg)
    expect(result.amount).toBe(500_000_000n)
  })

  it('extracts messageSender', () => {
    const msg = buildTestMessage({
      destDomain:    7,
      mintRecipient: MEANTIME,
      amount:        1_000_000n,
      messageSender: WALLET_A,
    })
    const result = parseCctpMessage(msg)
    expect(result.messageSender.toLowerCase()).toBe(WALLET_A.toLowerCase())
  })

  it('correctly identifies non-Arc destDomain', () => {
    const msg = buildTestMessage({
      destDomain:    1,  // Ethereum mainnet, not Arc
      mintRecipient: MEANTIME,
      amount:        1_000_000n,
      messageSender: WALLET_A,
    })
    const result = parseCctpMessage(msg)
    expect(result.destDomain).toBe(1)
    expect(result.destDomain).not.toBe(7)
  })
})
