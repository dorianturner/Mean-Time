// Watches Sepolia's CCTP MessageTransmitter for MessageSent events
// that are destined for Arc (domain 7) with mintRecipient = MeanTime contract.
// When found: calls MeanTime.mint() on Arc immediately (optimistic),
// then starts polling Circle's attestation API for settlement.
//
// Uses getLogs polling instead of eth_newFilter since many public RPCs
// don't support persistent filters.

import { keccak256, decodeEventLog, parseAbiItem } from 'viem'
import { type AppCtx, SEPOLIA_CCTP, ARC_CCTP } from './ctx.js'
import { type Store } from './store.js'
import { MEANTIME_ABI } from './abi.js'
import { pollAttestation } from './attestationPoller.js'

const MESSAGE_SENT_EVENT = parseAbiItem('event MessageSent(bytes message)')

// 30-second polling interval for Sepolia
const POLL_INTERVAL_MS = 30_000
// Process up to 2000 blocks per poll (~6.5 hours on Sepolia at 12s/block)
const BLOCKS_PER_POLL = 2000n

/**
 * Parse the raw CCTP message bytes to extract key fields.
 * CCTP v1 message format (big-endian):
 *   0:  version        (4 bytes)
 *   4:  sourceDomain   (4 bytes)
 *   8:  destDomain     (4 bytes)
 *   12: nonce          (8 bytes)
 *   20: sender         (32 bytes)
 *   52: recipient      (32 bytes)
 *   84: destinationCaller (32 bytes)
 *  116: messageBody    (remaining bytes)
 *
 * BurnMessage body format (starting at offset 116):
 *   0:  version        (4 bytes)
 *   4:  burnToken      (32 bytes)
 *   36: mintRecipient  (32 bytes)
 *   68: amount         (32 bytes)
 *  100: messageSender  (32 bytes)
 */
export function parseCctpMessage(messageHex: `0x${string}`) {
  const buf = Buffer.from(messageHex.slice(2), 'hex')
  const bodyOffset = 116

  const destDomain     = buf.readUInt32BE(8)
  const mintRecipHex   = buf.slice(bodyOffset + 36, bodyOffset + 68).toString('hex')
  const mintRecipient  = ('0x' + mintRecipHex.slice(-40)) as `0x${string}`
  const amountBuf      = buf.slice(bodyOffset + 68, bodyOffset + 100)
  const amount         = BigInt('0x' + amountBuf.toString('hex'))
  const senderHex      = buf.slice(bodyOffset + 100, bodyOffset + 132).toString('hex')
  const messageSender  = ('0x' + senderHex.slice(-40)) as `0x${string}`

  return { destDomain, mintRecipient, amount, messageSender }
}

export function startSepoliaWatcher(ctx: AppCtx, store: Store): () => void {
  let stopped = false
  let lastBlock: bigint | null = null

  const meantimeLower = ctx.addresses.meantime.toLowerCase()
  console.log('[sepolia-watcher] Watching Sepolia for Arc-bound CCTP burns…')
  console.log(`[sepolia-watcher] MeanTime = ${ctx.addresses.meantime} | Arc domain = ${ARC_CCTP.domain}`)

  const poll = async () => {
    if (stopped) return
    try {
      const latest = await ctx.sepoliaClient.getBlockNumber()
      const from   = lastBlock !== null ? lastBlock + 1n : latest - BLOCKS_PER_POLL
      const to     = latest

      if (from > to) {
        scheduleNext()
        return
      }

      const logs = await ctx.sepoliaClient.getLogs({
        address:   SEPOLIA_CCTP.messageTransmitter,
        event:     MESSAGE_SENT_EVENT,
        fromBlock: from,
        toBlock:   to,
      })

      if (logs.length > 0) {
        console.log(`[sepolia-watcher] Found ${logs.length} MessageSent log(s) in blocks ${from}–${to}`)
      }

      for (const log of logs) {
        try {
          const decoded = decodeEventLog({
            abi:       [MESSAGE_SENT_EVENT],
            eventName: 'MessageSent',
            data:      log.data,
            topics:    log.topics as [`0x${string}`, ...`0x${string}`[]],
          })
          const messageBytes = decoded.args.message as `0x${string}`
          const parsed = parseCctpMessage(messageBytes)
          if (parsed.destDomain !== ARC_CCTP.domain) continue
          if (parsed.mintRecipient.toLowerCase() !== meantimeLower) continue

          const messageHash  = keccak256(messageBytes)
          const inboundToken = ARC_CCTP.usdc || ctx.addresses.usdc
          const recipient    = parsed.messageSender ?? ctx.account.address

          console.log(`[sepolia-watcher] CCTP burn! hash=${messageHash} amount=${parsed.amount}`)
          await mintOnArc(ctx, messageHash, inboundToken, parsed.amount, recipient)
          pollAttestation(ctx, store, messageHash, messageBytes).catch(err =>
            console.error('[sepolia-watcher] Attestation poller error:', err),
          )
        } catch (err) {
          console.error('[sepolia-watcher] Log processing error:', err)
        }
      }

      lastBlock = to
    } catch (err) {
      console.warn('[sepolia-watcher] Poll error:', (err as Error)?.message ?? err)
    }
    scheduleNext()
  }

  let timer: ReturnType<typeof setTimeout>
  const scheduleNext = () => {
    if (!stopped) timer = setTimeout(poll, POLL_INTERVAL_MS)
  }

  poll() // first poll immediately
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}

/**
 * Manually track a CCTP transfer by Sepolia tx hash.
 * Called from POST /api/bridge/initiate-cctp.
 */
export async function trackSepoliaTx(
  ctx: AppCtx,
  store: Store,
  txHash: `0x${string}`,
  recipient?: string,
): Promise<{ tokenId: string; messageHash: string } | null> {
  console.log(`[sepolia-tracker] Tracking Sepolia tx ${txHash}`)

  let receipt
  try {
    receipt = await ctx.sepoliaClient.waitForTransactionReceipt({
      hash:    txHash,
      timeout: 180_000,
    })
  } catch {
    console.error(`[sepolia-tracker] Timed out waiting for receipt of ${txHash}`)
    return null
  }

  if (receipt.status !== 'success') {
    console.error(`[sepolia-tracker] Tx reverted on Sepolia: ${txHash}`)
    return null
  }

  const meantimeLower = ctx.addresses.meantime.toLowerCase()
  const mtLower = SEPOLIA_CCTP.messageTransmitter.toLowerCase()

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== mtLower) continue
    try {
      const decoded = decodeEventLog({
        abi:       [MESSAGE_SENT_EVENT],
        eventName: 'MessageSent',
        data:      log.data,
        topics:    log.topics as [`0x${string}`, ...`0x${string}`[]],
      })

      const messageBytes = decoded.args.message as `0x${string}`
      const parsed = parseCctpMessage(messageBytes)

      if (parsed.destDomain !== ARC_CCTP.domain) continue
      if (parsed.mintRecipient.toLowerCase() !== meantimeLower) continue

      const messageHash  = keccak256(messageBytes)
      const inboundToken = ARC_CCTP.usdc || ctx.addresses.usdc

      const existing = store.snapshot().find(
        receivable => receivable.cctpMessageHash.toLowerCase() === messageHash.toLowerCase(),
      )

      if (existing) {
        pollAttestation(ctx, store, messageHash, messageBytes).catch(err =>
          console.error('[sepolia-tracker] Attestation poller error:', err),
        )
        return { tokenId: existing.tokenId.toString(), messageHash }
      }

      const resolvedRecipient = (recipient && /^0x[0-9a-fA-F]{40}$/.test(recipient))
        ? recipient as `0x${string}`
        : parsed.messageSender ?? ctx.account.address

      const tokenId = await mintOnArc(ctx, messageHash, inboundToken, parsed.amount, resolvedRecipient)
      if (!tokenId) {
        const fallback = store.snapshot().find(
          receivable => receivable.cctpMessageHash.toLowerCase() === messageHash.toLowerCase(),
        )
        return fallback ? { tokenId: fallback.tokenId.toString(), messageHash } : null
      }
      pollAttestation(ctx, store, messageHash, messageBytes).catch(err =>
        console.error('[sepolia-tracker] Attestation poller error:', err),
      )

      return { tokenId: tokenId.toString(), messageHash }
    } catch {
      // Not a MessageSent log from the MessageTransmitter, skip
    }
  }

  console.warn(`[sepolia-tracker] No matching MessageSent found in tx ${txHash}`)
  return null
}

async function mintOnArc(
  ctx: AppCtx,
  messageHash: `0x${string}`,
  inboundToken: `0x${string}`,
  amount: bigint,
  recipient: `0x${string}`,
): Promise<bigint | null> {
  try {
    console.log(`[mint-on-arc] Minting: hash=${messageHash} amount=${amount} recipient=${recipient}`)
    const txHash = await ctx.walletClient.writeContract({
      address:      ctx.addresses.meantime,
      abi:          MEANTIME_ABI,
      functionName: 'mint',
      args:         [messageHash, inboundToken, amount, recipient],
      account:      ctx.account,
      chain:        null,
    })
    console.log(`[mint-on-arc] Tx submitted: ${txHash}`)
    const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: txHash })
    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({
          abi:       MEANTIME_ABI,
          eventName: 'Minted',
          data:      log.data,
          topics:    log.topics as [`0x${string}`, ...`0x${string}`[]],
        })
        const tokenId = decoded.args.tokenId as bigint
        console.log(`[mint-on-arc] Minted tokenId=${tokenId}`)
        return tokenId
      } catch { /* not this log */ }
    }
  } catch (err) {
    console.error('[mint-on-arc] Failed:', err)
  }
  return null
}
