import type { Request, RequestHandler, Response } from 'express'
import {
  x402ResourceServer,
  x402HTTPResourceServer,
  type FacilitatorClient,
  type HTTPAdapter,
  type HTTPRequestContext,
  type HTTPResponseInstructions,
  type RoutesConfig,
} from '@x402/core/server'
import { x402Facilitator } from '@x402/core/facilitator'
import type { AssetAmount, SupportedResponse } from '@x402/core/types'
import { createEd25519Signer } from '@x402/stellar'
import { ExactStellarScheme as ExactStellarServerScheme } from '@x402/stellar/exact/server'
import { ExactStellarScheme as ExactStellarFacilitatorScheme } from '@x402/stellar/exact/facilitator'
import {
  FACILITATOR_SECRET,
  NETWORK,
  PAY_TO,
  PRICE_STROOPS,
  RPC_URL,
  XLM_SAC_ADDRESS,
} from './config.js'

/**
 * The route we charge for and the price: exactly 0.01 XLM, expressed as the
 * native asset's Stellar Asset Contract (SAC) address plus a stroop amount.
 * Passing an explicit {@link AssetAmount} (rather than a `"$0.01"` money
 * string) keeps the charge denominated in XLM instead of the default USDC.
 */
const PRICE: AssetAmount = { asset: XLM_SAC_ADDRESS, amount: PRICE_STROOPS }

const ROUTES: RoutesConfig = {
  'GET /paid/quote': {
    description: 'Premium price quote — 0.01 XLM per call',
    accepts: {
      scheme: 'exact',
      network: NETWORK,
      payTo: PAY_TO || facilitatorAddress(),
      price: PRICE,
      maxTimeoutSeconds: 120,
    },
  },
}

/**
 * Builds the in-process facilitator. It owns the funded testnet key, verifies
 * the client's signed payment transaction, and settles it on-chain (sponsoring
 * the network fee). Exposing it as a {@link FacilitatorClient} lets the resource
 * server treat it exactly like a remote facilitator — no HTTP hop required.
 */
function createLocalFacilitatorClient(): FacilitatorClient {
  const signer = createEd25519Signer(FACILITATOR_SECRET, NETWORK)
  const scheme = new ExactStellarFacilitatorScheme([signer], {
    rpcConfig: { url: RPC_URL },
    areFeesSponsored: true,
  })
  const facilitator = new x402Facilitator().register(NETWORK, scheme)

  return {
    verify: (payload, requirements) => facilitator.verify(payload, requirements),
    settle: (payload, requirements) => facilitator.settle(payload, requirements),
    getSupported: async () => facilitator.getSupported() as SupportedResponse,
  }
}

function facilitatorAddress(): string {
  return createEd25519Signer(FACILITATOR_SECRET, NETWORK).address
}

/** Adapts an Express {@link Request} to the framework-agnostic x402 HTTPAdapter. */
function expressAdapter(req: Request): HTTPAdapter {
  return {
    getHeader: (name) => req.header(name) ?? undefined,
    getMethod: () => req.method,
    getPath: () => req.path,
    getUrl: () => req.originalUrl,
    getAcceptHeader: () => req.header('accept') ?? '',
    getUserAgent: () => req.header('user-agent') ?? '',
    getQueryParams: () => req.query as Record<string, string | string[]>,
    getBody: () => req.body,
  }
}

function send(res: Response, instructions: HTTPResponseInstructions): void {
  for (const [name, value] of Object.entries(instructions.headers)) {
    res.setHeader(name, value)
  }
  res.status(instructions.status)
  if (instructions.isHtml) res.type('html')
  res.send(instructions.body)
}

/**
 * Creates the Express middleware that guards the configured routes with x402.
 *
 * For every request to a protected route it:
 *   1. Returns **402 Payment Required** (with the payment requirements in the
 *      body) when there is no valid `X-PAYMENT` header.
 *   2. Verifies the payment, **settles it on Stellar**, sets the
 *      `X-PAYMENT-RESPONSE` header, and lets the route handler return **200**
 *      when payment is valid.
 *
 * Settlement happens before the handler runs, so a client only ever receives
 * the paid response once its 0.01 XLM has actually been submitted to the
 * network — there is no "serve first, settle maybe" gap.
 */
export async function createX402Middleware(): Promise<RequestHandler> {
  const resourceServer = new x402ResourceServer(createLocalFacilitatorClient())
  resourceServer.register(NETWORK, new ExactStellarServerScheme())

  const httpServer = new x402HTTPResourceServer(resourceServer, ROUTES)
  await httpServer.initialize()

  return async function x402Guard(req, res, next) {
    const context: HTTPRequestContext = {
      adapter: expressAdapter(req),
      path: req.path,
      method: req.method,
      // x402 v2 sends the signed payload in `PAYMENT-SIGNATURE`; `X-PAYMENT`
      // is the v1 name. The processor also reads it via the adapter, but we set
      // it here so v1 clients are handled too.
      paymentHeader: req.header('payment-signature') ?? req.header('x-payment') ?? undefined,
    }

    let result
    try {
      result = await httpServer.processHTTPRequest(context)
    } catch (err) {
      next(err)
      return
    }

    if (result.type === 'no-payment-required') {
      next()
      return
    }

    // No payment / invalid payment → emit the 402 (or error) instructions as-is.
    if (result.type === 'payment-error') {
      send(res, result.response)
      return
    }

    // Payment verified → settle on-chain, then let the handler serve the data.
    const settlement = await httpServer.processSettlement(
      result.paymentPayload,
      result.paymentRequirements,
      result.declaredExtensions,
    )

    if (!settlement.success) {
      send(res, settlement.response)
      return
    }

    for (const [name, value] of Object.entries(settlement.headers)) {
      res.setHeader(name, value)
    }
    next()
  }
}
