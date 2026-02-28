graph TD
    A[Ethereum: User Burns USDC] -->|CCTP MessageSent| B(Relayer/Oracle)
    B -->|Trigger Mint| C[Arc: MeanTime Contract]
    C -->|Mints NFT| D[Secondary Market: User sells NFT]
    D -->|Instant Payout| E[Mr. D buys for $995]
    F[Circle Attestation Arrives] -->|Verified| C
    C -->|Automatic Settlement| G[USDC Released to Mr. D]




source .env
forge script contracts/scripts/DeployHello.s.sol:DeployHello --rpc-url $ARC_RPC_URL --broadcast


