import { useEffect, useState } from 'react'
import { API_BASE } from '../config.js'

interface TokenMap { usdc: string; eurc: string }

export function useTokenSymbols() {
  const [tokens, setTokens] = useState<TokenMap | null>(null)

  useEffect(() => {
    fetch(`${API_BASE}/api/tokens`)
      .then(r => r.json())
      .then(setTokens)
      .catch(console.error)
  }, [])

  return (address: string): string => {
    if (!tokens) return address.slice(0, 6) + '…'
    if (address.toLowerCase() === tokens.usdc.toLowerCase()) return 'USDC'
    if (address.toLowerCase() === tokens.eurc.toLowerCase()) return 'EURC'
    return address.slice(0, 6) + '…'
  }
}
