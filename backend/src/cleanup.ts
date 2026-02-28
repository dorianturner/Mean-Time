// One-shot script: settle all old demo receivables.
// Mints enough mock tokens to the MeanTime contract so settle() can pay out,
// then calls settle() for each one.
//
// Usage: cd backend && npx tsx src/cleanup.ts

import { buildCtx } from './ctx.js'
import { MEANTIME_ABI } from './abi.js'
import { ERC20_MINT_ABI } from './abi.js'

const RECEIVABLE_ABI = [
  {
    name: 'getReceivable',
    type: 'function',
    stateMutability: 'view',
    inputs:  [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      { name: 'owner', type: 'address' },
      { name: 'data',  type: 'tuple', components: [
        { name: 'cctpMessageHash', type: 'bytes32' },
        { name: 'inboundToken',    type: 'address' },
        { name: 'inboundAmount',   type: 'uint256' },
        { name: 'mintedAt',        type: 'uint256' },
      ]},
      { name: 'listing', type: 'tuple', components: [
        { name: 'reservePrice', type: 'uint256' },
        { name: 'paymentToken', type: 'address' },
        { name: 'active',       type: 'bool' },
      ]},
      { name: 'age',                   type: 'uint256' },
      { name: 'estimatedSecondsLeft',  type: 'uint256' },
    ],
  },
] as const

async function main() {
  const ctx = buildCtx()
  const meantime = ctx.addresses.meantime

  console.log('Cleaning up demo receivables…')
  console.log('MeanTime:', meantime)
  console.log('USDC:    ', ctx.addresses.usdc)

  // Scan token IDs 1..20 to find any that still exist
  const toSettle: { tokenId: bigint; hash: `0x${string}`; token: `0x${string}`; amount: bigint }[] = []

  for (let id = 1n; id <= 20n; id++) {
    try {
      const result = await ctx.publicClient.readContract({
        address: meantime,
        abi: RECEIVABLE_ABI,
        functionName: 'getReceivable',
        args: [id],
      }) as any

      const [owner, data] = result
      if (owner === '0x0000000000000000000000000000000000000000') continue
      if (data.inboundAmount === 0n) continue

      toSettle.push({
        tokenId: id,
        hash:    data.cctpMessageHash,
        token:   data.inboundToken,
        amount:  data.inboundAmount,
      })
      console.log(`  Found token #${id}: ${data.inboundAmount} of ${data.inboundToken}`)
    } catch {
      // token doesn't exist
    }
  }

  if (toSettle.length === 0) {
    console.log('No receivables to clean up!')
    return
  }

  console.log(`\nSettling ${toSettle.length} receivable(s)…\n`)

  for (const r of toSettle) {
    try {
      // 1. Mint tokens to the contract so settle() can pay out
      console.log(`  #${r.tokenId}: Minting ${r.amount} tokens to contract…`)
      const mintTx = await ctx.walletClient.writeContract({
        address:      r.token,
        abi:          ERC20_MINT_ABI,
        functionName: 'mint',
        args:         [meantime, r.amount],
        account:      ctx.account,
        chain:        null,
      })
      // Wait for mint to confirm
      await ctx.publicClient.waitForTransactionReceipt({ hash: mintTx })

      // 2. Settle
      console.log(`  #${r.tokenId}: Settling…`)
      const settleTx = await ctx.walletClient.writeContract({
        address:      meantime,
        abi:          MEANTIME_ABI,
        functionName: 'settle',
        args:         [r.hash],
        account:      ctx.account,
        chain:        null,
      })
      await ctx.publicClient.waitForTransactionReceipt({ hash: settleTx })

      console.log(`  #${r.tokenId}: ✓ Settled (tx: ${settleTx})`)
    } catch (err) {
      console.error(`  #${r.tokenId}: ✗ Failed:`, err)
    }
  }

  console.log('\nDone! Restart the backend to refresh the store.')
}

main().catch(err => { console.error(err); process.exit(1) })
