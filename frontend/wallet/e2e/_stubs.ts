/**
 * Network stubs for the wallet E2E suite.
 *
 * The suite must run offline: CI has no funded testnet signer, so every call
 * that would otherwise hit friendbot / Horizon / Soroban RPC is intercepted
 * here.
 *
 * Two things matter and are easy to get wrong:
 *
 *  1. Match by hostname, not by URL glob. The RPC URL has no path, so the
 *     browser normalises it to `https://soroban-testnet.stellar.org/` — a
 *     trailing slash a glob like `**\/soroban-testnet.stellar.org` does not
 *     match, and the request silently escapes to the real network.
 *
 *  2. Every XDR blob must actually decode. stellar-sdk parses `transactionData`,
 *     `resultXdr` and `resultMetaXdr` eagerly, so hand-written placeholder
 *     base64 throws "attempt to read outside the boundary of the buffer"
 *     instead of stubbing anything. Build them with the XDR types below.
 */

import { xdr } from '@stellar/stellar-sdk'
import type { Page } from '@playwright/test'

const FRIENDBOT_HOST = 'friendbot.stellar.org'
const HORIZON_HOST = 'horizon-testnet.stellar.org'
const SOROBAN_HOST = 'soroban-testnet.stellar.org'

const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015'
const LATEST_LEDGER = 1000
const FAKE_TX_HASH = 'a'.repeat(64)

// ── XDR builders ──────────────────────────────────────────────────────────────

/** Minimal-but-valid Soroban footprint, enough for `assembleTransaction`. */
function transactionDataXdr(): string {
  return new xdr.SorobanTransactionData({
    ext: new xdr.SorobanTransactionDataExt(0),
    resources: new xdr.SorobanResources({
      footprint: new xdr.LedgerFootprint({ readOnly: [], readWrite: [] }),
      instructions: 0,
      diskReadBytes: 0,
      writeBytes: 0,
    }),
    resourceFee: xdr.Int64.fromString('100'),
  }).toXDR('base64')
}

function successResultXdr(): string {
  return new xdr.TransactionResult({
    feeCharged: xdr.Int64.fromString('100'),
    result: xdr.TransactionResultResult.txSuccess([]),
    ext: new xdr.TransactionResultExt(0),
  }).toXDR('base64')
}

function successMetaXdr(): string {
  return new xdr.TransactionMeta(
    3,
    new xdr.TransactionMetaV3({
      ext: new xdr.ExtensionPoint(0),
      txChangesBefore: [],
      operations: [],
      txChangesAfter: [],
      sorobanMeta: new xdr.SorobanTransactionMeta({
        ext: new xdr.SorobanTransactionMetaExt(0),
        events: [],
        returnValue: xdr.ScVal.scvVoid(),
        diagnosticEvents: [],
      }),
    }),
  ).toXDR('base64')
}

// ── Horizon ───────────────────────────────────────────────────────────────────

function fundedAccount(pubkey: string) {
  return {
    id: pubkey,
    account_id: pubkey,
    sequence: '123456789',
    subentry_count: 0,
    balances: [
      {
        asset_type: 'native',
        balance: '10000.0000000',
        buying_liabilities: '0.0000000',
        selling_liabilities: '0.0000000',
      },
    ],
    thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
    signers: [{ weight: 1, key: pubkey, type: 'ed25519_public_key' }],
    data: {},
    // `checkMemoRequired` reads `data_attr['config.memo_required']` directly on
    // every payment, so omitting this throws before the transaction is built.
    data_attr: {},
    paging_token: '',
    last_modified_ledger: LATEST_LEDGER,
  }
}

// ── Soroban JSON-RPC ──────────────────────────────────────────────────────────

/**
 * The envelope submitted via `sendTransaction`, echoed back by `getTransaction`.
 * Fabricating one is not an option — stellar-sdk decodes it.
 */
let lastSubmittedEnvelope: string | null = null

function rpcResult(id: unknown, result: unknown) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ jsonrpc: '2.0', id: id ?? 1, result }),
  }
}

function handleRpc(method: string | undefined, params: any, id: unknown) {
  switch (method) {
    case 'getNetwork':
      return rpcResult(id, {
        passphrase: TESTNET_PASSPHRASE,
        protocolVersion: 22,
        friendbotUrl: `https://${FRIENDBOT_HOST}`,
      })

    case 'getLatestLedger':
      return rpcResult(id, {
        id: 'e'.repeat(64),
        protocolVersion: 22,
        sequence: LATEST_LEDGER,
      })

    // No contract data on a stubbed chain. Callers treat an empty result as
    // "not deployed yet", which is the state these tests start from.
    case 'getLedgerEntries':
      return rpcResult(id, { entries: [], latestLedger: LATEST_LEDGER })

    case 'simulateTransaction':
      return rpcResult(id, {
        transactionData: transactionDataXdr(),
        minResourceFee: '100',
        latestLedger: LATEST_LEDGER,
        events: [],
        results: [{ auth: [], xdr: xdr.ScVal.scvVoid().toXDR('base64') }],
      })

    case 'sendTransaction':
      lastSubmittedEnvelope = params?.transaction ?? null
      return rpcResult(id, {
        status: 'PENDING',
        hash: FAKE_TX_HASH,
        latestLedger: LATEST_LEDGER,
        latestLedgerCloseTime: '0',
      })

    case 'getTransaction':
      if (!lastSubmittedEnvelope) {
        return rpcResult(id, { status: 'NOT_FOUND', latestLedger: LATEST_LEDGER })
      }
      return rpcResult(id, {
        status: 'SUCCESS',
        latestLedger: LATEST_LEDGER + 1,
        latestLedgerCloseTime: '0',
        oldestLedger: 1,
        oldestLedgerCloseTime: '0',
        applicationOrder: 1,
        ledger: LATEST_LEDGER + 1,
        createdAt: '0',
        envelopeXdr: lastSubmittedEnvelope,
        resultXdr: successResultXdr(),
        resultMetaXdr: successMetaXdr(),
      })

    case 'getEvents':
      return rpcResult(id, { events: [], latestLedger: LATEST_LEDGER })

    default:
      return rpcResult(id, {})
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function stubNetworkCalls(page: Page) {
  lastSubmittedEnvelope = null

  await page.route(
    (url) => url.hostname === FRIENDBOT_HOST,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ result: 'funded', hash: FAKE_TX_HASH }),
      }),
  )

  await page.route(
    (url) => url.hostname === HORIZON_HOST,
    (route) => {
      const url = new URL(route.request().url())

      // Classic payments to a `G...` recipient are submitted here, not over
      // Soroban RPC.
      if (url.pathname === '/transactions' && route.request().method() === 'POST') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            successful: true,
            hash: FAKE_TX_HASH,
            ledger: LATEST_LEDGER,
            result_xdr: successResultXdr(),
            result_meta_xdr: successMetaXdr(),
          }),
        })
      }

      const pubkey = url.pathname.startsWith('/accounts/')
        ? decodeURIComponent(url.pathname.slice('/accounts/'.length).split('/')[0])
        : null

      if (pubkey) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(fundedAccount(pubkey)),
        })
      }

      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ _embedded: { records: [] } }),
      })
    },
  )

  await page.route(
    (url) => url.hostname === SOROBAN_HOST,
    (route) => {
      const body = route.request().postDataJSON() as
        | { method?: string; params?: any; id?: unknown }
        | null
      return route.fulfill(handleRpc(body?.method, body?.params, body?.id))
    },
  )
}
