import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { ALLOWED_ORIGIN, NETWORK, PORT } from './config.js'
import { createX402Middleware } from './x402.js'

const app = express()
app.use(
  cors({
    origin: ALLOWED_ORIGIN,
    // Let the browser read the settlement receipt the middleware attaches
    // (`PAYMENT-RESPONSE` in x402 v2; `X-PAYMENT-RESPONSE` is the v1 name).
    exposedHeaders: ['PAYMENT-RESPONSE', 'X-PAYMENT-RESPONSE'],
  }),
)

// Health check — never gated, handy for readiness probes and the client banner.
app.get('/health', (_req, res) => {
  res.json({ ok: true, network: NETWORK })
})

async function main() {
  // The x402 guard must be wired before the protected route so it runs first.
  app.use(await createX402Middleware())

  // Protected resource. Reached only after payment has settled — see x402.ts.
  app.get('/paid/quote', (_req, res) => {
    res.json({
      pair: 'XLM/USD',
      price: 0.1142,
      asOf: new Date().toISOString(),
      note: 'Unlocked with a 0.01 XLM x402 micropayment, signed by your Veil wallet.',
    })
  })

  app.listen(PORT, () => {
    console.log(`[x402] resource server → http://localhost:${PORT}`)
    console.log(`[x402] try:  curl -i http://localhost:${PORT}/paid/quote   # expect 402`)
  })
}

main().catch((err) => {
  console.error('[x402] failed to start:', err)
  process.exit(1)
})
