import { useState } from 'react'
import { ConnectButton }   from './components/ConnectButton.js'
import { Marketplace }     from './components/Marketplace.js'
import { BridgePanel }     from './components/BridgePanel.js'
import { useReceivables }  from './hooks/useReceivables.js'
import { useTokenSymbols } from './hooks/useTokenSymbols.js'
import { useWallet }       from './hooks/useWallet.js'
import './App.css'

const MEANTIME_ADDR = (import.meta.env.VITE_MEANTIME_ADDR ?? '0xff022c195F9e3bA7c16ac5DEE5c42579928eAC59') as `0x${string}`
const USDC_ADDR     = import.meta.env.VITE_USDC_ADDR ?? '0xd082DEf36a0df2def3B64D09d4fa834A623A27C4'
const EURC_ADDR     = import.meta.env.VITE_EURC_ADDR ?? '0x507442087DFE8e7664202FAc6b7E0E5c8366ae42'

type Tab = 'marketplace' | 'bridge'

export default function App() {
  const [tab, setTab]              = useState<Tab>('marketplace')
  const { receivables, connected } = useReceivables()
  const tokenSymbol                = useTokenSymbols()
  const { address, connect }       = useWallet()

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
          <ConnectButton address={address} connect={connect} />
        </div>
      </header>

      <nav>
        <button className={tab === 'marketplace' ? 'active' : ''} onClick={() => setTab('marketplace')}>
          Marketplace
        </button>
        <button className={tab === 'bridge' ? 'active' : ''} onClick={() => setTab('bridge')}>
          Bridge Simulator
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
        {tab === 'bridge' && (
          <BridgePanel usdcAddr={USDC_ADDR} eurcAddr={EURC_ADDR} />
        )}
      </main>
    </div>
  )
}
