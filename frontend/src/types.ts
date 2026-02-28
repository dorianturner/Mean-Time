export interface Listing {
  reservePrice: string  // bigint as string
  paymentToken: string
}

export interface Receivable {
  tokenId:         string
  cctpMessageHash: string
  inboundToken:    string
  inboundAmount:   string
  mintedAt:        string
  beneficialOwner: string
  listing:         Listing | null
}
