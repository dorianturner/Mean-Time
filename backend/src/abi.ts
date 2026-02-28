// Minimal MeanTime ABI — events we watch + functions we call
export const MEANTIME_ABI = [
  // ── Events ──────────────────────────────────────────────────────────────────
  {
    type: 'event',
    name: 'Minted',
    inputs: [
      { name: 'tokenId',         type: 'uint256', indexed: true  },
      { name: 'recipient',       type: 'address', indexed: true  },
      { name: 'inboundToken',    type: 'address', indexed: false },
      { name: 'inboundAmount',   type: 'uint256', indexed: false },
      { name: 'cctpMessageHash', type: 'bytes32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Listed',
    inputs: [
      { name: 'tokenId',      type: 'uint256', indexed: true  },
      { name: 'reservePrice', type: 'uint256', indexed: false },
      { name: 'paymentToken', type: 'address', indexed: false },
      { name: 'listedAt',     type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Delisted',
    inputs: [
      { name: 'tokenId', type: 'uint256', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'Filled',
    inputs: [
      { name: 'tokenId',      type: 'uint256', indexed: true  },
      { name: 'relayer',      type: 'address', indexed: true  },
      { name: 'seller',       type: 'address', indexed: true  },
      { name: 'paymentToken', type: 'address', indexed: false },
      { name: 'amount',       type: 'uint256', indexed: false },
      { name: 'filledAt',     type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Settled',
    inputs: [
      { name: 'tokenId',     type: 'uint256', indexed: true  },
      { name: 'recipient',   type: 'address', indexed: true  },
      { name: 'inboundToken', type: 'address', indexed: false },
      { name: 'amount',      type: 'uint256', indexed: false },
    ],
  },
  // ── Read functions ──────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'beneficialOwner',
    stateMutability: 'view',
    inputs:  [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'nftData',
    stateMutability: 'view',
    inputs:  [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      { name: 'cctpMessageHash', type: 'bytes32' },
      { name: 'inboundToken',    type: 'address' },
      { name: 'inboundAmount',   type: 'uint256' },
      { name: 'mintedAt',        type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'listings',
    stateMutability: 'view',
    inputs:  [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      { name: 'reservePrice', type: 'uint256' },
      { name: 'paymentToken', type: 'address' },
      { name: 'active',       type: 'bool'    },
    ],
  },
  // ── Write functions (bridge actions) ────────────────────────────────────────
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'cctpMessageHash', type: 'bytes32' },
      { name: 'inboundToken',    type: 'address' },
      { name: 'inboundAmount',   type: 'uint256' },
      { name: 'recipient',       type: 'address' },
    ],
    outputs: [{ name: 'tokenId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'settle',
    stateMutability: 'nonpayable',
    inputs:  [{ name: 'cctpMessageHash', type: 'bytes32' }],
    outputs: [],
  },
] as const

export const ERC20_MINT_ABI = [
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to',     type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
] as const
