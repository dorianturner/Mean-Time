import { Router } from 'express'
import { type AppCtx } from '../ctx.js'

export function buildTokensRouter(ctx: AppCtx): Router {
  const router = Router()

  // GET /api/tokens — known token addresses + contract addresses
  router.get('/', (_req, res) => {
    res.json({
      usdc:      ctx.addresses.usdc,
      eurc:      ctx.addresses.eurc,
      meantime:  ctx.addresses.meantime,
    })
  })

  return router
}
