declare global {
  interface Window { ethereum?: { request: (args: { method: string }) => Promise<string[]> } }
}

export function ConnectButton() {
  const connect = async () => {
    if (!window.ethereum) {
      alert('No wallet found. Please install MetaMask.')
      return
    }
    try {
      await window.ethereum.request({ method: 'eth_requestAccounts' })
      window.location.reload()
    } catch (err) {
      console.error('Connect error:', err)
    }
  }

  return (
    <button className="connect-btn" onClick={connect}>
      Connect
    </button>
  )
}
