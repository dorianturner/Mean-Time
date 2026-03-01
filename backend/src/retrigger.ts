// Diagnostic + retrigger script.
// Scans recent Sepolia blocks for any Arc-bound CCTP burns that haven't been
// minted on Arc yet, then mints them. Shows exactly what fails if anything does.
//
// Usage: cd backend && npx tsx src/retrigger.ts

import { parseAbiItem, keccak256, decodeEventLog } from 'viem'
import { buildCtx, SEPOLIA_CCTP, ARC_CCTP } from './ctx.js'
import { MEANTIME_ABI, ERC20_MINT_ABI } from './abi.js'
import { parseCctpMessage } from './sepoliaWatcher.js'

const MESSAGE_SENT_EVENT = parseAbiItem('event MessageSent(bytes message)')
// Scan last N Sepolia blocks (2000 ≈ 6.5 hours at 12s/block)
const LOOKBACK = 2000n

async function main() {
  const ctx = buildCtx()
  const meantimeLower = ctx.addresses.meantime.toLowerCase()

  console.log('=== MeanTime Retrigger ===')
  console.log('Arc RPC:      ', process.env.ARC_RPC_URL)
  console.log('Backend addr: ', ctx.account.address)
  console.log('MeanTime:     ', ctx.addresses.meantime)
  console.log('MockUSDC:     ', ctx.addresses.usdc)
  console.log()

  // ── Step 1: Scan Sepolia for burns ─────────────────────────────────────────
  console.log(`Scanning last ${LOOKBACK} Sepolia blocks for Arc-bound CCTP burns…`)
  const sepoliaLatest = await ctx.sepoliaClient.getBlockNumber()
  const from = sepoliaLatest > LOOKBACK ? sepoliaLatest - LOOKBACK : 0n

  let logs: any[]
  try {
    logs = await ctx.sepoliaClient.getLogs({
      address:   SEPOLIA_CCTP.messageTransmitter,
      event:     MESSAGE_SENT_EVENT,
      fromBlock: from,
      toBlock:   sepoliaLatest,
    })
  } catch (err) {
    console.error('Failed to getLogs from Sepolia:', err)
    return
  }

  console.log(`Found ${logs.length} MessageSent event(s) total.`)

  const burns: { messageHash: `0x${string}`; messageBytes: `0x${string}`; amount: bigint; messageSender: string }[] = []

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

      const messageHash = keccak256(messageBytes)
      console.log(`  ✓ Arc-bound burn: hash=${messageHash} amount=${parsed.amount} from=${parsed.messageSender}`)
      burns.push({ messageHash, messageBytes, amount: parsed.amount, messageSender: parsed.messageSender })
    } catch (err) {
      console.warn('  Could not decode log:', (err as Error).message)
    }
  }

  if (burns.length === 0) {
    console.log('\nNo Arc-bound burns found in the last 2000 Sepolia blocks.')
    console.log('Make sure your depositForBurn used:')
    console.log('  destinationDomain = 7')
    console.log('  mintRecipient     =', ctx.addresses.meantime, '(left-padded to 32 bytes)')
    return
  }

  // ── Step 2: For each burn, check if minted on Arc ─────────────────────────
  console.log(`\nChecking which of ${burns.length} burn(s) are missing on Arc…`)
  const arcLatest = await ctx.publicClient.getBlockNumber()
  console.log(`Arc latest block: ${arcLatest}`)

  for (const burn of burns) {
    let existing: bigint
    try {
      existing = await ctx.publicClient.readContract({
        address:      ctx.addresses.meantime,
        abi:          MEANTIME_ABI,
        functionName: 'tokenByMessageHash',
        args:         [burn.messageHash],
      }) as bigint
    } catch (err) {
      console.error(`  tokenByMessageHash failed for ${burn.messageHash}:`, (err as Error).message)
      existing = 0n
    }

    if (existing !== 0n) {
      console.log(`  Hash ${burn.messageHash}: already minted → tokenId=${existing}`)
      continue
    }

    console.log(`  Hash ${burn.messageHash}: NOT minted — attempting mint now…`)

    // Determine inboundToken + recipient
    const inboundToken = (ARC_CCTP.usdc || ctx.addresses.usdc) as `0x${string}`
    const recipient    = burn.messageSender as `0x${string}`
    console.log(`    inboundToken: ${inboundToken}`)
    console.log(`    recipient:    ${recipient}`)
    console.log(`    amount:       ${burn.amount}`)

    try {
      const txHash = await ctx.walletClient.writeContract({
        address:      ctx.addresses.meantime,
        abi:          MEANTIME_ABI,
        functionName: 'mint',
        args:         [burn.messageHash, inboundToken, burn.amount, recipient],
        account:      ctx.account,
        chain:        null,
      })
      console.log(`    Tx submitted: ${txHash}`)
      const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: txHash })
      if (receipt.status === 'success') {
        console.log(`    ✓ Minted! (block ${receipt.blockNumber})`)
      } else {
        console.error(`    ✗ Tx reverted. Receipt:`, receipt)
      }
    } catch (err: any) {
      console.error(`    ✗ mint() failed:`)
      console.error(`      ${err?.shortMessage ?? err?.message ?? err}`)
      if (err?.cause) console.error(`      cause: ${err.cause?.shortMessage ?? err.cause?.message}`)
    }
  }

  console.log('\nDone. Restart app.sh to refresh the store.')
}

main().catch(err => { console.error(err); process.exit(1) })
