// Simple marketplace component without wagmi hooks
import type { Receivable } from '../types.js'

interface Props {
  receivables: Receivable[]
  tokenSymbol: (addr: string) => string
}

export function Marketplace({ receivables, tokenSymbol }: Props) {
  const listed = receivables.filter(r => r.listing)
  const myUnlisted = receivables.filter(r => !r.listing)

  return (
    <div className="marketplace">
      {myUnlisted.length > 0 && (
        <section>
          <h2>My Receivables</h2>
          {myUnlisted.map(r => (
            <div key={r.tokenId} className="card">
              <div className="card-header">
                <span>#{r.tokenId}</span>
                <span>{(Number(r.inboundAmount) / 1e6).toFixed(2)} {tokenSymbol(r.inboundToken)}</span>
              </div>
              <div className="card-body">
                <span className="status">Ready to list</span>
                <button>Connect to List</button>
              </div>
            </div>
          ))}
        </section>
      )}

      <section>
        <h2>Open Listings</h2>
        {listed.length === 0 && <p className="empty">No active listings.</p>}
        {listed.map(r => (
          <div key={r.tokenId} className="card">
            <div className="card-header">
              <span>#{r.tokenId}</span>
              <span className="price">{(Number(r.listing!.reservePrice) / 1e6).toFixed(2)} {tokenSymbol(r.listing!.paymentToken)}</span>
            </div>
            <div className="card-body">
              <span>{(Number(r.inboundAmount) / 1e6).toFixed(2)} {tokenSymbol(r.inboundToken)}</span>
              <button>Connect to Fill</button>
            </div>
          </div>
        ))}
      </section>
    </div>
  )
}
