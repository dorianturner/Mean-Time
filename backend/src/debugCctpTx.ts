import { createPublicClient, decodeEventLog, http, parseAbiItem } from 'viem'

const txHash = process.argv[2] as `0x${string}` | undefined
if (!txHash) {
  console.error('Usage: npx tsx src/debugCctpTx.ts <txHash>')
  process.exit(1)
}

const MESSAGE_SENT_EVENT = parseAbiItem('event MessageSent(bytes message)')

function parseMessage(messageHex: `0x${string}`) {
  const buf = Buffer.from(messageHex.slice(2), 'hex')
  const bodyOffset = 116

  const sourceDomain = buf.readUInt32BE(4)
  const destDomain = buf.readUInt32BE(8)
  const headerRecipient = ('0x' + buf.slice(52, 84).toString('hex').slice(-40)) as `0x${string}`
  const mintRecipient = ('0x' + buf.slice(bodyOffset + 36, bodyOffset + 68).toString('hex').slice(-40)) as `0x${string}`
  const amount = BigInt('0x' + buf.slice(bodyOffset + 68, bodyOffset + 100).toString('hex'))
  const messageSender = ('0x' + buf.slice(bodyOffset + 100, bodyOffset + 132).toString('hex').slice(-40)) as `0x${string}`

  return { sourceDomain, destDomain, headerRecipient, mintRecipient, amount, messageSender }
}

async function main() {
  const rpc = 'https://ethereum-sepolia-rpc.publicnode.com'
  const client = createPublicClient({ transport: http(rpc) })

  const receipt = await client.getTransactionReceipt({ hash: txHash })
  console.log('status:', receipt.status)
  console.log('logs:', receipt.logs.length)

  for (const [i, log] of receipt.logs.entries()) {
    console.log(`\nlog #${i + 1} address=${log.address}`)
    try {
      const decoded = decodeEventLog({
        abi: [MESSAGE_SENT_EVENT],
        eventName: 'MessageSent',
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      })
      const message = decoded.args.message as `0x${string}`
      const p = parseMessage(message)
      console.log('MessageSent decoded:')
      console.log('  sourceDomain:', p.sourceDomain)
      console.log('  destDomain:', p.destDomain)
      console.log('  headerRecipient:', p.headerRecipient)
      console.log('  mintRecipient:', p.mintRecipient)
      console.log('  messageSender:', p.messageSender)
      console.log('  amount:', p.amount.toString())
    } catch {
      // not MessageSent
    }
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
