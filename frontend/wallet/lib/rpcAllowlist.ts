/**
 * The JSON-RPC methods the mainnet proxy will forward, and the check that
 * enforces it.
 *
 * In its own module because a Next.js route file may only export the handlers
 * and route config — exporting these from route.ts makes `next build` fail type
 * checking against its generated route types, which is how it reached main.
 * Tests import from here.
 */
export const ALLOWED_METHODS = new Set([
  'getHealth',
  'getNetwork',
  'getVersionInfo',
  'getLatestLedger',
  'getFeeStats',
  'getLedgerEntries',
  'getEvents',
  'getTransaction',
  'getTransactions',
  'simulateTransaction',
  'sendTransaction',
])

/**
 * Every JSON-RPC method SPP calls over the wallet RPC (init, sync, bootnode
 * probe fallback, transact). Kept as a named list so tests pin the proxy's
 * SPP coverage; each entry is already in ALLOWED_METHODS.
 */
export const SPP_REQUIRED_METHODS = [
  'getLatestLedger',
  'getEvents',
  'getLedgerEntries',
  'simulateTransaction',
  'sendTransaction',
  'getTransaction',
] as const

type JsonRpcCall = { method?: unknown; id?: unknown }

export function disallowedMethod(payload: unknown): string | null {
  const calls: JsonRpcCall[] = Array.isArray(payload) ? payload : [payload as JsonRpcCall]
  for (const call of calls) {
    const method = typeof call?.method === 'string' ? call.method : ''
    if (!ALLOWED_METHODS.has(method)) return method || '(missing)'
  }
  return null
}
