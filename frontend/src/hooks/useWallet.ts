import { useState, useEffect } from 'react'

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
      on: (event: string, handler: (...args: unknown[]) => void) => void
      removeListener: (event: string, handler: (...args: unknown[]) => void) => void
    }
  }
}

export function useWallet() {
  const [address, setAddress] = useState<string | null>(null)

  useEffect(() => {
    if (!window.ethereum) return

    // Read whichever account is already exposed (no popup)
    window.ethereum
      .request({ method: 'eth_accounts' })
      .then((accounts) => {
        const list = accounts as string[]
        setAddress(list[0]?.toLowerCase() ?? null)
      })
      .catch(() => {})

    const handleChange = (accounts: unknown) => {
      const list = accounts as string[]
      setAddress(list[0]?.toLowerCase() ?? null)
    }

    window.ethereum.on('accountsChanged', handleChange)
    return () => window.ethereum?.removeListener('accountsChanged', handleChange)
  }, [])

  const connect = async () => {
    if (!window.ethereum) {
      alert('No wallet found. Please install MetaMask.')
      return
    }
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' }) as string[]
    setAddress(accounts[0]?.toLowerCase() ?? null)
  }

  return { address, connect }
}
