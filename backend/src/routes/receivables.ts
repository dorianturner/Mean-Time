import { Router } from 'express'
import { type Store, serializeReceivable } from '../store.js'

export function buildReceivablesRouter(store: Store): Router {
  const router = Router()

  // GET /api/receivables — all active receivables
  router.get('/', (_req, res) => {
    res.json(store.snapshot().map(serializeReceivable))
  })

  // GET /api/receivables/:tokenId
  router.get('/:tokenId', (req, res) => {
    const tokenId = BigInt(req.params.tokenId)
    const r = store.get(tokenId)
    if (!r) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    res.json(serializeReceivable(r))
  })

  return router
}
