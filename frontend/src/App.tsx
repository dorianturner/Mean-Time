import { useState, useEffect } from 'react'
import { ConnectButton }   from './components/ConnectButton.js'
import { Marketplace }     from './components/Marketplace.js'
import { SendPanel }       from './components/SendPanel.js'
import { useReceivables }  from './hooks/useReceivables.js'
import { useTokenSymbols } from './hooks/useTokenSymbols.js'
import { useWallet }       from './hooks/useWallet.js'
import { API_BASE }        from './config.js'
import './App.css'

type Tab = 'marketplace' | 'send'

export default function App() {
  const [tab, setTab] = useState<Tab>('marketplace')

  // Fetch contract addresses from the backend so frontend + backend are always in sync
  const [meantimeAddr, setMeantimeAddr] = useState('')
  const [usdcAddr,     setUsdcAddr]     = useState('')
  const [eurcAddr,     setEurcAddr]     = useState('')

  useEffect(() => {
    fetch(`${API_BASE}/api/tokens`)
      .then(r => r.json())
      .then(d => {
        if (d.meantime) setMeantimeAddr(d.meantime)
        if (d.usdc)     setUsdcAddr(d.usdc)
        if (d.eurc)     setEurcAddr(d.eurc)
      })
      .catch(console.error)
  }, [])

  const { receivables, connected, updateReceivable } = useReceivables()
  const tokenSymbol = useTokenSymbols()
  const { address, chainId, connect, disconnect, switchNetwork } = useWallet()

  const activeListings   = receivables.filter(r => r.listing).length
  const totalReceivables = receivables.length

  // Don't render the main UI until we have addresses from the backend
  const ready = meantimeAddr !== ''

  return (
    <div className="app">
      <header>
        <div className="header-left">
          <h1>MeanTime</h1>
          <span className={`live-dot ${connected ? 'on' : 'off'}`} title={connected ? 'Live' : 'Connecting…'} />
        </div>
        <div className="header-right">
          <span className="stat-chip">{totalReceivables} receivables</span>
          <span className="stat-chip accent">{activeListings} listings</span>
          <ConnectButton address={address} connect={connect} disconnect={disconnect} />
        </div>
      </header>

      <nav>
        <button className={tab === 'marketplace' ? 'active' : ''} onClick={() => setTab('marketplace')}>
          Marketplace
        </button>
        <button className={tab === 'send' ? 'active' : ''} onClick={() => setTab('send')}>
          Send
        </button>
      </nav>

      <main>
        {!ready && (
          <div className="status-box" style={{ marginTop: 32 }}>Connecting to backend…</div>
        )}
        {ready && tab === 'marketplace' && (
          <Marketplace
            receivables={receivables}
            meantimeAddr={meantimeAddr as `0x${string}`}
            tokenSymbol={tokenSymbol}
            userAddress={address}
            chainId={chainId}
            usdcAddr={usdcAddr}
            eurcAddr={eurcAddr}
            updateReceivable={updateReceivable}
            switchNetwork={switchNetwork}
          />
        )}
        {ready && tab === 'send' && (
          <SendPanel
            meantimeAddr={meantimeAddr}
            userAddress={address}
            chainId={chainId}
            switchNetwork={switchNetwork}
          />
        )}
      </main>
    </div>
  )
}
