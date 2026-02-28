import { useEffect, useState } from 'react'
import { API_BASE } from '../config.js'
import type { Receivable } from '../types.js'

// Keeps receivables in sync via SSE.
// On connect: server sends a full snapshot as the first 'snapshot' event.
// Subsequent events patch the local state incrementally.
export function useReceivables() {
  const [receivables, setReceivables] = useState<Map<string, Receivable>>(new Map())
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    const es = new EventSource(`${API_BASE}/api/sse`)

    es.addEventListener('snapshot', (e) => {
      const items: Receivable[] = JSON.parse(e.data)
      setReceivables(new Map(items.map(r => [r.tokenId, r])))
      setConnected(true)
    })

    es.addEventListener('minted', (e) => {
      const r: Receivable = JSON.parse(e.data)
      setReceivables(prev => new Map(prev).set(r.tokenId, r))
    })

    es.addEventListener('listed', (e) => {
      const { tokenId, reservePrice, paymentToken } = JSON.parse(e.data)
      setReceivables(prev => {
        const next = new Map(prev)
        const r = next.get(tokenId)
        if (r) next.set(tokenId, { ...r, listing: { reservePrice, paymentToken } })
        return next
      })
    })

    es.addEventListener('delisted', (e) => {
      const { tokenId } = JSON.parse(e.data)
      setReceivables(prev => {
        const next = new Map(prev)
        const r = next.get(tokenId)
        if (r) next.set(tokenId, { ...r, listing: null })
        return next
      })
    })

    es.addEventListener('filled', (e) => {
      const { tokenId, newOwner } = JSON.parse(e.data)
      setReceivables(prev => {
        const next = new Map(prev)
        const r = next.get(tokenId)
        if (r) next.set(tokenId, { ...r, beneficialOwner: newOwner, listing: null })
        return next
      })
    })

    es.addEventListener('settled', (e) => {
      const { tokenId } = JSON.parse(e.data)
      setReceivables(prev => {
        const next = new Map(prev)
        next.delete(tokenId)
        return next
      })
    })

    es.onerror = () => setConnected(false)

    return () => es.close()
  }, [])

  // Optimistic local update — apply immediately without waiting for SSE
  const updateReceivable = (tokenId: string, patch: Partial<Receivable>) => {
    setReceivables(prev => {
      const next = new Map(prev)
      const r = next.get(tokenId)
      if (r) next.set(tokenId, { ...r, ...patch })
      return next
    })
  }

  return { receivables: Array.from(receivables.values()), connected, updateReceivable }
}
