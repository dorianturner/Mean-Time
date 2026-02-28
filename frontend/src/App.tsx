import { useState } from 'react'
import { ConnectButton }   from './components/ConnectButton.js'
import { Marketplace }     from './components/Marketplace.js'
import { SendPanel }       from './components/SendPanel.js'
import { useReceivables }  from './hooks/useReceivables.js'
import { useTokenSymbols } from './hooks/useTokenSymbols.js'
import { useWallet }       from './hooks/useWallet.js'
import './App.css'

const MEANTIME_ADDR = (import.meta.env.VITE_MEANTIME_ADDR ?? '0x7b3ae61DAe4bFB32A0bF1A79518337a63cBF1Acc') as `0x${string}`
const USDC_ADDR     = import.meta.env.VITE_USDC_ADDR ?? '0xf854088BdeEC62DafF50Cf1a2C06afE97bBe9711'
const EURC_ADDR     = import.meta.env.VITE_EURC_ADDR ?? '0x9594496D0Cda45B30BB15d905D5e224626b44688'

type Tab = 'marketplace' | 'bridge'

export default function App() {
  const [tab, setTab]              = useState<Tab>('marketplace')
  const { receivables, connected, updateReceivable } = useReceivables()
  const tokenSymbol                = useTokenSymbols()
  const { address, chainId, connect, switchNetwork } = useWallet()

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
            chainId={chainId}
            usdcAddr={USDC_ADDR}
            eurcAddr={EURC_ADDR}
            updateReceivable={updateReceivable}
            switchNetwork={switchNetwork}
          />
        )}
        {tab === 'bridge' && (
          <SendPanel
            meantimeAddr={MEANTIME_ADDR}
            userAddress={address}
            chainId={chainId}
            usdcAddr={USDC_ADDR}
            eurcAddr={EURC_ADDR}
            switchNetwork={switchNetwork}
          />
        )}
      </main>
    </div>
  )
}
