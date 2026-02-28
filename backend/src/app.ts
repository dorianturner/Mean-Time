import express from 'express'
import cors from 'cors'
import { type AppCtx } from './ctx.js'
import { type Store } from './store.js'
import { buildReceivablesRouter } from './routes/receivables.js'
import { buildTokensRouter }      from './routes/tokens.js'
import { buildSseRouter }         from './routes/sse.js'
import { buildBridgeRouter }      from './routes/bridge.js'

export function createApp(ctx: AppCtx, store: Store) {
  const app = express()

  app.use(cors())
  app.use(express.json())

  // Health check
  app.get('/health', (_req, res) => res.json({ ok: true }))

  app.use('/api/receivables', buildReceivablesRouter(store))
  app.use('/api/tokens',      buildTokensRouter(ctx))
  app.use('/api/sse',         buildSseRouter(store))
  app.use('/api/bridge',      buildBridgeRouter(ctx))

  return app
}
