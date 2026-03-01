import { useState } from 'react'
import type { Receivable } from '../types.js'

// Encode a function call: list(uint256,uint256,address)
function encodeList(tokenId: bigint, price: bigint, token: string): string {
  const sig = '0x704ecd0e' // keccak256('list(uint256,uint256,address)')[0:4]
  const pad  = (n: bigint) => n.toString(16).padStart(64, '0')
  const padA = (a: string) => a.replace('0x', '').padStart(64, '0')
  return sig + pad(tokenId) + pad(price) + padA(token)
}

// Encode delist(uint256)
function encodeDelist(tokenId: bigint): string {
  const sig = '0x964bc33f' // keccak256('delist(uint256)')[0:4]
  return sig + tokenId.toString(16).padStart(64, '0')
}

// Encode fill(uint256)
function encodeFill(tokenId: bigint): string {
  const sig = '0x3fda5389' // keccak256('fill(uint256)')[0:4]
  return sig + tokenId.toString(16).padStart(64, '0')
}

// Encode approve(address,uint256)
function encodeApprove(spender: string, amount: bigint): string {
  const sig = '0x095ea7b3'
  return sig + spender.replace('0x', '').padStart(64, '0') + amount.toString(16).padStart(64, '0')
}

/** Read an ERC-20 balance via eth_call without signing. */
async function erc20Balance(token: string, owner: string): Promise<bigint> {
  if (!window.ethereum) return 0n
  const data = '0x70a08231' + owner.replace('0x', '').padStart(64, '0')
  const result = await window.ethereum.request({
    method: 'eth_call',
    params: [{ to: token, data }, 'latest'],
  }) as string
  return result && result !== '0x' ? BigInt(result) : 0n
}

async function sendTx(from: string, to: string, data: string) {
  if (!window.ethereum) throw new Error('No wallet')
  return window.ethereum.request({
    method: 'eth_sendTransaction',
    params: [{ from, to, data }],
  })
}

/** Poll until a tx is mined successfully or reverted. Throws on revert/drop/cancel. */
async function waitForReceipt(txHash: string, timeoutMs = 60_000): Promise<void> {
  if (!window.ethereum) throw new Error('No wallet')
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    // Check receipt first
    const receipt = await window.ethereum.request({
      method: 'eth_getTransactionReceipt',
      params: [txHash],
    }) as { status: string } | null
    if (receipt) {
      if (receipt.status === '0x1') return          // success
      throw new Error('Transaction reverted on-chain')
    }
    // Check if the tx was dropped/cancelled (no longer in mempool)
    const tx = await window.ethereum.request({
      method: 'eth_getTransactionByHash',
      params: [txHash],
    })
    if (tx === null) {
      throw new Error('Transaction was cancelled or dropped')
    }
    await new Promise(r => setTimeout(r, 2000))     // poll every 2s
  }
  throw new Error('Transaction timed out — check wallet')
}

interface Props {
  receivables:  Receivable[]
  meantimeAddr: `0x${string}`
  tokenSymbol:  (addr: string) => string
  userAddress:  string | null
  chainId:      number | null
  usdcAddr:     string
  eurcAddr:     string
  updateReceivable: (tokenId: string, patch: Partial<Receivable>) => void
  switchNetwork: (chainId: number) => Promise<void>
}

const ARC_CHAIN_ID = 5042002

export function Marketplace({ receivables, meantimeAddr, tokenSymbol, userAddress, chainId, usdcAddr, eurcAddr, updateReceivable, switchNetwork }: Props) {
  const [listPrice,   setListPrice]   = useState<Record<string, string>>({})
  const [listPayTok,  setListPayTok]  = useState<Record<string, string>>({})
  const [txStatus,    setTxStatus]    = useState<Record<string, string>>({})
  const [busy,        setBusy]        = useState<Record<string, boolean>>({})

  // Only show receivables the connected wallet owns and that are not yet listed
  const mine   = userAddress
    ? receivables.filter(r => !r.listing && r.beneficialOwner.toLowerCase() === userAddress)
    : []
  const myListed = userAddress
    ? receivables.filter(r => r.listing && r.beneficialOwner.toLowerCase() === userAddress)
    : []
  const listed = receivables.filter(r => r.listing)

  const setStatus = (key: string, msg: string) => setTxStatus(s => ({ ...s, [key]: msg }))
  const setBusyKey = (key: string, val: boolean) => setBusy(s => ({ ...s, [key]: val }))

  const onArc = chainId === ARC_CHAIN_ID

  /** Ensure wallet is on Arc before any on-chain action. Returns false if switch failed. */
  const ensureArc = async (): Promise<boolean> => {
    if (onArc) return true
    try {
      await switchNetwork(ARC_CHAIN_ID)
      return true
    } catch {
      return false
    }
  }

  const handleList = async (r: Receivable) => {
    const price = listPrice[r.tokenId]
    if (!price || !userAddress) return
    const priceUnits = BigInt(Math.round(Number(price) * 1e6))
    const payToken = listPayTok[r.tokenId] || eurcAddr
    const key = `list-${r.tokenId}`
    setBusyKey(key, true)
    setStatus(key, 'Confirm in wallet…')
    try {
      if (!await ensureArc()) { setStatus(key, 'Switch to Arc to list.'); return }
      const data = encodeList(BigInt(r.tokenId), priceUnits, payToken)
      const tx = await sendTx(userAddress, meantimeAddr, data)
      setStatus(key, `Confirming tx ${String(tx).slice(0, 18)}…`)
      await waitForReceipt(String(tx))
      updateReceivable(r.tokenId, { listing: { reservePrice: String(priceUnits), paymentToken: payToken } })
      setStatus(key, `Listed! tx: ${String(tx).slice(0, 18)}…`)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      setStatus(key, msg.includes('user rejected') ? 'Rejected.' : `Error: ${msg}`)
    } finally {
      setBusyKey(key, false)
    }
  }

  const handleDelist = async (r: Receivable) => {
    if (!userAddress) return
    const key = `delist-${r.tokenId}`
    setBusyKey(key, true)
    setStatus(key, 'Confirm in wallet…')
    try {
      if (!await ensureArc()) { setStatus(key, 'Switch to Arc to delist.'); return }
      const data = encodeDelist(BigInt(r.tokenId))
      const tx = await sendTx(userAddress, meantimeAddr, data)
      setStatus(key, `Confirming tx ${String(tx).slice(0, 18)}…`)
      await waitForReceipt(String(tx))
      updateReceivable(r.tokenId, { listing: null })
      setStatus(key, `Delisted! tx: ${String(tx).slice(0, 18)}…`)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      setStatus(key, msg.includes('user rejected') ? 'Rejected.' : `Error: ${msg}`)
    } finally {
      setBusyKey(key, false)
    }
  }

  const handleFill = async (r: Receivable) => {
    if (!r.listing || !userAddress) return
    const key = `fill-${r.tokenId}`
    setBusyKey(key, true)
    setStatus(key, 'Step 1/3: switch to Arc…')
    try {
      if (!await ensureArc()) { setStatus(key, 'Switch to Arc to fill.'); return }

      // Pre-flight: check filler has enough payment token
      const needed  = BigInt(r.listing.reservePrice)
      const balance = await erc20Balance(r.listing.paymentToken, userAddress)
      if (balance < needed) {
        const sym = tokenSymbol(r.listing.paymentToken)
        setStatus(key, `Insufficient ${sym}. Need ${(Number(needed) / 1e6).toFixed(2)} but have ${(Number(balance) / 1e6).toFixed(2)}.`)
        return
      }

      setStatus(key, 'Step 1/2: approve payment token…')
      const approveData = encodeApprove(meantimeAddr, BigInt(r.listing.reservePrice))
      const approveTx = await sendTx(userAddress, r.listing.paymentToken, approveData)
      setStatus(key, 'Waiting for approve to confirm…')
      await waitForReceipt(String(approveTx))
      setStatus(key, 'Step 2/2: fill listing…')
      const fillData = encodeFill(BigInt(r.tokenId))
      const tx = await sendTx(userAddress, meantimeAddr, fillData)
      setStatus(key, `Confirming tx ${String(tx).slice(0, 18)}…`)
      await waitForReceipt(String(tx))
      if (userAddress) updateReceivable(r.tokenId, { listing: null, beneficialOwner: userAddress })
      setStatus(key, `Filled! tx: ${String(tx).slice(0, 18)}…`)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      setStatus(key, msg.includes('user rejected') ? 'Rejected.' : `Error: ${msg}`)
    } finally {
      setBusyKey(key, false)
    }
  }

  return (
    <div className="marketplace">
      {/* My unlisted receivables — only visible when connected and owning some */}
      {mine.length > 0 && (
        <section>
          <h2>My Receivables</h2>
          {mine.map(r => {
            const key = `list-${r.tokenId}`
            return (
              <div key={r.tokenId} className="card">
                <div className="card-header">
                  <span>#{r.tokenId}</span>
                  <span>{(Number(r.inboundAmount) / 1e6).toFixed(2)} {tokenSymbol(r.inboundToken)}</span>
                </div>
                <div className="card-body">
                  <input
                    type="number"
                    className="list-price-input"
                    placeholder="Price (e.g. 995.00)"
                    value={listPrice[r.tokenId] ?? ''}
                    onChange={e => setListPrice(p => ({ ...p, [r.tokenId]: e.target.value }))}
                  />
                  <select
                    className="list-token-select"
                    value={listPayTok[r.tokenId] || eurcAddr}
                    onChange={e => setListPayTok(p => ({ ...p, [r.tokenId]: e.target.value }))}
                  >
                    <option value={usdcAddr}>USDC</option>
                    <option value={eurcAddr}>EURC</option>
                  </select>
                  <button
                    disabled={busy[key] || !listPrice[r.tokenId]}
                    onClick={() => handleList(r)}
                  >
                    {busy[key] ? 'Listing…' : 'List'}
                  </button>
                </div>
                {txStatus[key] && <div className="tx-status">{txStatus[key]}</div>}
              </div>
            )
          })}
        </section>
      )}

      {/* My active listings — can delist */}
      {myListed.length > 0 && (
        <section>
          <h2>My Listings</h2>
          {myListed.map(r => {
            const key = `delist-${r.tokenId}`
            return (
              <div key={r.tokenId} className="card">
                <div className="card-header">
                  <span>#{r.tokenId}</span>
                  <span className="price">
                    {(Number(r.listing!.reservePrice) / 1e6).toFixed(2)} {tokenSymbol(r.listing!.paymentToken)}
                  </span>
                </div>
                <div className="card-body">
                  <span>{(Number(r.inboundAmount) / 1e6).toFixed(2)} {tokenSymbol(r.inboundToken)} incoming</span>
                  <button disabled={busy[key]} onClick={() => handleDelist(r)}>
                    {busy[key] ? 'Delisting…' : 'Delist'}
                  </button>
                </div>
                {txStatus[key] && <div className="tx-status">{txStatus[key]}</div>}
              </div>
            )
          })}
        </section>
      )}

      {/* Open listings — visible to everyone */}
      <section>
        <h2>Open Listings</h2>
        {listed.length === 0 && (
          <p className="empty">No active listings — be the first to list a receivable.</p>
        )}
        {listed.map(r => {
          const key = `fill-${r.tokenId}`
          const isOwner = userAddress && r.beneficialOwner.toLowerCase() === userAddress
          return (
            <div key={r.tokenId} className="card">
              <div className="card-header">
                <span>#{r.tokenId}</span>
                <span className="price">
                  {(Number(r.listing!.reservePrice) / 1e6).toFixed(2)} {tokenSymbol(r.listing!.paymentToken)}
                </span>
              </div>
              <div className="card-body">
                <span>
                  {(Number(r.inboundAmount) / 1e6).toFixed(2)} {tokenSymbol(r.inboundToken)} incoming
                </span>
                {isOwner ? (
                  <span className="status">Your listing</span>
                ) : !userAddress ? (
                  <span className="status">Connect to fill</span>
                ) : (
                  <button disabled={busy[key]} onClick={() => handleFill(r)}>
                    {busy[key] ? 'Filling…' : 'Fill'}
                  </button>
                )}
              </div>
              {txStatus[key] && <div className="tx-status">{txStatus[key]}</div>}
            </div>
          )
        })}
      </section>

    </div>
  )
}
