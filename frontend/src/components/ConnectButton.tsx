interface Props {
  address: string | null
  connect: () => void
  disconnect: () => void
}

export function ConnectButton({ address, connect, disconnect }: Props) {
  if (address) {
    return (
      <div className="wallet-connected">
        <span className="wallet-address">
          {address.slice(0, 6)}…{address.slice(-4)}
        </span>
        <button className="disconnect-btn" onClick={disconnect}>
          Disconnect
        </button>
      </div>
    )
  }
  return (
    <button className="connect-btn" onClick={connect}>
      Connect Wallet
    </button>
  )
}
