import 'dotenv/config'
import { buildCtx }     from './ctx.js'
import { createStore }  from './store.js'
import { startWatcher } from './watcher.js'
import { createApp }    from './app.js'

const PORT = Number(process.env.PORT ?? 3001)

const ctx   = buildCtx()
const store = createStore()

// Start watching contract events
const stopWatcher = startWatcher(ctx, store)

const app = createApp(ctx, store)

const server = app.listen(PORT, () => {
  console.log(`MeanTime backend listening on http://localhost:${PORT}`)
  console.log(`  MeanTime: ${ctx.addresses.meantime}`)
  console.log(`  USDC:     ${ctx.addresses.usdc}`)
  console.log(`  EURC:     ${ctx.addresses.eurc}`)
})

process.on('SIGTERM', () => {
  stopWatcher()
  server.close(() => process.exit(0))
})

process.on('SIGINT', () => {
  stopWatcher()
  server.close(() => process.exit(0))
})
