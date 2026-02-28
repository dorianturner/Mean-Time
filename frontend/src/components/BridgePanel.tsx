import { useState } from 'react'
import { API_BASE } from '../config.js'

interface Props {
  usdcAddr: string
  eurcAddr: string
}

export function BridgePanel({ usdcAddr, eurcAddr }: Props) {
  const [recipient,  setRecipient]  = useState('')
  const [amount,     setAmount]     = useState('1000')
  const [token,      setToken]      = useState(usdcAddr)
  const [msgHash,    setMsgHash]    = useState('')
  const [settleHash, setSettleHash] = useState('')
  const [status,     setStatus]     = useState('')

  const mint = async () => {
    setStatus('Minting…')
    try {
      const res = await fetch(`${API_BASE}/api/bridge/mint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cctpMessageHash: msgHash || `test-${Date.now()}`,
          inboundToken:    token,
          inboundAmount:   String(Number(amount) * 1e6),
          recipient,
        }),
      })
      const data = await res.json()
      setStatus(res.ok ? `Minted ✓  ${data.txHash}` : `Error: ${data.error}`)
    } catch (e) { setStatus(`Error: ${e}`) }
  }

  const settle = async () => {
    setStatus('Settling…')
    try {
      const res = await fetch(`${API_BASE}/api/bridge/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cctpMessageHash: settleHash }),
      })
      const data = await res.json()
      setStatus(res.ok ? `Settled ✓  ${data.txHash}` : `Error: ${data.error}`)
    } catch (e) { setStatus(`Error: ${e}`) }
  }

  return (
    <div className="bridge-panel">
      <h2>Bridge Simulator</h2>
      <p className="hint">Simulates CCTP: mint a receivable NFT, then settle it once the attestation arrives.</p>

      <div className="form-group">
        <h3>Mint (burn detected on Ethereum)</h3>
        <label>Recipient address
          <input value={recipient} onChange={e => setRecipient(e.target.value)} placeholder="0x…" />
        </label>
        <label>Amount (whole units)
          <input type="number" value={amount} onChange={e => setAmount(e.target.value)} />
        </label>
        <label>Inbound token
          <select value={token} onChange={e => setToken(e.target.value)}>
            <option value={usdcAddr}>USDC</option>
            <option value={eurcAddr}>EURC</option>
          </select>
        </label>
        <label>CCTP message hash (leave blank to auto-generate)
          <input value={msgHash} onChange={e => setMsgHash(e.target.value)} placeholder="0x…" />
        </label>
        <button onClick={mint}>Mint NFT</button>
      </div>

      <div className="form-group">
        <h3>Settle (attestation arrived)</h3>
        <label>CCTP message hash
          <input value={settleHash} onChange={e => setSettleHash(e.target.value)} placeholder="0x…" />
        </label>
        <button onClick={settle}>Settle</button>
      </div>

      {status && <div className="status-box">{status}</div>}
    </div>
  )
}
