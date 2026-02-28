import { useState } from 'react'
import { ConnectButton }   from './components/ConnectButton.js'
import { Marketplace }     from './components/Marketplace.js'
import { BridgePanel }     from './components/BridgePanel.js'
import { useReceivables }  from './hooks/useReceivables.js'
import { useTokenSymbols } from './hooks/useTokenSymbols.js'
import { useWallet }       from './hooks/useWallet.js'
import './App.css'

const MEANTIME_ADDR = (import.meta.env.VITE_MEANTIME_ADDR ?? '0x93d33482ac86Fb47ABfD7F83938D9940469aB9db') as `0x${string}`
const USDC_ADDR     = import.meta.env.VITE_USDC_ADDR ?? '0x18b2F69F554dcBdc0aF1A7Eaf3540075327A477D'
const EURC_ADDR     = import.meta.env.VITE_EURC_ADDR ?? '0xBE756BAB8aC57C89B07Bb900cE9D8E97a61D622F'

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
          />
        )}
        {tab === 'bridge' && (
          <BridgePanel usdcAddr={USDC_ADDR} eurcAddr={EURC_ADDR} />
        )}
      </main>
    </div>
  )
}
