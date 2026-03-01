import { useState } from 'react'
import { API_BASE } from '../config.js'

// Sepolia CCTP v1 contracts (Circle official)
const SEPOLIA_CHAIN_ID        = 11155111
const SEPOLIA_USDC            = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'
const SEPOLIA_TOKEN_MESSENGER = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA'
const ARC_DOMAIN              = 26   // Circle CCTP domain for Arc testnet

// ABI encoding helpers
function encodeUint(n: bigint): string  { return n.toString(16).padStart(64, '0') }
function encodeAddr(a: string): string  { return a.replace('0x', '').padStart(64, '0') }
function encodeBytes32(h: string): string { return h.replace('0x', '').padStart(64, '0') }

// ERC20 approve(address spender, uint256 amount) — 0x095ea7b3
function encodeApprove(spender: string, amount: bigint): string {
  return '0x095ea7b3' + encodeAddr(spender) + encodeUint(amount)
}

// TokenMessengerV2.depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32) — 0x8e0250ee
// Standard Transfer: destinationCaller=0, maxFee=0, minFinalityThreshold=2000 (~14 min)
function encodeDepositForBurn(
  amount: bigint, destDomain: number, mintRecipient: string, burnToken: string,
): string {
  return '0x8e0250ee' + encodeUint(amount) + encodeUint(BigInt(destDomain))
    + encodeBytes32(mintRecipient) + encodeAddr(burnToken)
    + encodeBytes32('0' + '0'.repeat(63))     // destinationCaller = bytes32(0)
    + encodeUint(0n)                           // maxFee = 0
    + encodeUint(2000n)                        // minFinalityThreshold = 2000 (Standard)
}

async function sendTx(from: string, to: string, data: string): Promise<string> {
  if (!window.ethereum) throw new Error('No wallet connected')
  return window.ethereum.request({
    method: 'eth_sendTransaction',
    params: [{ from, to, data }],
  }) as Promise<string>
}

/** Poll until tx is mined. Throws if reverted or timed out. */
async function waitForTx(hash: string, setStatus: (s: string) => void, label: string): Promise<void> {
  if (!window.ethereum) return
  const deadline = Date.now() + 5 * 60_000   // 5-minute timeout
  while (Date.now() < deadline) {
    const receipt = await window.ethereum.request({
      method: 'eth_getTransactionReceipt',
      params: [hash],
    }) as { status: string } | null
    if (receipt) {
      if (receipt.status === '0x1') return
      throw new Error(`${label} reverted on-chain`)
    }
    setStatus(`Waiting for ${label} to confirm…`)
    await new Promise(r => setTimeout(r, 3000))
  }
  throw new Error(`${label} timed out — check wallet`)
}

interface Props {
  meantimeAddr:  string
  userAddress:   string | null
  chainId:       number | null
  switchNetwork: (chainId: number) => Promise<void>
}

type Step = 'idle' | 'switching' | 'approving' | 'waiting-approve' | 'burning' | 'pending' | 'done' | 'error'

export function SendPanel({ meantimeAddr, userAddress, chainId, switchNetwork }: Props) {
  const [recipient, setRecipient] = useState('')
  const [amount,    setAmount]    = useState('10')
  const [step,      setStep]      = useState<Step>('idle')
  const [status,    setStatus]    = useState('')
  const [burnTx,    setBurnTx]    = useState('')

  const onSepolia = chainId === SEPOLIA_CHAIN_ID
  const busy = step !== 'idle' && step !== 'done' && step !== 'error'

  const handleSend = async () => {
    if (!userAddress) { setStatus('Connect your wallet first.'); return }
    if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
      setStatus('Enter a valid recipient address (0x…).')
      return
    }
    if (!amount || Number(amount) <= 0) { setStatus('Enter a valid amount.'); return }

    const units        = BigInt(Math.round(Number(amount) * 1e6))
    const mintRecipient = meantimeAddr.replace('0x', '').padStart(64, '0')

    try {
      // 1. Approve CCTP TokenMessenger to spend USDC
      setStep('approving')
      setStatus('Step 1/3 — Approve Sepolia USDC for CCTP…')
      const approveTx = await sendTx(userAddress, SEPOLIA_USDC, encodeApprove(SEPOLIA_TOKEN_MESSENGER, units))

      // 2. Wait for approval to be mined before burning
      //    (depositForBurn will revert if approve isn't confirmed yet)
      setStep('waiting-approve')
      await waitForTx(approveTx, setStatus, 'approve')

      // 3. depositForBurn — burns USDC on Sepolia, emits CCTP MessageSent
      setStep('burning')
      setStatus('Step 2/3 — Confirm burn in MetaMask…')
      const burnHash = await sendTx(
        userAddress,
        SEPOLIA_TOKEN_MESSENGER,
        encodeDepositForBurn(units, ARC_DOMAIN, mintRecipient, SEPOLIA_USDC),
      )
      setBurnTx(burnHash)

      // Wait for burn to confirm on Sepolia before telling the backend.
      // This ensures the backend finds the MessageSent log in the receipt.
      await waitForTx(burnHash, setStatus, 'depositForBurn')

      // 4. Tell the backend — tx is already mined, so it processes immediately
      setStep('pending')
      setStatus('Step 3/3 — Notifying backend…')
      const res = await fetch(`${API_BASE}/api/bridge/initiate-cctp`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ txHash: burnHash, recipient }),
      })
      const body = await res.json()

      if (res.ok) {
        setStep('done')
        setStatus(`Transfer confirmed — receivable NFT will appear in the marketplace shortly.`)
      } else {
        setStep('error')
        setStatus(`Backend error: ${body.error ?? 'unknown'}`)
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      setStep('error')
      setStatus(msg.includes('user rejected') ? 'Cancelled.' : `Error: ${msg}`)
    }
  }

  return (
    <div className="send-panel">
      <h2>Send USDC → Arc</h2>
      <p className="hint">
        Burns Sepolia USDC via CCTP v1. A receivable NFT is minted on Arc immediately.
        The recipient can hold it or list it on the marketplace. Settlement arrives in ~14 minutes.
      </p>

      {!userAddress && (
        <div className="status-box warn">Connect your wallet to send.</div>
      )}

      {userAddress && !onSepolia && (
        <div className="network-prompt">
          <p>Switch to <strong>Sepolia</strong> to initiate a CCTP transfer.</p>
          <button onClick={() => switchNetwork(SEPOLIA_CHAIN_ID)} disabled={busy}>
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
              type="number" min="0.01"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              disabled={busy}
            />
          </label>
          <button onClick={handleSend} disabled={busy}>
            {busy ? status : `Send ${amount} USDC`}
          </button>
          <p className="hint small">
            Three steps: approve USDC → wait for confirmation → burn via CCTP.
          </p>
        </div>
      )}

      {!busy && status && (
        <div className={`status-box ${step === 'error' ? 'err' : step === 'done' ? 'ok' : ''}`}>
          {status}
          {burnTx && (
            <div style={{ marginTop: 6, fontSize: '0.8em', wordBreak: 'break-all' }}>
              Sepolia burn tx: {burnTx}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
