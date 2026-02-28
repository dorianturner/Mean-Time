import { useState, useEffect, useRef } from 'react'
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
  const [delay,      setDelay]      = useState('30')
  const [status,     setStatus]     = useState('')
  const [countdown,  setCountdown]  = useState<number | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Countdown tick
  useEffect(() => {
    if (countdown === null) return
    if (countdown <= 0) {
      if (timerRef.current) clearInterval(timerRef.current)
      timerRef.current = null
      setCountdown(null)
      return
    }
    timerRef.current = setInterval(() => {
      setCountdown(prev => (prev !== null && prev > 0) ? prev - 1 : null)
    }, 1000)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [countdown !== null && countdown > 0])

  const mint = async () => {
    setStatus('Minting…')
    setCountdown(null)
    try {
      const delaySec = Math.max(0, Number(delay) || 30)
      const res = await fetch(`${API_BASE}/api/bridge/mint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cctpMessageHash: msgHash || `test-${Date.now()}`,
          inboundToken:    token,
          inboundAmount:   String(Number(amount) * 1e6),
          recipient,
          settleDelaySec:  delaySec,
        }),
      })
      const data = await res.json()
      if (res.ok) {
        setStatus(`Minted ✓  ${data.txHash}  —  auto-settle in ${delaySec}s`)
        setCountdown(delaySec)
      } else {
        setStatus(`Error: ${data.error}`)
      }
    } catch (e) { setStatus(`Error: ${e}`) }
  }

  return (
    <div className="bridge-panel">
      <h2>Bridge Simulator</h2>
      <p className="hint">Simulates CCTP: mint a receivable NFT. Settlement happens automatically after the attestation delay.</p>

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
        <label>Attestation delay (seconds)
          <input type="number" value={delay} onChange={e => setDelay(e.target.value)} min="0" />
        </label>
        <label>CCTP message hash (leave blank to auto-generate)
          <input value={msgHash} onChange={e => setMsgHash(e.target.value)} placeholder="0x…" />
        </label>
        <button onClick={mint}>Mint NFT</button>
      </div>

      {status && <div className="status-box">{status}</div>}
      {countdown !== null && countdown > 0 && (
        <div className="status-box" style={{ color: 'var(--accent)' }}>
          Auto-settle in {countdown}s…
        </div>
      )}
    </div>
  )
}
