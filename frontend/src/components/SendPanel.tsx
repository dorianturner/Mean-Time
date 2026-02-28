import { useState } from 'react'
import { API_BASE } from '../config.js'

// Sepolia CCTP v1 contracts
const SEPOLIA_CHAIN_ID = 11155111
const SEPOLIA_USDC     = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'
const SEPOLIA_TOKEN_MESSENGER = '0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5'
const ARC_DOMAIN       = 7  // Circle CCTP domain for Arc testnet

// ABI encoding helpers
function encodeUint(n: bigint): string { return n.toString(16).padStart(64, '0') }
function encodeAddr(a: string): string { return a.replace('0x', '').padStart(64, '0') }
function encodeBytes32(hex: string): string { return hex.replace('0x', '').padStart(64, '0') }

// ERC20 approve(address spender, uint256 amount)
function encodeApprove(spender: string, amount: bigint): string {
  return '0x095ea7b3' + encodeAddr(spender) + encodeUint(amount)
}

// TokenMessenger.depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken)
// selector: keccak256("depositForBurn(uint256,uint32,bytes32,address)") = 0x6fd3504e
function encodeDepositForBurn(
  amount: bigint,
  destDomain: number,
  mintRecipient: string,  // already 32-byte hex (no 0x)
  burnToken: string,
): string {
  const selector = '0x6fd3504e'
  const amt      = encodeUint(amount)
  const domain   = encodeUint(BigInt(destDomain))
  const recip    = encodeBytes32(mintRecipient)
  const token    = encodeAddr(burnToken)
  return selector + amt + domain + recip + token
}

async function sendTx(from: string, to: string, data: string): Promise<string> {
  if (!window.ethereum) throw new Error('No wallet connected')
  const txHash = await window.ethereum.request({
    method: 'eth_sendTransaction',
    params: [{ from, to, data }],
  })
  return txHash as string
}

interface Props {
  meantimeAddr: string
  userAddress:  string | null
  chainId:      number | null
  switchNetwork: (chainId: number) => Promise<void>
}

type Step = 'idle' | 'switching' | 'approving' | 'burning' | 'pending' | 'done' | 'error'

export function SendPanel({ meantimeAddr, userAddress, chainId, switchNetwork }: Props) {
  const [recipient, setRecipient] = useState('')
  const [amount,    setAmount]    = useState('10')
  const [step,      setStep]      = useState<Step>('idle')
  const [status,    setStatus]    = useState('')
  const [txHash,    setTxHash]    = useState('')

  const onSepolia = chainId === SEPOLIA_CHAIN_ID

  const handleSwitchToSepolia = async () => {
    setStep('switching')
    setStatus('Switching to Sepolia…')
    try {
      await switchNetwork(SEPOLIA_CHAIN_ID)
      setStep('idle')
      setStatus('')
    } catch {
      setStep('error')
      setStatus('Failed to switch network.')
    }
  }

  const handleSend = async () => {
    if (!userAddress) { setStatus('Connect your wallet first.'); return }
    if (!recipient || !/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
      setStatus('Enter a valid Arc recipient address (0x…).')
      return
    }
    if (!amount || Number(amount) <= 0) { setStatus('Enter a valid amount.'); return }

    const units = BigInt(Math.round(Number(amount) * 1e6))

    // mintRecipient = MeanTime address, padded to 32 bytes (no 0x prefix)
    const mintRecipient = meantimeAddr.replace('0x', '').padStart(64, '0')

    try {
      // Step 1: Approve TokenMessenger to spend USDC
      setStep('approving')
      setStatus('Step 1/2 — Approve Sepolia USDC for CCTP…')
      const approveData = encodeApprove(SEPOLIA_TOKEN_MESSENGER, units)
      await sendTx(userAddress, SEPOLIA_USDC, approveData)

      // Step 2: depositForBurn → burns USDC on Sepolia, emits CCTP message
      setStep('burning')
      setStatus('Step 2/2 — Burning USDC on Sepolia via CCTP…')
      const burnData = encodeDepositForBurn(units, ARC_DOMAIN, mintRecipient, SEPOLIA_USDC)
      const burnTxHash = await sendTx(userAddress, SEPOLIA_TOKEN_MESSENGER, burnData)
      setTxHash(burnTxHash)

      // Step 3: Notify backend to track this transfer and mint the NFT on Arc
      setStep('pending')
      setStatus('Notifying backend — minting receivable NFT on Arc…')
      const res = await fetch(`${API_BASE}/api/bridge/initiate-cctp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txHash: burnTxHash, recipient }),
      })
      const data = await res.json()

      if (res.ok) {
        setStep('done')
        setStatus(
          `NFT minted for ${recipient.slice(0, 10)}…  ` +
          `Settlement in ~14 min. Token ID: ${data.tokenId ?? '?'}`
        )
      } else {
        setStep('error')
        setStatus(`Backend error: ${data.error ?? 'unknown'}`)
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      setStep('error')
      setStatus(msg.includes('user rejected') ? 'Rejected.' : `Error: ${msg}`)
    }
  }

  const busy = step === 'switching' || step === 'approving' || step === 'burning' || step === 'pending'

  return (
    <div className="send-panel">
      <h2>Send USDC → Arc</h2>
      <p className="hint">
        Burns Sepolia USDC via CCTP v1. A receivable NFT is minted on Arc instantly.
        The recipient can hold it or trade it on the marketplace. Settlement arrives in ~14 minutes.
      </p>

      {!userAddress && (
        <div className="status-box warn">Connect your wallet to send.</div>
      )}

      {userAddress && !onSepolia && (
        <div className="network-prompt">
          <p>You must be on <strong>Sepolia</strong> to initiate a CCTP transfer.</p>
          <button onClick={handleSwitchToSepolia} disabled={busy}>
            Switch to Sepolia
          </button>
        </div>
      )}

      {userAddress && onSepolia && (
        <div className="form-group">
          <label>Recipient on Arc
            <input
              value={recipient}
              onChange={e => setRecipient(e.target.value)}
              placeholder="0x… (Arc address)"
              disabled={busy}
            />
          </label>
          <label>Amount (USDC)
            <input
              type="number"
              min="0.01"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              disabled={busy}
            />
          </label>
          <button onClick={handleSend} disabled={busy || !userAddress}>
            {busy ? status : `Send ${amount} USDC`}
          </button>
          <p className="hint small">
            Two wallet confirmations: approve USDC + burn via CCTP.
          </p>
        </div>
      )}

      {status && !busy && (
        <div className={`status-box ${step === 'error' ? 'err' : step === 'done' ? 'ok' : ''}`}>
          {status}
          {txHash && (
            <div style={{ marginTop: 4, fontSize: '0.8em', wordBreak: 'break-all' }}>
              Sepolia tx: {txHash}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
