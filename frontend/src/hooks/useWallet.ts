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
  const [chainId, setChainId] = useState<number | null>(null)

  useEffect(() => {
    if (!window.ethereum) return

    window.ethereum
      .request({ method: 'eth_accounts' })
      .then((accounts) => {
        const list = accounts as string[]
        setAddress(list[0]?.toLowerCase() ?? null)
      })
      .catch(() => {})

    window.ethereum
      .request({ method: 'eth_chainId' })
      .then((id) => setChainId(parseInt(id as string, 16)))
      .catch(() => {})

    const handleAccountsChange = (accounts: unknown) => {
      const list = accounts as string[]
      setAddress(list[0]?.toLowerCase() ?? null)
    }

    const handleChainChange = (id: unknown) => {
      setChainId(parseInt(id as string, 16))
    }

    window.ethereum.on('accountsChanged', handleAccountsChange)
    window.ethereum.on('chainChanged', handleChainChange)
    return () => {
      window.ethereum?.removeListener('accountsChanged', handleAccountsChange)
      window.ethereum?.removeListener('chainChanged', handleChainChange)
    }
  }, [])

  const connect = async () => {
    if (!window.ethereum) {
      alert('No wallet found. Please install MetaMask.')
      return
    }
    // wallet_requestPermissions always opens the account picker,
    // even if MetaMask already has a connected account.
    await window.ethereum.request({
      method: 'wallet_requestPermissions',
      params: [{ eth_accounts: {} }],
    })
    const accounts = await window.ethereum.request({ method: 'eth_accounts' }) as string[]
    setAddress(accounts[0]?.toLowerCase() ?? null)
  }

  const disconnect = () => {
    // MetaMask doesn't support programmatic disconnect; we just clear local state.
    setAddress(null)
  }

  const switchNetwork = async (chainId: number) => {
    if (!window.ethereum) return
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: `0x${chainId.toString(16)}` }],
      })
    } catch (err: unknown) {
      // Chain not added yet — add it for Arc testnet
      if ((err as { code?: number }).code === 4902 && chainId === 5042002) {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: '0x4cef52',
            chainName: 'Arc Network Testnet',
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: ['https://rpc.testnet.arc.network'],
            blockExplorerUrls: [],
          }],
        })
      }
    }
  }

  return { address, chainId, connect, disconnect, switchNetwork }
}
