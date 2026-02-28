import { Router, type Request, type Response } from 'express'
import { type Store, serializeReceivable, type StoreEvent } from '../store.js'

export function buildSseRouter(store: Store): Router {
  const router = Router()

  // GET /api/sse — Server-Sent Events stream
  // On connect: sends a full snapshot so the client doesn't miss state.
  // Then streams incremental events as they arrive.
  router.get('/', (req: Request, res: Response) => {
    res.setHeader('Content-Type',  'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection',    'keep-alive')
    res.flushHeaders()

    const send = (eventName: string, data: unknown) => {
      res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    // 1. Send snapshot immediately so the UI can render without a separate fetch
    send('snapshot', store.snapshot().map(serializeReceivable))

    // 2. Subscribe to incremental updates
    const unsubscribe = store.subscribe((event: StoreEvent) => {
      switch (event.type) {
        case 'minted':
          send('minted', serializeReceivable(event.receivable))
          break
        case 'listed':
          send('listed', {
            tokenId:      event.tokenId.toString(),
            reservePrice: event.listing.reservePrice.toString(),
            paymentToken: event.listing.paymentToken,
          })
          break
        case 'delisted':
          send('delisted', { tokenId: event.tokenId.toString() })
          break
        case 'filled':
          send('filled', {
            tokenId:  event.tokenId.toString(),
            newOwner: event.newOwner,
          })
          break
        case 'settled':
          send('settled', { tokenId: event.tokenId.toString() })
          break
      }
    })

    // Keep-alive ping every 25 s to prevent proxy timeouts
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000)

    req.on('close', () => {
      clearInterval(keepAlive)
      unsubscribe()
    })
  })

  return router
}
