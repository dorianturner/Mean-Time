interface Props {
  address: string | null
  connect: () => void
}

export function ConnectButton({ address, connect }: Props) {
  if (address) {
    return (
      <span className="wallet-address">
        {address.slice(0, 6)}…{address.slice(-4)}
      </span>
    )
  }
  return (
    <button className="connect-btn" onClick={connect}>
      Connect
    </button>
  )
}
