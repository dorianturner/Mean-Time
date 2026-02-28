import { useState } from 'react'
import { ConnectButton }   from './components/ConnectButton.js'
import { Marketplace }     from './components/Marketplace.js'
import { SendPanel }       from './components/SendPanel.js'
import { useReceivables }  from './hooks/useReceivables.js'
import { useTokenSymbols } from './hooks/useTokenSymbols.js'
import { useWallet }       from './hooks/useWallet.js'
import './App.css'

const MEANTIME_ADDR = (import.meta.env.VITE_MEANTIME_ADDR ?? '0x0769d1d0662894dC29cdADE1102411D2a059cc1c') as `0x${string}`
const USDC_ADDR     = import.meta.env.VITE_USDC_ADDR ?? '0xBc7f753Da5b2050bdc7F1cc7DB9FEcF0368adA34'
const EURC_ADDR     = import.meta.env.VITE_EURC_ADDR ?? '0xa1E57ECab96596b36bf60B0191b2D4fDDc554847'

type Tab = 'marketplace' | 'send'

export default function App() {
  const [tab, setTab]              = useState<Tab>('marketplace')
  const { receivables, connected } = useReceivables()
  const tokenSymbol                = useTokenSymbols()
  const { address, chainId, connect, disconnect, switchNetwork } = useWallet()

  const activeListings   = receivables.filter(r => r.listing).length
  const totalReceivables = receivables.length

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
        {tab === 'marketplace' && (
          <Marketplace
            receivables={receivables}
            meantimeAddr={MEANTIME_ADDR}
            tokenSymbol={tokenSymbol}
            userAddress={address}
            usdcAddr={USDC_ADDR}
            eurcAddr={EURC_ADDR}
          />
        )}
        {tab === 'send' && (
          <SendPanel
            meantimeAddr={MEANTIME_ADDR}
            userAddress={address}
            chainId={chainId}
            switchNetwork={switchNetwork}
          />
        )}
      </main>
    </div>
  )
}
