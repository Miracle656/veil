/**
 * Sponsor a USDC trustline for a user who has no XLM.
 *
 * A Stellar account cannot hold USDC without a trustline, a trustline raises
 * that account's minimum reserve by 0.5 XLM, and opening one costs a fee. So a
 * user holding zero XLM cannot receive USDC and cannot fix it — the fix needs
 * the XLM they do not have. For a wallet whose product is "hold dollars", that
 * is the first wall a real user hits.
 *
 * CAP-33 sponsored reserves solve it: the sponsor's balance carries the
 * reserve, and gets it back if the trustline is ever removed.
 *
 * ## Why this is a server route
 *
 * The sponsor is a platform-funded account. Its key cannot ship in the app or
 * the web bundle — anyone could extract it and drain the float. Veil's
 * per-user fee payer cannot stand in either: it is derived from the user's own
 * WebAuthn credential, so a user with no XLM has a fee payer with no XLM.
 *
 * ## What this route does and does not do
 *
 * It returns a *partially signed* transaction: sponsored by us, still needing
 * the user's signature. It never submits. The trustline is being added to the
 * user's account, so the user must sign — and that also means this route
 * cannot be used to attach anything to an account whose key the caller does
 * not hold.
 *
 * Set `SPONSOR_SECRET_KEY` (server-only, no NEXT_PUBLIC_ prefix). Without it
 * the route reports 503 and the wallet falls back to asking the user to fund
 * their account, rather than failing mid-flow.
 */

import { Asset, BASE_FEE, Horizon, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk'

import { decideSponsorship, planSponsorship, type AccountSnapshot } from '@/lib/sponsorship'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** How long the user has to sign before the sponsorship offer expires. */
const SIGNING_WINDOW_SECONDS = 180

type Body = { address?: unknown; assetCode?: unknown; network?: unknown }

function sponsorSecret(): string {
  return process.env.SPONSOR_SECRET_KEY?.trim() || ''
}

function networkConfig(network: string) {
  return network === 'mainnet'
    ? { horizonUrl: 'https://horizon.stellar.org', passphrase: Networks.PUBLIC }
    : { horizonUrl: 'https://horizon-testnet.stellar.org', passphrase: Networks.TESTNET }
}

/** Canonical USDC issuer per network. Mainnet is Circle's; they are different assets. */
function usdcIssuer(network: string): string {
  return network === 'mainnet'
    ? 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
    : 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Read the account as the ledger sees it.
 *
 * Deliberately re-read here rather than trusted from the request: the caller
 * decides whether to *ask*, but eligibility is settled against the chain, or a
 * client could simply claim to be broke.
 */
async function loadSnapshot(server: Horizon.Server, address: string): Promise<AccountSnapshot> {
  try {
    const account = await server.loadAccount(address)
    const balances = account.balances as unknown as Array<Record<string, string | undefined>>
    const native = balances.find((b) => b.asset_type === 'native')
    return {
      exists: true,
      nativeBalance: Number(native?.balance ?? '0'),
      // Liquidity-pool shares have no asset_code; filtering to strings drops
      // them, which is right — they are not trustlines to an asset.
      trustedAssets: balances
        .map((b) => b.asset_code)
        .filter((code): code is string => typeof code === 'string'),
    }
  } catch {
    // Horizon 404s an account that has never been funded — that is a real
    // state, not an error, and it is the one most in need of sponsorship.
    return { exists: false, nativeBalance: 0, trustedAssets: [] }
  }
}

export async function POST(request: Request) {
  const secret = sponsorSecret()
  if (!secret) {
    return json(
      { error: 'Sponsorship is not configured on this deployment.', code: 'not_configured' },
      503,
    )
  }

  let body: Body
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Malformed request body.', code: 'bad_request' }, 400)
  }

  const address = typeof body.address === 'string' ? body.address.trim() : ''
  const assetCode = typeof body.assetCode === 'string' ? body.assetCode.trim().toUpperCase() : 'USDC'
  const network = body.network === 'mainnet' ? 'mainnet' : 'testnet'

  if (!/^G[A-Z2-7]{55}$/.test(address)) {
    return json({ error: 'A valid G-address is required.', code: 'bad_address' }, 400)
  }

  const { horizonUrl, passphrase } = networkConfig(network)
  const server = new Horizon.Server(horizonUrl)

  const snapshot = await loadSnapshot(server, address)
  const decision = decideSponsorship(assetCode, snapshot)

  if (!decision.sponsor) {
    // 409, not 400: the request was well formed, the account's state simply
    // does not warrant sponsorship. The message is written for a user.
    return json({ error: decision.message, code: decision.reason }, 409)
  }

  const sponsor = Keypair.fromSecret(secret)
  const plan = planSponsorship(snapshot)
  const asset = new Asset(assetCode, usdcIssuer(network))

  let sponsorAccount
  try {
    sponsorAccount = await server.loadAccount(sponsor.publicKey())
  } catch {
    return json(
      { error: 'The sponsoring account is not funded.', code: 'sponsor_unfunded' },
      503,
    )
  }

  // The sponsor is the transaction source, so the sponsor pays the fee as well
  // as carrying the reserve. A user with no XLM cannot pay a fee either.
  const builder = new TransactionBuilder(sponsorAccount, {
    fee: BASE_FEE,
    networkPassphrase: passphrase,
  })

  builder.addOperation(
    Operation.beginSponsoringFutureReserves({ sponsoredId: address }),
  )

  if (plan.createAccount) {
    // Zero starting balance: the account's own base reserve is sponsored too,
    // so it needs no XLM of its own to exist.
    builder.addOperation(
      Operation.createAccount({ destination: address, startingBalance: '0' }),
    )
  }

  builder.addOperation(Operation.changeTrust({ asset, source: address }))
  builder.addOperation(Operation.endSponsoringFutureReserves({ source: address }))

  const tx = builder.setTimeout(SIGNING_WINDOW_SECONDS).build()
  tx.sign(sponsor)

  return json(
    {
      xdr: tx.toXDR(),
      network,
      assetCode,
      sponsor: sponsor.publicKey(),
      reserveCostXlm: plan.reserveCostXlm,
      createsAccount: plan.createAccount,
      expiresInSeconds: SIGNING_WINDOW_SECONDS,
    },
    200,
  )
}
