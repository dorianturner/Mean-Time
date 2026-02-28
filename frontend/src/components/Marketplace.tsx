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

async function sendTx(from: string, to: string, data: string) {
  if (!window.ethereum) throw new Error('No wallet')
  return window.ethereum.request({
    method: 'eth_sendTransaction',
    params: [{ from, to, data }],
  })
}

interface Props {
  receivables:  Receivable[]
  meantimeAddr: `0x${string}`
  tokenSymbol:  (addr: string) => string
  userAddress:  string | null
  usdcAddr:     string
  eurcAddr:     string
}

export function Marketplace({ receivables, meantimeAddr, tokenSymbol, userAddress, usdcAddr, eurcAddr }: Props) {
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
  // Unlisted receivables owned by others (or all unlisted if not connected)
  const othersUnlisted = receivables.filter(r => {
    if (r.listing) return false
    if (userAddress && r.beneficialOwner.toLowerCase() === userAddress) return false
    return true
  })

  const setStatus = (key: string, msg: string) => setTxStatus(s => ({ ...s, [key]: msg }))
  const setBusyKey = (key: string, val: boolean) => setBusy(s => ({ ...s, [key]: val }))

  const handleList = async (r: Receivable) => {
    const price = listPrice[r.tokenId]
    if (!price || !userAddress) return
    const priceUnits = BigInt(Math.round(Number(price) * 1e6))
    const payToken = listPayTok[r.tokenId] || eurcAddr
    const key = `list-${r.tokenId}`
    setBusyKey(key, true)
    setStatus(key, 'Confirm in wallet…')
    try {
      const data = encodeList(BigInt(r.tokenId), priceUnits, payToken)
      const tx = await sendTx(userAddress, meantimeAddr, data)
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
      const data = encodeDelist(BigInt(r.tokenId))
      const tx = await sendTx(userAddress, meantimeAddr, data)
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
    setStatus(key, 'Step 1/2: approve…')
    try {
      const approveData = encodeApprove(meantimeAddr, BigInt(r.listing.reservePrice))
      await sendTx(userAddress, r.listing.paymentToken, approveData)
      setStatus(key, 'Step 2/2: fill…')
      const fillData = encodeFill(BigInt(r.tokenId))
      const tx = await sendTx(userAddress, meantimeAddr, fillData)
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

      {/* Unlisted receivables owned by others — always visible */}
      {othersUnlisted.length > 0 && (
        <section>
          <h2>Unlisted Receivables</h2>
          {othersUnlisted.map(r => (
            <div key={r.tokenId} className="card">
              <div className="card-header">
                <span>#{r.tokenId}</span>
                <span>{(Number(r.inboundAmount) / 1e6).toFixed(2)} {tokenSymbol(r.inboundToken)}</span>
              </div>
              <div className="card-body">
                <span className="status">Awaiting listing</span>
                <span className="owner-hint">
                  Owner: {r.beneficialOwner.slice(0, 6)}…{r.beneficialOwner.slice(-4)}
                </span>
              </div>
            </div>
          ))}
        </section>
      )}
    </div>
  )
}
