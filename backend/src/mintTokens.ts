// Mint mock USDC/EURC to one or more Arc wallets for testing.
// Usage:
//   cd backend && npx tsx src/mintTokens.ts 0xWalletA 0xWalletB
//   AMOUNT=50 npx tsx src/mintTokens.ts 0xWalletA  (default: 100 USDC/EURC each)

import { buildCtx } from './ctx.js'
import { ERC20_MINT_ABI } from './abi.js'

const AMOUNT_UNITS = BigInt(Math.round(Number(process.env.AMOUNT ?? 100) * 1e6))

async function main() {
  const recipients = process.argv.slice(2).filter(a => /^0x[0-9a-fA-F]{40}$/.test(a))
  if (recipients.length === 0) {
    console.error('Usage: npx tsx src/mintTokens.ts 0xAddr1 [0xAddr2 ...]')
    process.exit(1)
  }

  const ctx = buildCtx()
  console.log(`Minting ${Number(AMOUNT_UNITS) / 1e6} USDC + EURC to each of: ${recipients.join(', ')}`)

  for (const addr of recipients as `0x${string}`[]) {
    for (const [sym, token] of [['USDC', ctx.addresses.usdc], ['EURC', ctx.addresses.eurc]] as [string, `0x${string}`][]) {
      try {
        const tx = await ctx.walletClient.writeContract({
          address:      token,
          abi:          ERC20_MINT_ABI,
          functionName: 'mint',
          args:         [addr, AMOUNT_UNITS],
          account:      ctx.account,
          chain:        null,
        })
        const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: tx })
        console.log(`  ✓ ${sym} → ${addr}: tx=${tx} (block ${receipt.blockNumber})`)
      } catch (err: any) {
        console.error(`  ✗ ${sym} → ${addr}: ${err?.shortMessage ?? err?.message ?? err}`)
      }
    }
  }

  console.log('Done.')
}

main().catch(err => { console.error(err); process.exit(1) })
