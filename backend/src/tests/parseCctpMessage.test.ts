import { describe, it, expect } from 'vitest'
import { parseCctpMessage } from '../sepoliaWatcher.js'

// Build a minimal CCTP V2 message manually.
// Header (148 bytes):
//   0-3:   version            = 0
//   4-7:   sourceDomain       = 0  (Sepolia)
//   8-11:  destDomain         = 26 (Arc)
//   12-43: nonce              = 32 bytes (V2: was 8 bytes in V1)
//   44-75: sender             = 32 bytes
//   76-107: recipient         = 32 bytes
//  108-139: destinationCaller = 32 bytes (zeros)
//  140-143: minFinality       = 4 bytes
//  144-147: finalityExecuted  = 4 bytes
//
// BurnMessage body (starting at 148):
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
  const headerSize = 148
  const buf = Buffer.alloc(headerSize + 132, 0)  // header + burn message

  // Header
  buf.writeUInt32BE(0, 0)                // version
  buf.writeUInt32BE(0, 4)                // sourceDomain (Sepolia)
  buf.writeUInt32BE(opts.destDomain, 8)  // destDomain
  // nonce: 32 bytes at offset 12 (leave as zeros)
  // sender: 32 bytes at offset 44 (leave as zeros)
  // recipient: 32 bytes at offset 76 (leave as zeros)
  // destinationCaller: 32 bytes at offset 108 (leave as zeros)
  buf.writeUInt32BE(2000, 140)           // minFinality (Standard Transfer)
  buf.writeUInt32BE(0, 144)              // finalityExecuted

  // BurnMessage at offset 148
  buf.writeUInt32BE(0, headerSize)       // version

  // mintRecipient at body+36 (right-justified in 32 bytes)
  const recip = Buffer.from(opts.mintRecipient.replace('0x', '').padStart(64, '0'), 'hex')
  recip.copy(buf, headerSize + 36)

  // amount at body+68
  const amtHex = opts.amount.toString(16).padStart(64, '0')
  Buffer.from(amtHex, 'hex').copy(buf, headerSize + 68)

  // messageSender at body+100
  const sender = Buffer.from(opts.messageSender.replace('0x', '').padStart(64, '0'), 'hex')
  sender.copy(buf, headerSize + 100)

  return `0x${buf.toString('hex')}` as `0x${string}`
}

const MEANTIME = '0x0769d1d0662894dC29cdADE1102411D2a059cc1c'
const WALLET_A = '0xAbCd000000000000000000000000000000001234'

describe('parseCctpMessage', () => {
  it('extracts destDomain=26 (Arc)', () => {
    const msg = buildTestMessage({
      destDomain:    26,
      mintRecipient: MEANTIME,
      amount:        1_000_000n,
      messageSender: WALLET_A,
    })
    const result = parseCctpMessage(msg)
    expect(result.destDomain).toBe(26)
  })

  it('extracts mintRecipient correctly (left-padded address)', () => {
    const msg = buildTestMessage({
      destDomain:    26,
      mintRecipient: MEANTIME,
      amount:        1_000_000n,
      messageSender: WALLET_A,
    })
    const result = parseCctpMessage(msg)
    expect(result.mintRecipient.toLowerCase()).toBe(MEANTIME.toLowerCase())
  })

  it('extracts amount in base units', () => {
    const msg = buildTestMessage({
      destDomain:    26,
      mintRecipient: MEANTIME,
      amount:        500_000_000n,  // 500 USDC
      messageSender: WALLET_A,
    })
    const result = parseCctpMessage(msg)
    expect(result.amount).toBe(500_000_000n)
  })

  it('extracts messageSender', () => {
    const msg = buildTestMessage({
      destDomain:    26,
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
    expect(result.destDomain).not.toBe(26)
  })
})
