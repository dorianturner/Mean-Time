// HTTP route tests via supertest.
// Uses a mock AppCtx so no real chain or wallet needed.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import http from 'http'
import { createApp } from '../src/app.js'
import { createStore } from '../src/store.js'
import { mockCtx, makeReceivable } from './helpers.js'

// Read the first N bytes from an SSE endpoint then destroy the connection
function sseFirstChunk(app: ReturnType<typeof createApp>): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app).listen(0, () => {
      const port = (server.address() as { port: number }).port
      const req = http.get(`http://localhost:${port}/api/sse`, (res) => {
        let data = ''
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString()
          if (data.includes('\n\n')) {
            req.destroy()
            server.close()
            resolve(data)
          }
        })
        res.on('error', reject)
      })
      req.on('error', (e: NodeJS.ErrnoException) => {
        if (e.code !== 'ECONNRESET') reject(e)  // ECONNRESET is expected after destroy
        server.close()
        resolve('')
      })
      setTimeout(() => { server.close(); resolve('') }, 2000)
    })
  })
}

function setup() {
  const ctx   = mockCtx()
  const store = createStore()
  const app   = createApp(ctx, store)
  return { ctx, store, app }
}

// ── Health ────────────────────────────────────────────────────────────────────
describe('GET /health', () => {
  it('returns 200 { ok: true }', async () => {
    const { app } = setup()
    const res = await request(app).get('/health')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })
})

// ── GET /api/tokens ───────────────────────────────────────────────────────────
describe('GET /api/tokens', () => {
  it('returns known token addresses', async () => {
    const { app } = setup()
    const res = await request(app).get('/api/tokens')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      usdc:     '0xUsdcAddress',
      eurc:     '0xEurcAddress',
      meantime: '0xMeantimeAddress',
    })
  })
})

// ── GET /api/receivables ──────────────────────────────────────────────────────
describe('GET /api/receivables', () => {
  it('returns empty array when store is empty', async () => {
    const { app } = setup()
    const res = await request(app).get('/api/receivables')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  it('returns all receivables in serialised form', async () => {
    const { app, store } = setup()
    store.upsert(makeReceivable(1n))
    store.upsert(makeReceivable(2n, { inboundAmount: 2_000_000n }))

    const res = await request(app).get('/api/receivables')
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(2)
    // bigints serialised as strings
    expect(res.body[0].tokenId).toMatch(/^\d+$/)
    expect(res.body[0].inboundAmount).toMatch(/^\d+$/)
  })

  it('serialises an active listing', async () => {
    const { app, store } = setup()
    store.upsert(makeReceivable(1n, {
      listing: { reservePrice: 990_000n, paymentToken: '0xEurcAddress' as `0x${string}` },
    }))

    const res = await request(app).get('/api/receivables')
    expect(res.body[0].listing).toEqual({
      reservePrice: '990000',
      paymentToken: '0xEurcAddress',
    })
  })
})

// ── GET /api/receivables/:tokenId ─────────────────────────────────────────────
describe('GET /api/receivables/:tokenId', () => {
  it('returns 404 for unknown tokenId', async () => {
    const { app } = setup()
    const res = await request(app).get('/api/receivables/99')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Not found' })
  })

  it('returns the receivable when found', async () => {
    const { app, store } = setup()
    store.upsert(makeReceivable(5n))

    const res = await request(app).get('/api/receivables/5')
    expect(res.status).toBe(200)
    expect(res.body.tokenId).toBe('5')
  })
})

// ── GET /api/sse ──────────────────────────────────────────────────────────────
describe('GET /api/sse', () => {
  it('responds with text/event-stream and sends snapshot immediately', async () => {
    const { app, store } = setup()
    store.upsert(makeReceivable(1n))

    const data = await sseFirstChunk(app)

    expect(data).toContain('event: snapshot')
    expect(data).toContain('"tokenId"')
  }, 5000)

  it('snapshot is an empty array when store is empty', async () => {
    const { app } = setup()

    const data = await sseFirstChunk(app)

    expect(data).toContain('event: snapshot')
    expect(data).toContain('data: []')
  }, 5000)
})

// ── POST /api/bridge/settle ───────────────────────────────────────────────────
describe('POST /api/bridge/settle', () => {
  it('returns 400 when cctpMessageHash is missing', async () => {
    const { app } = setup()
    const res = await request(app).post('/api/bridge/settle').send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/cctpMessageHash/)
  })

  it('calls writeContract and returns txHash', async () => {
    const { app, ctx } = setup()
    const res = await request(app)
      .post('/api/bridge/settle')
      .send({ cctpMessageHash: '0x' + 'aa'.repeat(32) })

    expect(res.status).toBe(200)
    expect(res.body.txHash).toBe('0xdeadbeeftxhash')
    expect(ctx.walletClient.writeContract).toHaveBeenCalledOnce()
  })

  it('keccak256s a non-hex hash before passing to contract', async () => {
    const { app, ctx } = setup()
    await request(app)
      .post('/api/bridge/settle')
      .send({ cctpMessageHash: 'some-readable-id' })

    const call = (ctx.walletClient.writeContract as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.args[0]).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('returns 500 when writeContract throws', async () => {
    const ctx = mockCtx({
      walletClient: {
        writeContract: vi.fn().mockRejectedValue(new Error('revert')),
      } as unknown as ReturnType<typeof mockCtx>['walletClient'],
    })
    const store = createStore()
    const app   = createApp(ctx, store)

    const res = await request(app)
      .post('/api/bridge/settle')
      .send({ cctpMessageHash: '0x' + 'aa'.repeat(32) })

    expect(res.status).toBe(500)
    expect(res.body.error).toMatch(/revert/)
  })
})
