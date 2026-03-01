// Hook for MeanTime contract write actions: list, delist, fill
// Uses viem with window.ethereum directly — no wagmi needed

import { useCallback } from 'react'
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
} from 'viem'
import { MEANTIME_ABI, ERC20_ABI } from '../abi.js'

const MEANTIME_ADDR = (import.meta.env.VITE_MEANTIME_ADDR ?? '0x7b3ae61DAe4bFB32A0bF1A79518337a63cBF1Acc') as `0x${string}`

const ARC_CHAIN = {
  id:   5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [import.meta.env.VITE_RPC_URL ?? 'https://rpc.testnet.arc.network'] } },
} as const

function getClients(address: string) {
  if (!window.ethereum) throw new Error('No wallet')

  const publicClient = createPublicClient({
    chain: ARC_CHAIN,
    transport: http(ARC_CHAIN.rpcUrls.default.http[0]),
  })

  const walletClient = createWalletClient({
    chain: ARC_CHAIN,
    transport: custom(window.ethereum),
    account: address as `0x${string}`,
  })

  return { publicClient, walletClient }
}

export function useContractActions(walletAddress: string | null) {
  const list = useCallback(
    async (tokenId: bigint, reservePrice: bigint, paymentToken: `0x${string}`) => {
      if (!walletAddress) throw new Error('Wallet not connected')
      const { walletClient } = getClients(walletAddress)

      const hash = await walletClient.writeContract({
        address:      MEANTIME_ADDR,
        abi:          MEANTIME_ABI,
        functionName: 'list',
        args:         [tokenId, reservePrice, paymentToken],
        account:      walletAddress as `0x${string}`,
        chain:        ARC_CHAIN,
      })
      return hash
    },
    [walletAddress],
  )

  const delist = useCallback(
    async (tokenId: bigint) => {
      if (!walletAddress) throw new Error('Wallet not connected')
      const { walletClient } = getClients(walletAddress)

      const hash = await walletClient.writeContract({
        address:      MEANTIME_ADDR,
        abi:          MEANTIME_ABI,
        functionName: 'delist',
        args:         [tokenId],
        account:      walletAddress as `0x${string}`,
        chain:        ARC_CHAIN,
      })
      return hash
    },
    [walletAddress],
  )

  const fill = useCallback(
    async (tokenId: bigint, paymentToken: `0x${string}`, amount: bigint) => {
      if (!walletAddress) throw new Error('Wallet not connected')
      const { publicClient, walletClient } = getClients(walletAddress)

      // Check allowance and approve if needed
      const allowance = await publicClient.readContract({
        address:      paymentToken,
        abi:          ERC20_ABI,
        functionName: 'allowance',
        args:         [walletAddress as `0x${string}`, MEANTIME_ADDR],
      }) as bigint

      if (allowance < amount) {
        const approveTx = await walletClient.writeContract({
          address:      paymentToken,
          abi:          ERC20_ABI,
          functionName: 'approve',
          args:         [MEANTIME_ADDR, amount],
          account:      walletAddress as `0x${string}`,
          chain:        ARC_CHAIN,
        })
        // Wait for approval to be mined
        await publicClient.waitForTransactionReceipt({ hash: approveTx })
      }

      const hash = await walletClient.writeContract({
        address:      MEANTIME_ADDR,
        abi:          MEANTIME_ABI,
        functionName: 'fill',
        args:         [tokenId],
        account:      walletAddress as `0x${string}`,
        chain:        ARC_CHAIN,
      })
      return hash
    },
    [walletAddress],
  )

  return { list, delist, fill }
}
